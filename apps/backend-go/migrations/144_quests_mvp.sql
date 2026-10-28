-- 144_quests_mvp.sql
-- Quest/MVP rework of the achievements system ("геймификация, первые шаги").
-- See discussion: the prestige system (rare-only milestones, hand-granted
-- awards, owner_share percentages) is dropped entirely in favour of a visible
-- quest ladder with progress bars and claimable rewards (gems, drops, chests).
--
--   * Fresh start: wipe all old achievement/award rows (the Go sync re-seeds
--     the new catalog on boot; the startup backfill rebuilds user progress).
--   * users.gems — soft earnable currency, credited by quest claims and chest
--     opens. No conversion to drops in this MVP.
--   * quest_claims — idempotent ledger of claimed (user, quest, level) rewards.
--     Engine progress may move, but a claimed reward is never granted twice.
--   * quest_chests — minimal chest inventory: a claim grants a row, opening it
--     plays a full gamification session server-side and credits the gems.

-- 1. Fresh start (catalog is re-seeded by the Go sync on boot).
DELETE FROM user_awards;
DELETE FROM user_achievements;
DELETE FROM user_achievement_counters;
DELETE FROM achievements;

-- 2. Soft currency balance on the user row (drops stays the paid currency).
ALTER TABLE users ADD COLUMN IF NOT EXISTS gems INTEGER NOT NULL DEFAULT 0;

-- 3. Claim ledger: one row per granted (user, quest, level).
CREATE TABLE IF NOT EXISTS quest_claims (
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    achievement_id UUID NOT NULL REFERENCES achievements(id) ON DELETE CASCADE,
    level        INTEGER NOT NULL,
    rewards      JSONB NOT NULL DEFAULT '[]'::jsonb,
    claimed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, achievement_id, level)
);

CREATE INDEX IF NOT EXISTS idx_quest_claims_user ON quest_claims(user_id);

-- 4. Chest inventory granted by quest claims (opening is a later call).
CREATE TABLE IF NOT EXISTS quest_chests (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    achievement_id UUID NOT NULL REFERENCES achievements(id) ON DELETE CASCADE,
    level          INTEGER NOT NULL DEFAULT 1,
    mechanic       TEXT NOT NULL DEFAULT 'rarity_chest',
    reward_gems    INTEGER,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    opened_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_quest_chests_user ON quest_chests(user_id) WHERE opened_at IS NULL;
