-- Stories: 24-hour photo / video / text stories for users and GomoSubs.
-- Migration: 138_stories.sql
--
-- Design notes (why this shape):
--   * One table for both owners. `owner_type` distinguishes a personal story
--     (user_id) from a community story (board_id). A CHECK makes the two
--     mutually exclusive, so a story always has exactly one audience root.
--   * `author_id` is the human who posted. For a GomoSub story the story is
--     *from* the community (name + avatar) but the archive and the viewers
--     list still belong to a person, and roles are re-checked on every write.
--   * Expiry is data, not a scheduled job: every read filters
--     `expires_at > NOW()`. The row survives expiry so the author keeps an
--     archive and can "keep in profile" (is_pinned) a story — exactly like
--     Telegram. Nothing is deleted by the passage of time.
--   * Views live in their own table because the ring shows "N segments, K
--     read": the ring must know *which* stories this viewer has seen, not a
--     counter. `views_count` on the story is a denormalized copy kept in the
--     same transaction as the insert so the rail stays a single query.
--   * No RLS: like `channel_messages`, the audience rule spans users,
--     friendships, close-friend lists and board roles, and is enforced in Go
--     by `internal/storyaccess` — the same predicate the REST handlers, the
--     media proxy and the WebSocket room gate share. Duplicating it as a
--     policy would create a second source of truth that can silently drift.

CREATE TABLE IF NOT EXISTS stories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_type VARCHAR(16) NOT NULL,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    board_id UUID REFERENCES boards(id) ON DELETE CASCADE,
    author_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind VARCHAR(16) NOT NULL,
    media_key TEXT,
    preview_key TEXT,
    thumb_hash TEXT,
    media_width INTEGER,
    media_height INTEGER,
    media_duration NUMERIC(6, 2),
    media_content_type TEXT,
    text TEXT NOT NULL DEFAULT '',
    text_style JSONB,
    privacy VARCHAR(20) NOT NULL DEFAULT 'everyone',
    is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
    views_count INTEGER NOT NULL DEFAULT 0,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    CONSTRAINT stories_owner_matches_type CHECK (
        (owner_type = 'user' AND user_id IS NOT NULL AND board_id IS NULL)
        OR (owner_type = 'gosub' AND board_id IS NOT NULL AND user_id IS NULL)
    ),
    CONSTRAINT stories_kind_valid CHECK (kind IN ('photo', 'video', 'text')),
    CONSTRAINT stories_privacy_valid CHECK (
        privacy IN ('everyone', 'friends', 'close_friends', 'only_me')
    ),
    -- A text story has no media; a media story must have one. This keeps
    -- "kind" honest instead of letting clients post an empty slide.
    CONSTRAINT stories_media_present CHECK (
        (kind = 'text' AND media_key IS NULL AND length(btrim(text)) > 0)
        OR (kind IN ('photo', 'video') AND media_key IS NOT NULL)
    )
);

-- Live-story lookups are the hot path: the rail, the avatar ring and the
-- viewer all read "this owner's non-deleted stories, newest first".
CREATE INDEX IF NOT EXISTS idx_stories_user_live
    ON stories (user_id, created_at DESC)
    WHERE owner_type = 'user' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_stories_board_live
    ON stories (board_id, created_at DESC)
    WHERE owner_type = 'gosub' AND deleted_at IS NULL;

-- Archive ("мои истории" after expiry) and profile highlights (is_pinned).
CREATE INDEX IF NOT EXISTS idx_stories_author_archive
    ON stories (author_id, created_at DESC)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_stories_pinned
    ON stories (user_id, is_pinned)
    WHERE is_pinned AND deleted_at IS NULL;

-- The maintenance sweep only needs the deleted rows, which are a tiny slice.
CREATE INDEX IF NOT EXISTS idx_stories_purge
    ON stories (deleted_at)
    WHERE deleted_at IS NOT NULL;

-- One row = "this user has seen this story". The composite primary key makes
-- the view report idempotent, so a re-open / double-tap never inflates the
-- counter. `viewed_at` drives the author's viewers list (newest first).
CREATE TABLE IF NOT EXISTS story_views (
    story_id UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    viewer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    viewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (story_id, viewer_id)
);

CREATE INDEX IF NOT EXISTS idx_story_views_story_time
    ON story_views (story_id, viewed_at DESC);

CREATE INDEX IF NOT EXISTS idx_story_views_viewer
    ON story_views (viewer_id);

-- Reactions: one per viewer per story (Telegram allows exactly one, tapping a
-- different emoji replaces it). Replacing is an UPSERT on the primary key.
CREATE TABLE IF NOT EXISTS story_reactions (
    story_id UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (story_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_story_reactions_story
    ON story_reactions (story_id, created_at DESC);

-- "Избранные" (close friends): a per-owner allow-list for privacy =
-- 'close_friends'. It is intentionally independent of a one-time friendship
-- snapshot: removing a row takes effect immediately for every future read,
-- and adding a row does not require re-posting anything.
CREATE TABLE IF NOT EXISTS story_close_friends (
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    friend_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_id, friend_id),
    CONSTRAINT story_close_friends_no_self CHECK (owner_id <> friend_id)
);

CREATE INDEX IF NOT EXISTS idx_story_close_friends_friend
    ON story_close_friends (friend_id);

-- updated_at maintenance reuses the schema-wide helper (privacy edits and
-- pin/unpin are the only updates, but the column must never lie).
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_stories_updated_at ON stories;
CREATE TRIGGER update_stories_updated_at
    BEFORE UPDATE ON stories
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON COLUMN stories.privacy IS
    'everyone | friends (mutual) | close_friends (story_close_friends list) | only_me. Ignored for owner_type=gosub: the board rules decide.';
COMMENT ON COLUMN stories.is_pinned IS
    'Keep in profile: a pinned story stays in the profile highlights after expiry but never in the live ring.';
COMMENT ON COLUMN stories.views_count IS
    'Denormalized count of story_views; updated in the same transaction as the insert.';
