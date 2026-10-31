package achievements

import (
	"context"
	"database/sql"

	"github.com/lib/pq"
)

// sourceCount recomputes a counter quest's value from live data. The unified
// content model:
//
//	Записи         = threads + profile_wall_posts (by author_id — a post on
//	                 someone else's wall counts for the AUTHOR)
//	Комментарии    = posts (in threads) + profile_wall_post_comments
//	Лайки отдано   = all four like tables by the actor
//	Лайки получено = all four like tables by content owner
//	Сабы           = gomosub_memberships / boards by owner_id
//	Подписки       = subscriptions by subscriber_id
//	Профиль        = avatar_url / bio(+bio_json) / profile_customization row
func (e *Engine) sourceCount(ctx context.Context, userID, key string) (int, error) {
	if e.db == nil {
		return 0, sql.ErrConnDone
	}
	q, ok := sourceCountQueries[key]
	if !ok {
		return 0, nil
	}
	var value int
	err := e.db.QueryRowContext(ctx, q, userID).Scan(&value)
	if err != nil {
		return 0, err
	}
	return value, nil
}

var sourceCountQueries = map[string]string{
	// ── First steps ──
	"qs_avatar":       `SELECT CASE WHEN COALESCE(avatar_url, '') <> '' THEN 1 ELSE 0 END FROM users WHERE id = $1`,
	"qs_bio":          `SELECT CASE WHEN COALESCE(bio, '') <> '' OR COALESCE(bio_json::text, '') NOT IN ('', 'null') THEN 1 ELSE 0 END FROM users WHERE id = $1`,
	"qs_first_thread": `SELECT COUNT(*)::int FROM threads t WHERE t.user_id = $1`,
	"qs_first_wall":   `SELECT COUNT(*)::int FROM profile_wall_posts w WHERE w.author_id = $1`,
	"qs_first_comment": `SELECT (
  (SELECT COUNT(*)::int FROM posts p WHERE p.user_id = $1)
  + (SELECT COUNT(*)::int FROM profile_wall_post_comments wc WHERE wc.user_id = $1)
)`,
	"qs_like_given": `SELECT (
  (SELECT COUNT(*)::int FROM post_likes pl WHERE pl.user_id = $1)
  + (SELECT COUNT(*)::int FROM thread_likes tl WHERE tl.user_id = $1)
  + (SELECT COUNT(*)::int FROM profile_wall_post_likes wl WHERE wl.user_id = $1)
  + (SELECT COUNT(*)::int FROM profile_wall_comment_likes cl WHERE cl.user_id = $1)
)`,
	"qs_sub_join": `SELECT COUNT(*)::int FROM gomosub_memberships gm WHERE gm.user_id = $1`,
	"qs_follow":   `SELECT COUNT(*)::int FROM subscriptions s WHERE s.subscriber_id = $1`,
	"qs_style":    `SELECT COUNT(*)::int FROM profile_customization pc WHERE pc.user_id = $1::uuid`,

	// ── Main ladder ──
	"entries": `SELECT (
  (SELECT COUNT(*)::int FROM threads t WHERE t.user_id = $1)
  + (SELECT COUNT(*)::int FROM profile_wall_posts w WHERE w.author_id = $1)
)`,
	"comments": `SELECT (
  (SELECT COUNT(*)::int FROM posts p WHERE p.user_id = $1)
  + (SELECT COUNT(*)::int FROM profile_wall_post_comments wc WHERE wc.user_id = $1)
)`,
	"likes_given": `SELECT (
  (SELECT COUNT(*)::int FROM post_likes pl WHERE pl.user_id = $1)
  + (SELECT COUNT(*)::int FROM thread_likes tl WHERE tl.user_id = $1)
  + (SELECT COUNT(*)::int FROM profile_wall_post_likes wl WHERE wl.user_id = $1)
  + (SELECT COUNT(*)::int FROM profile_wall_comment_likes cl WHERE cl.user_id = $1)
)`,
	"likes_received": `SELECT (
  (SELECT COUNT(*)::int FROM post_likes pl JOIN posts po ON po.id = pl.post_id WHERE po.user_id = $1)
  + (SELECT COUNT(*)::int FROM thread_likes tl JOIN threads th ON th.id = tl.thread_id WHERE th.user_id = $1)
  + (SELECT COUNT(*)::int FROM profile_wall_post_likes wl JOIN profile_wall_posts wp ON wp.id = wl.post_id WHERE wp.author_id = $1)
  + (SELECT COUNT(*)::int FROM profile_wall_comment_likes cl JOIN profile_wall_post_comments wc ON wc.id = cl.comment_id WHERE wc.user_id = $1)
)`,
	"subs_joined": `SELECT COUNT(*)::int FROM gomosub_memberships gm WHERE gm.user_id = $1`,
	"sub_created": `SELECT COUNT(*)::int FROM boards b WHERE b.owner_id = $1::uuid AND COALESCE(b.is_gomosub, FALSE)`,
	"follows":     `SELECT COUNT(*)::int FROM subscriptions s WHERE s.subscriber_id = $1`,

	// ── Kvestikiref wave: gifts, media, friends, visits, tenure ──
	"gifts_sent":     `SELECT COUNT(*)::int FROM user_gifts WHERE sender_id = $1`,
	"gifts_received": `SELECT COUNT(*)::int FROM user_gifts WHERE recipient_id = $1`,
	"media_uploads": `SELECT (
  (SELECT COUNT(*)::int FROM threads t WHERE t.user_id = $1 AND COALESCE(t.attachments::text, '') NOT IN ('', 'null', '[]'))
  + (SELECT COUNT(*)::int FROM posts p WHERE p.user_id = $1 AND COALESCE(p.attachments::text, '') NOT IN ('', 'null', '[]'))
  + (SELECT COUNT(*)::int FROM profile_wall_posts w WHERE w.author_id = $1 AND (COALESCE(w.image_url, '') <> '' OR COALESCE(w.attachments::text, '') NOT IN ('', 'null', '[]')))
)`,
	"friends_mutual": `SELECT COUNT(*)::int FROM subscriptions s1 WHERE s1.subscriber_id = $1 AND EXISTS (SELECT 1 FROM subscriptions s2 WHERE s2.subscriber_id = s1.target_id AND s2.target_id = $1)`,
	"visits_total":   `SELECT COUNT(*)::int FROM user_daily_visits WHERE user_id = $1`,
	"visit_streak": `SELECT CASE WHEN (SELECT MAX(visit_date) FROM user_daily_visits WHERE user_id = $1) >= CURRENT_DATE - 1 THEN COALESCE((
  SELECT COUNT(*)::int FROM (
    SELECT visit_date, ROW_NUMBER() OVER (ORDER BY visit_date DESC) AS rn
    FROM user_daily_visits WHERE user_id = $1
  ) t
  WHERE t.visit_date = ((SELECT MAX(visit_date) FROM user_daily_visits WHERE user_id = $1) - ((t.rn - 1) || ' days')::interval)::date
), 0) ELSE 0 END`,
	"tenure_days": `SELECT (CURRENT_DATE - created_at::date)::int FROM users WHERE id = $1`,
}

// derivedValue computes a derived quest's value from live data. The only
// derived quest in the MVP is the onboarding meta (qs_complete): the number
// of first-steps quests the user has completed (level >= 1).
func (e *Engine) derivedValue(ctx context.Context, userID, key string) (int, error) {
	if e.db == nil {
		return 0, sql.ErrConnDone
	}
	if key != "qs_complete" {
		return 0, nil
	}
	var value int
	err := e.db.QueryRowContext(ctx, `
SELECT COUNT(*)::int FROM user_achievements ua
JOIN achievements a ON a.id = ua.achievement_id
WHERE ua.user_id = $1 AND ua.current_level >= 1 AND a.group_key = ANY($2)`,
		userID, pq.Array(firstStepsQuests())).Scan(&value)
	if err != nil {
		return 0, err
	}
	return value, nil
}

// firstStepsQuests lists the 9 onboarding quests the meta quest counts.
func firstStepsQuests() []string {
	return []string{
		"qs_avatar", "qs_bio", "qs_first_thread", "qs_first_wall",
		"qs_first_comment", "qs_like_given", "qs_sub_join", "qs_follow", "qs_style",
	}
}
