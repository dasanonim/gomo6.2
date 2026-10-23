-- 141_board_counters.sql
--
-- GomoSub directory: denormalized counters.
--
-- GetGomoSubsDirectory counted memberships and channels per board row
-- (2 correlated COUNT(*) per catalog entry, unpaginated). Same write-time
-- pattern as the feed counters (139/140): the counts live ON the boards row,
-- maintained by AFTER triggers, backfilled once here.
--
-- Counter semantics: plain row counts (memberships has no soft-delete flag).

ALTER TABLE boards ADD COLUMN IF NOT EXISTS member_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE boards ADD COLUMN IF NOT EXISTS channel_count INTEGER NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION trg_gomosub_memberships_changed()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE boards SET member_count = member_count + 1 WHERE id = NEW.board_id;
    RETURN NEW;
  ELSE
    UPDATE boards SET member_count = GREATEST(0, member_count - 1) WHERE id = OLD.board_id;
    RETURN OLD;
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS trg_gomosub_memberships_ai ON gomosub_memberships;
DROP TRIGGER IF EXISTS trg_gomosub_memberships_ad ON gomosub_memberships;
CREATE TRIGGER trg_gomosub_memberships_ai AFTER INSERT ON gomosub_memberships
  FOR EACH ROW EXECUTE FUNCTION trg_gomosub_memberships_changed();
CREATE TRIGGER trg_gomosub_memberships_ad AFTER DELETE ON gomosub_memberships
  FOR EACH ROW EXECUTE FUNCTION trg_gomosub_memberships_changed();

CREATE OR REPLACE FUNCTION trg_channels_changed()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE boards SET channel_count = channel_count + 1 WHERE id = NEW.board_id;
    RETURN NEW;
  ELSE
    UPDATE boards SET channel_count = GREATEST(0, channel_count - 1) WHERE id = OLD.board_id;
    RETURN OLD;
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS trg_channels_ai ON channels;
DROP TRIGGER IF EXISTS trg_channels_ad ON channels;
CREATE TRIGGER trg_channels_ai AFTER INSERT ON channels
  FOR EACH ROW EXECUTE FUNCTION trg_channels_changed();
CREATE TRIGGER trg_channels_ad AFTER DELETE ON channels
  FOR EACH ROW EXECUTE FUNCTION trg_channels_changed();

-- Backfill existing rows.
UPDATE boards b SET member_count = COALESCE(m.c, 0)
FROM (SELECT board_id, COUNT(*)::INT AS c FROM gomosub_memberships GROUP BY board_id) m
WHERE m.board_id = b.id;

UPDATE boards b SET channel_count = COALESCE(c.c, 0)
FROM (SELECT board_id, COUNT(*)::INT AS c FROM channels GROUP BY board_id) c
WHERE c.board_id = b.id;
