-- 140_feed_tag_boost.sql
--
-- Feed v3 follow-up: set-based tag boost.
--
-- 139's ranking evaluated tag affinity with a correlated COUNT(*) subquery
-- per candidate row, which re-ran the interest-tag scans for every candidate
-- and dominated authenticated-feed time once the corpus passed a few thousand
-- rows (measured 2.3s at 10k posts in the scaling benchmark). This replaces
-- only the ranking CTE with a single hash-join (thread_tag_hits) over the
-- bounded candidate set. Scoring semantics are unchanged
-- (LEAST(3600, 900 * matching_tag_values)).

DROP FUNCTION IF EXISTS get_user_feed(UUID, INT, TIMESTAMPTZ, DOUBLE PRECISION, UUID);

CREATE FUNCTION get_user_feed(
  user_uuid UUID DEFAULT NULL,
  limit_count INT DEFAULT 20,
  since_ts TIMESTAMPTZ DEFAULT NULL,
  before_sort DOUBLE PRECISION DEFAULT NULL,
  before_id UUID DEFAULT NULL
)
RETURNS TABLE (
  item_type TEXT,
  item_id UUID,
  score DOUBLE PRECISION,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  title TEXT,
  content TEXT,
  content_json JSONB,
  image_url TEXT,
  image_urls JSONB,
  attachments JSONB,
  tags JSONB,
  post_count INTEGER,
  author_id UUID,
  author_username TEXT,
  author_display_name TEXT,
  author_nickname_emoji_id UUID,
  author_is_anonymous BOOLEAN,
  author_avatar_url TEXT,
  board_id UUID,
  board_slug TEXT,
  board_name TEXT,
  board_is_gomosub BOOLEAN,
  section_id UUID,
  section_slug TEXT,
  section_name TEXT,
  section_icon TEXT,
  subsection_id UUID,
  subsection_slug TEXT,
  subsection_name TEXT,
  wall_user_id UUID,
  likes_count BIGINT,
  comments_count BIGINT,
  reposts_count BIGINT,
  liked_by_viewer BOOLEAN,
  views_count BIGINT,
  public_id BIGINT,
  user_public_id BIGINT,
  author_public_id BIGINT
)
LANGUAGE sql
STABLE
AS $$
  WITH
  -- Recent interest tags of the viewer (bounded: last 100 engagements).
  -- Empty for guests ($1 IS NULL short-circuits the scans).
  interest_tags AS (
    SELECT DISTINCT kv.value AS tag
    FROM (
      SELECT t_engaged.tags FROM thread_likes tl_engaged
        JOIN threads t_engaged ON t_engaged.id = tl_engaged.thread_id
        WHERE tl_engaged.user_id = user_uuid AND user_uuid IS NOT NULL
        ORDER BY tl_engaged.created_at DESC LIMIT 100
    ) engaged
    CROSS JOIN LATERAL (
      SELECT kv.key, kv.value
      FROM jsonb_each_text(
        CASE WHEN jsonb_typeof(engaged.tags) = 'object' THEN engaged.tags ELSE '{}'::jsonb END
      ) kv
    ) kv
    WHERE kv.value IS NOT NULL AND kv.value <> ''
  ),
  interest_gsub_tags AS (
    SELECT DISTINCT elem.tag AS tag
    FROM gomosub_memberships gm_tags
    JOIN boards b_tags ON b_tags.id = gm_tags.board_id
    CROSS JOIN LATERAL jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(b_tags.gomosub_tags) = 'array' THEN b_tags.gomosub_tags ELSE '[]'::jsonb END
    ) elem(tag)
    WHERE gm_tags.user_id = user_uuid AND user_uuid IS NOT NULL
  ),
  friend_ids AS (
    SELECT CASE WHEN f.user1_id = user_uuid THEN f.user2_id ELSE f.user1_id END AS fid
    FROM friendships f
    WHERE (f.user1_id = user_uuid OR f.user2_id = user_uuid) AND user_uuid IS NOT NULL
  ),
  liked_author_ids AS (
    SELECT t_auth.user_id AS aid
    FROM thread_likes tl_auth JOIN threads t_auth ON t_auth.id = tl_auth.thread_id
    WHERE tl_auth.user_id = user_uuid AND user_uuid IS NOT NULL AND t_auth.user_id IS NOT NULL
    UNION
    SELECT p_auth.author_id AS aid
    FROM profile_wall_post_likes wl_auth JOIN profile_wall_posts p_auth ON p_auth.id = wl_auth.post_id
    WHERE wl_auth.user_id = user_uuid AND user_uuid IS NOT NULL AND p_auth.author_id IS NOT NULL
  ),
  member_board_ids AS (
    SELECT gm_board.board_id AS bid
    FROM gomosub_memberships gm_board
    WHERE gm_board.user_id = user_uuid AND user_uuid IS NOT NULL
  ),
  shared_gsub_author_ids AS (
    SELECT DISTINCT gm2.user_id AS aid
    FROM gomosub_memberships gm1
    JOIN gomosub_memberships gm2 ON gm2.board_id = gm1.board_id AND gm2.user_id <> user_uuid
    WHERE gm1.user_id = user_uuid AND user_uuid IS NOT NULL
  ),
  -- ── Phase A: bounded candidate pools (narrow columns, index-ordered) ───────
  candidates AS (
    -- Global hot/recent threads.
    (SELECT 'thread'::TEXT AS item_type, t.id AS item_id,
       t.user_id AS author_id, NULL::UUID AS wall_user_id,
       t.created_at, t.base_score
     FROM threads t
     LEFT JOIN boards b ON b.id = t.board_id
     WHERE t.channel_id IS NULL
       AND NOT COALESCE(b.is_rules_board, FALSE)
       AND (t.board_id IS NULL
            OR COALESCE(b.visibility, 'public') <> 'private'
            OR b.owner_id = user_uuid
            OR (user_uuid IS NOT NULL AND EXISTS (SELECT 1 FROM gomosub_memberships gm WHERE gm.board_id = t.board_id AND gm.user_id = user_uuid)))
       AND (since_ts IS NULL OR t.created_at > since_ts)
       AND (before_sort IS NULL OR t.base_score + 14400.0 >= before_sort)
     ORDER BY t.base_score DESC, t.id DESC
     LIMIT 250)
    UNION
    -- Global hot/recent wall posts.
    (SELECT 'wall_post'::TEXT, p.id, p.author_id, p.user_id, p.created_at, p.base_score
     FROM profile_wall_posts p
     LEFT JOIN privacy_settings ps ON ps.user_id = p.user_id
     WHERE (p.user_id = user_uuid
            OR (NOT COALESCE(ps.private_profile, FALSE) AND NOT COALESCE(ps.private_hide_wall, FALSE))
            OR (user_uuid IS NOT NULL AND EXISTS (SELECT 1 FROM friendships f
                       WHERE (f.user1_id = p.user_id AND f.user2_id = user_uuid)
                          OR (f.user1_id = user_uuid AND f.user2_id = p.user_id))))
       AND (since_ts IS NULL OR p.created_at > since_ts)
       AND (before_sort IS NULL OR p.base_score + 14400.0 >= before_sort)
     ORDER BY p.base_score DESC, p.id DESC
     LIMIT 250)
    UNION
    -- Personal pool: threads by friends / liked authors / joined boards.
    (SELECT 'thread'::TEXT, t.id, t.user_id, NULL::UUID, t.created_at, t.base_score
     FROM threads t
     LEFT JOIN boards b ON b.id = t.board_id
     WHERE user_uuid IS NOT NULL
       AND t.channel_id IS NULL
       AND NOT COALESCE(b.is_rules_board, FALSE)
       AND ((t.user_id IS NOT NULL AND EXISTS (SELECT 1 FROM friend_ids f WHERE f.fid = t.user_id))
            OR (t.user_id IS NOT NULL AND EXISTS (SELECT 1 FROM liked_author_ids la WHERE la.aid = t.user_id))
            OR EXISTS (SELECT 1 FROM member_board_ids mb WHERE mb.bid = t.board_id))
       AND (t.board_id IS NULL
            OR COALESCE(b.visibility, 'public') <> 'private'
            OR b.owner_id = user_uuid
            OR EXISTS (SELECT 1 FROM gomosub_memberships gm WHERE gm.board_id = t.board_id AND gm.user_id = user_uuid))
       AND (since_ts IS NULL OR t.created_at > since_ts)
       AND (before_sort IS NULL OR t.base_score + 14400.0 >= before_sort)
     ORDER BY t.base_score DESC, t.id DESC
     LIMIT 100)
    UNION
    -- Personal pool: wall posts by friends / liked authors.
    (SELECT 'wall_post'::TEXT, p.id, p.author_id, p.user_id, p.created_at, p.base_score
     FROM profile_wall_posts p
     LEFT JOIN privacy_settings ps ON ps.user_id = p.user_id
     WHERE user_uuid IS NOT NULL
       AND ((p.author_id IS NOT NULL AND EXISTS (SELECT 1 FROM friend_ids f WHERE f.fid = p.author_id))
            OR (p.user_id IS NOT NULL AND EXISTS (SELECT 1 FROM friend_ids f WHERE f.fid = p.user_id))
            OR (p.author_id IS NOT NULL AND EXISTS (SELECT 1 FROM liked_author_ids la WHERE la.aid = p.author_id)))
       AND (p.user_id = user_uuid
            OR (NOT COALESCE(ps.private_profile, FALSE) AND NOT COALESCE(ps.private_hide_wall, FALSE))
            OR EXISTS (SELECT 1 FROM friendships f
                       WHERE (f.user1_id = p.user_id AND f.user2_id = user_uuid)
                          OR (f.user1_id = user_uuid AND f.user2_id = p.user_id)))
       AND (since_ts IS NULL OR p.created_at > since_ts)
       AND (before_sort IS NULL OR p.base_score + 14400.0 >= before_sort)
     ORDER BY p.base_score DESC, p.id DESC
     LIMIT 100)
  ),
  -- Set-based tag-hit counts for the bounded candidate set: one hash join
  -- over all candidates instead of a correlated COUNT subquery per row (the
  -- per-row form re-evaluated the interest CTEs for every candidate and
  -- dominated auth-feed time at scale).
  thread_tag_hits AS (
    SELECT c.item_id AS item_id, COUNT(*)::DOUBLE PRECISION AS hits
    FROM candidates c
    JOIN threads t_tag ON t_tag.id = c.item_id
    CROSS JOIN LATERAL jsonb_each_text(
      CASE WHEN jsonb_typeof(t_tag.tags) = 'object' THEN t_tag.tags ELSE '{}'::jsonb END) kv_tags
    WHERE c.item_type = 'thread'
      AND (kv_tags.value IN (SELECT it.tag FROM interest_tags it)
           OR kv_tags.value IN (SELECT ig.tag FROM interest_gsub_tags ig))
    GROUP BY c.item_id
  ),
  -- ── Phase B: personal ranking + diversity on the bounded set ───────────────
  boosted AS (
    SELECT c.item_type, c.item_id, c.author_id, c.wall_user_id, c.created_at, c.base_score,
      (CASE WHEN user_uuid IS NOT NULL AND c.author_id IS NOT NULL
              AND EXISTS (SELECT 1 FROM friend_ids f WHERE f.fid = c.author_id) THEN 7200.0
            WHEN user_uuid IS NOT NULL AND c.wall_user_id IS NOT NULL AND c.item_type = 'wall_post'
              AND EXISTS (SELECT 1 FROM friend_ids f WHERE f.fid = c.wall_user_id) THEN 7200.0
            ELSE 0.0 END
       + CASE WHEN user_uuid IS NOT NULL AND c.author_id IS NOT NULL
              AND EXISTS (SELECT 1 FROM liked_author_ids la WHERE la.aid = c.author_id) THEN 3600.0 ELSE 0.0 END
       + CASE WHEN user_uuid IS NOT NULL AND c.author_id IS NOT NULL
              AND EXISTS (SELECT 1 FROM shared_gsub_author_ids sa WHERE sa.aid = c.author_id) THEN 1800.0 ELSE 0.0 END
       + LEAST(3600.0, COALESCE(th.hits * 900.0, 0.0))) AS personal_boost
    FROM candidates c
    LEFT JOIN thread_tag_hits th ON th.item_id = c.item_id
  ),
  -- NOTE: base_score already contains the engagement part
  -- (epoch(created_at) + engagement), so the final score re-anchors on the
  -- epoch and adds the capped total exactly once:
  --   score = epoch + LEAST(14400, personal + engagement).
  ranked AS (
    SELECT b.*,
      EXTRACT(EPOCH FROM b.created_at) + LEAST(14400.0,
        b.personal_boost + (b.base_score - EXTRACT(EPOCH FROM b.created_at))) AS score,
      ROW_NUMBER() OVER (
        PARTITION BY COALESCE(b.author_id, b.item_id)
        ORDER BY EXTRACT(EPOCH FROM b.created_at) + LEAST(14400.0,
          b.personal_boost + (b.base_score - EXTRACT(EPOCH FROM b.created_at))) DESC
      ) AS author_rn
    FROM boosted b
  ),
  winners AS (
    SELECT r.item_type, r.item_id, r.score
    FROM ranked r
    WHERE r.author_rn <= 5
      AND (before_sort IS NULL
           OR r.score < before_sort
           OR (r.score = before_sort AND r.item_id < before_id))
    ORDER BY r.score DESC, r.item_id DESC
    LIMIT limit_count
  )
  -- ── Phase C: hydrate ONLY the winning page ─────────────────────────────────
  SELECT
    w.item_type, w.item_id, w.score,
    COALESCE(t.created_at, p.created_at) AS created_at,
    COALESCE(t.updated_at, p.updated_at) AS updated_at,
    COALESCE(t.title, p.title) AS title,
    COALESCE(t.content, p.content) AS content,
    COALESCE(t.content_json, p.content_json) AS content_json,
    COALESCE(t.image_url, p.image_url) AS image_url,
    t.image_urls,
    COALESCE(t.attachments, p.attachments) AS attachments,
    t.tags,
    t.post_count,
    COALESCE(t.user_id, p.author_id) AS author_id,
    u.username::TEXT AS author_username,
    u.display_name::TEXT AS author_display_name,
    u.nickname_emoji_id AS author_nickname_emoji_id,
    COALESCE(u.is_anonymous, FALSE) AS author_is_anonymous,
    u.avatar_url AS author_avatar_url,
    t.board_id,
    b.slug::TEXT AS board_slug,
    b.name::TEXT AS board_name,
    COALESCE(b.is_gomosub, FALSE) AS board_is_gomosub,
    t.section_id,
    ts.slug::TEXT AS section_slug,
    ts.name::TEXT AS section_name,
    ts.icon::TEXT AS section_icon,
    t.subsection_id,
    tss.slug::TEXT AS subsection_slug,
    tss.name::TEXT AS subsection_name,
    p.user_id AS wall_user_id,
    COALESCE(t.likes_count, p.likes_count, 0)::BIGINT AS likes_count,
    COALESCE(t.post_count, p.comments_count, 0)::BIGINT AS comments_count,
    COALESCE(p.reposts_count, 0)::BIGINT AS reposts_count,
    CASE WHEN user_uuid IS NULL THEN FALSE
         ELSE EXISTS (
           SELECT 1 FROM thread_likes tl
           WHERE tl.thread_id = w.item_id AND tl.user_id = user_uuid AND w.item_type = 'thread'
           UNION ALL
           SELECT 1 FROM profile_wall_post_likes wl
           WHERE wl.post_id = w.item_id AND wl.user_id = user_uuid AND w.item_type = 'wall_post'
           LIMIT 1)
    END AS liked_by_viewer,
    COALESCE(p.views_count, 0)::BIGINT AS views_count,
    COALESCE(t.public_id, p.public_id) AS public_id,
    ow.public_id AS user_public_id,
    au.public_id AS author_public_id
  FROM winners w
  LEFT JOIN threads t ON t.id = w.item_id AND w.item_type = 'thread'
  LEFT JOIN profile_wall_posts p ON p.id = w.item_id AND w.item_type = 'wall_post'
  LEFT JOIN users u ON u.id = COALESCE(t.user_id, p.author_id)
  LEFT JOIN users au ON au.id = COALESCE(t.user_id, p.author_id)
  LEFT JOIN users ow ON ow.id = p.user_id
  LEFT JOIN boards b ON b.id = t.board_id
  LEFT JOIN thread_sections ts ON ts.id = t.section_id
  LEFT JOIN thread_subsections tss ON tss.id = t.subsection_id
  ORDER BY w.score DESC, w.item_id DESC;
$$;

-- The function takes $1..$5 parameters (user, limit, since, before_sort,
-- before_id). A generic cached plan cannot simplify the NULL checks, so force
-- a custom plan per call: the NULL-ness of the cursors picks index scans.
ALTER FUNCTION get_user_feed(UUID, INT, TIMESTAMPTZ, DOUBLE PRECISION, UUID)
  SET plan_cache_mode = force_custom_plan;

GRANT EXECUTE ON FUNCTION get_user_feed(UUID, INT, TIMESTAMPTZ, DOUBLE PRECISION, UUID) TO gomo6;
