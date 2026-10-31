package achievements

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/gomo6/backend/internal/gamification"
)

// Claim errors: the handler maps them onto HTTP statuses.
var (
	ErrQuestUnknown      = errors.New("achievements: unknown quest")
	ErrQuestLevelUnknown = errors.New("achievements: unknown quest level")
	ErrQuestNotCompleted = errors.New("achievements: quest level not completed")
	ErrQuestNoReward     = errors.New("achievements: quest level has no reward")
	ErrQuestClaimed      = errors.New("achievements: quest level already claimed")
	ErrChestUnknown      = errors.New("achievements: unknown chest")
	ErrChestOpened       = errors.New("achievements: chest already opened")
)

// GrantedReward is a reward the claim actually credited, with the chest row
// id attached for chest rewards (the frontend uses it to offer "open").
type GrantedReward struct {
	Reward
	ChestID string `json:"chest_id,omitempty"`
}

// ClaimLevel grants the rewards of one completed quest level. It is safe to
// retry: the quest_claims insert is the idempotency guard
// (ON CONFLICT DO NOTHING), so a double claim or a retried request after a
// crash can never grant twice. Claiming an already-claimed level returns
// ErrQuestClaimed with no side effects.
func (e *Engine) ClaimLevel(ctx context.Context, userID, groupKey string, level int) ([]GrantedReward, error) {
	if e.db == nil {
		return nil, fmt.Errorf("achievements: ClaimLevel: nil db")
	}
	g, ok := e.catalog.Get(groupKey)
	if !ok || g.IsAward() {
		return nil, ErrQuestUnknown
	}
	var rewards []Reward
	for _, lvl := range g.Levels {
		if lvl.Level == level {
			rewards = lvl.Rewards
		}
	}
	if rewards == nil {
		return nil, ErrQuestLevelUnknown
	}
	if len(rewards) == 0 {
		return nil, ErrQuestNoReward
	}

	tx, err := e.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("achievements: claim begin: %w", err)
	}
	defer tx.Rollback()

	var current int
	err = tx.QueryRowContext(ctx,
		"SELECT COALESCE(current_level, 0) FROM user_achievements WHERE user_id = $1 AND achievement_id = $2",
		userID, GroupID(groupKey)).Scan(&current)
	if err != nil || current < level {
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return nil, fmt.Errorf("achievements: claim level read: %w", err)
		}
		return nil, ErrQuestNotCompleted
	}

	blob, err := marshalRewards(rewards)
	if err != nil {
		return nil, err
	}
	var inserted bool
	err = tx.QueryRowContext(ctx, `
INSERT INTO quest_claims (user_id, achievement_id, level, rewards)
VALUES ($1, $2, $3, $4::jsonb)
ON CONFLICT (user_id, achievement_id, level) DO NOTHING
RETURNING TRUE`, userID, GroupID(groupKey), level, blob).Scan(&inserted)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrQuestClaimed
		}
		return nil, fmt.Errorf("achievements: claim ledger: %w", err)
	}

	granted := make([]GrantedReward, 0, len(rewards))
	achievementID := GroupID(groupKey)
	for _, r := range rewards {
		gr, err := grantReward(ctx, tx, userID, achievementID, level, r, "quest")
		if err != nil {
			return nil, err
		}
		granted = append(granted, gr)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("achievements: claim commit: %w", err)
	}
	return granted, nil
}

// grantReward credits one reward inside the claim transaction. ref tags the
// ledger row: 'quest' for fresh claims, 'quest_recalc' for rework top-ups, so
// the wallet history distinguishes "добрал после реворка" from new rewards.
func grantReward(ctx context.Context, tx *sql.Tx, userID, achievementID string, level int, r Reward, ref string) (GrantedReward, error) {
	gr := GrantedReward{Reward: r}
	noun := "Quest reward"
	if ref == "quest_recalc" {
		noun = "Quest recalc"
	}
	switch r.Kind {
	case RewardGems:
		var balance int
		if err := tx.QueryRowContext(ctx,
			"UPDATE users SET gems = COALESCE(gems, 0) + $1 WHERE id = $2 RETURNING COALESCE(gems, 0)",
			r.Amount, userID).Scan(&balance); err != nil {
			return gr, fmt.Errorf("achievements: grant gems: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `
INSERT INTO drops_transactions (user_id, type, amount, balance_after, reference_type, description)
VALUES ($1, 'quest_reward_gems', $2, $3, $4, $5)`,
			userID, r.Amount, balance, ref, fmt.Sprintf("%s: +%d gems", noun, r.Amount)); err != nil {
			return gr, fmt.Errorf("achievements: grant gems ledger: %w", err)
		}
	case RewardDrops:
		var balance int
		if err := tx.QueryRowContext(ctx,
			"UPDATE users SET drops = COALESCE(drops, 0) + $1 WHERE id = $2 RETURNING COALESCE(drops, 0)",
			r.Amount, userID).Scan(&balance); err != nil {
			return gr, fmt.Errorf("achievements: grant drops: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `
INSERT INTO drops_transactions (user_id, type, amount, balance_after, reference_type, description)
VALUES ($1, 'quest_reward', $2, $3, $4, $5)`,
			userID, r.Amount, balance, ref, fmt.Sprintf("%s: +%d drops", noun, r.Amount)); err != nil {
			return gr, fmt.Errorf("achievements: grant drops ledger: %w", err)
		}
	case RewardChest:
		mechanic := r.Mechanic
		if mechanic == "" {
			mechanic = gamification.RarityChestKey
		}
		if _, ok := gamification.Lookup(mechanic); !ok {
			return gr, fmt.Errorf("achievements: unknown chest mechanic %q", mechanic)
		}
		if err := tx.QueryRowContext(ctx, `
INSERT INTO quest_chests (user_id, achievement_id, level, mechanic)
VALUES ($1, $2, $3, $4) RETURNING id::text`,
			userID, achievementID, level, mechanic).Scan(&gr.ChestID); err != nil {
			return gr, fmt.Errorf("achievements: grant chest: %w", err)
		}
	default:
		return gr, fmt.Errorf("achievements: unknown reward kind %q", r.Kind)
	}
	return gr, nil
}

// ChestTap is the outcome of one server-driven tap: the dev-panel mechanics
// (attempt budget per rarity, upgrade-or-lose-it), but every roll happens in
// Postgres + crypto/rand, so the client can never fast-forward or re-roll.
// The session persists between taps — closing the modal mid-chest and
// reopening continues where the user left off.
type ChestTap struct {
	Type          string                `json:"type"` // upgraded | failed | opened
	Rarity        string                `json:"rarity"`
	AttemptsLeft  int                   `json:"attempts_left"`
	AttemptsTotal int                   `json:"attempts_total"`
	FinalRarity   string                `json:"final_rarity,omitempty"`
	Drops         int                   `json:"drops,omitempty"`
	Detail        []gamification.Reward `json:"rewards,omitempty"`
}

// TapChest advances one of the user's quest chests by a single tap. A tap on
// an already-opened chest is ErrChestOpened; unknown id is ErrChestUnknown.
func (e *Engine) TapChest(ctx context.Context, userID, chestID string) (*ChestTap, error) {
	return e.tapChest(ctx, "quest_chests", "quest_reward", "quest", "Quest chest", userID, chestID, cryptoSource{})
}

// TapDailyChest advances one of the user's daily chests by a single tap.
func (e *Engine) TapDailyChest(ctx context.Context, userID, chestID string) (*ChestTap, error) {
	return e.tapChest(ctx, "daily_chests", "daily_reward", "daily", "Daily chest", userID, chestID, cryptoSource{})
}

// tapChest runs one tap inside a row-locked transaction. table/ledger/ref/desc
// vary between the quest and daily vaults; the mechanic is identical.
func (e *Engine) tapChest(ctx context.Context, table, ledgerType, ref, desc, userID, chestID string, src gamification.Source) (*ChestTap, error) {
	if e.db == nil {
		return nil, fmt.Errorf("achievements: tapChest: nil db")
	}
	tx, err := e.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("achievements: tap begin: %w", err)
	}
	defer tx.Rollback()

	var mechanic string
	var sessionRaw sql.NullString
	var opened bool
	err = tx.QueryRowContext(ctx, fmt.Sprintf(`
SELECT mechanic, session::text, opened_at IS NOT NULL FROM %s
WHERE id = $1::uuid AND user_id = $2 FOR UPDATE`, table),
		chestID, userID).Scan(&mechanic, &sessionRaw, &opened)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrChestUnknown
		}
		return nil, fmt.Errorf("achievements: tap chest read: %w", err)
	}
	if opened {
		return nil, ErrChestOpened
	}

	m, ok := gamification.Lookup(mechanic)
	if !ok {
		return nil, fmt.Errorf("achievements: unknown chest mechanic %q", mechanic)
	}
	attemptsTotal := chestAttemptsTotal(m)

	var st gamification.State
	if sessionRaw.Valid && sessionRaw.String != "" {
		if err := json.Unmarshal([]byte(sessionRaw.String), &st); err != nil {
			return nil, fmt.Errorf("achievements: tap chest session decode: %w", err)
		}
	} else {
		if st, err = gamification.Start(mechanic); err != nil {
			return nil, fmt.Errorf("achievements: tap chest start: %w", err)
		}
	}
	st, ev, err := gamification.Tap(st, src)
	if err != nil {
		return nil, fmt.Errorf("achievements: tap chest step: %w", err)
	}

	out := &ChestTap{
		Type: string(ev.Type), Rarity: string(ev.Rarity),
		AttemptsLeft: ev.AttemptsLeft, AttemptsTotal: attemptsTotal,
	}
	if !st.IsOpened() {
		blob, err := json.Marshal(st)
		if err != nil {
			return nil, fmt.Errorf("achievements: tap chest session encode: %w", err)
		}
		if _, err := tx.ExecContext(ctx,
			fmt.Sprintf("UPDATE %s SET session = $1::jsonb WHERE id = $2::uuid", table),
			string(blob), chestID); err != nil {
			return nil, fmt.Errorf("achievements: tap chest session store: %w", err)
		}
		if err := tx.Commit(); err != nil {
			return nil, fmt.Errorf("achievements: tap commit: %w", err)
		}
		return out, nil
	}

	// The tap opened the chest: roll the payout, credit it, stamp the row.
	out.FinalRarity = string(st.FinalRarity)
	detail := gamification.RollRewards(m, st.FinalRarity, src)
	drops := 0
	for _, r := range detail {
		drops += r.Amount
	}
	out.Drops = drops
	out.Detail = detail
	var balance int
	if err := tx.QueryRowContext(ctx,
		"UPDATE users SET drops = COALESCE(drops, 0) + $1 WHERE id = $2 RETURNING COALESCE(drops, 0)",
		drops, userID).Scan(&balance); err != nil {
		return nil, fmt.Errorf("achievements: tap chest credit: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO drops_transactions (user_id, type, amount, balance_after, reference_type, description)
VALUES ($1, $2, $3, $4, $5)`,
		userID, ledgerType, drops, balance, ref, fmt.Sprintf("%s: +%d drops", desc, drops)); err != nil {
		return nil, fmt.Errorf("achievements: tap chest credit ledger: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		fmt.Sprintf("UPDATE %s SET opened_at = NOW(), reward_drops = $1, session = NULL WHERE id = $2::uuid", table),
		drops, chestID); err != nil {
		return nil, fmt.Errorf("achievements: tap chest close: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("achievements: tap commit: %w", err)
	}
	return out, nil
}

// chestAttemptsTotal is the per-tier tap budget for the dots UI. Only the
// rarity chest exists today; unknown mechanics fall back to its default.
func chestAttemptsTotal(m gamification.Mechanic) int {
	if d, ok := m.(gamification.Describable); ok {
		if cfg, ok := d.Describe().(gamification.RarityChestConfig); ok && cfg.AttemptsPerTier > 0 {
			return cfg.AttemptsPerTier
		}
	}
	return gamification.DefaultRarityChestConfig().AttemptsPerTier
}

// cryptoSource is a gamification.Source backed by crypto/rand.
type cryptoSource struct{}

func (cryptoSource) Float64() float64 {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return 0
	}
	// 53 random bits → [0,1).
	return float64(binary.BigEndian.Uint64(b[:])>>11) / (1 << 53)
}

// marshalRewards encodes the granted rewards for the claim ledger row.
func marshalRewards(rewards []Reward) (string, error) {
	b, err := json.Marshal(rewards)
	if err != nil {
		return "", fmt.Errorf("achievements: marshal rewards: %w", err)
	}
	return string(b), nil
}
