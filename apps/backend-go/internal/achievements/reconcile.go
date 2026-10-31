package achievements

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
)

// ToppedUpLevel is one quest level that received a recalculation top-up: the
// catalog now grants more than the user already took, so the difference was
// credited. Only positive diffs are ever granted — if rewards shrank, the user
// keeps what they already claimed (no clawback).
type ToppedUpLevel struct {
	GroupKey string          `json:"group_key"`
	Level    int             `json:"level"`
	Granted  []GrantedReward `json:"granted"`
}

// diffRewards computes the top-up for one claimed level: per-kind positive
// differences (drops, gems) plus catalog chests the claim row doesn't have.
// Empty means nothing is owed.
func diffRewards(already, current []Reward) []Reward {
	sum := func(rs []Reward) map[RewardKind]int {
		out := map[RewardKind]int{}
		for _, r := range rs {
			if r.Kind == RewardDrops || r.Kind == RewardGems {
				out[r.Kind] += r.Amount
			}
		}
		return out
	}
	have, want := sum(already), sum(current)
	var diff []Reward
	for _, kind := range []RewardKind{RewardDrops, RewardGems} {
		if d := want[kind] - have[kind]; d > 0 {
			diff = append(diff, Reward{Kind: kind, Amount: d})
		}
	}
	chests := func(rs []Reward) int {
		n := 0
		for _, r := range rs {
			if r.Kind == RewardChest {
				n++
			}
		}
		return n
	}
	for i := 0; i < chests(current)-chests(already); i++ {
		diff = append(diff, currentChestReward(current))
	}
	return diff
}

// currentChestReward returns a chest reward template from the catalog level
// (preserves its mechanic). Callers guarantee at least one chest exists.
func currentChestReward(current []Reward) Reward {
	for _, r := range current {
		if r.Kind == RewardChest {
			return r
		}
	}
	return Reward{Kind: RewardChest, Mechanic: "rarity_chest"}
}

// levelRewards returns the catalog rewards of one level (nil if unknown).
func (e *Engine) levelRewards(groupKey string, level int) []Reward {
	g, ok := e.catalog.Get(groupKey)
	if !ok {
		return nil
	}
	for _, lvl := range g.Levels {
		if lvl.Level == level {
			return lvl.Rewards
		}
	}
	return nil
}

// ReconcileUser tops up every already-claimed level whose catalog rewards grew
// since the claim (rewards rework, threshold reshuffle — anything). It is the
// "забрать недоданное" behind POST /quests/reconcile: safe to run any number
// of times, grants only positive diffs, and rewrites the claim row to the new
// catalog rewards so the next run is a no-op. Levels completed but never
// claimed are left alone — they stay claimable for the full new amount via
// the regular claim flow.
func (e *Engine) ReconcileUser(ctx context.Context, userID string) ([]ToppedUpLevel, error) {
	if e.db == nil {
		return nil, fmt.Errorf("achievements: ReconcileUser: nil db")
	}
	if userID == "" {
		return nil, fmt.Errorf("achievements: ReconcileUser: empty user")
	}
	topped := []ToppedUpLevel{}
	for _, g := range e.catalog.Groups() {
		if g.IsAward() {
			continue
		}
		for _, lvl := range g.Levels {
			diff, err := e.reconcileLevel(ctx, userID, g.Key, lvl.Level, lvl.Rewards)
			if err != nil {
				return topped, err
			}
			if len(diff) > 0 {
				topped = append(topped, ToppedUpLevel{GroupKey: g.Key, Level: lvl.Level, Granted: diff})
			}
		}
	}
	return topped, nil
}

// reconcileLevel tops up one (user, quest, level) when the level is completed
// and was already claimed for less than the catalog now grants. It returns the
// granted top-up (nil when nothing is owed).
func (e *Engine) reconcileLevel(ctx context.Context, userID, groupKey string, level int, current []Reward) ([]GrantedReward, error) {
	if len(current) == 0 {
		return nil, nil
	}
	aid := GroupID(groupKey)
	tx, err := e.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("achievements: reconcile begin: %w", err)
	}
	defer tx.Rollback()

	var progress int
	err = tx.QueryRowContext(ctx,
		"SELECT COALESCE(current_level, 0) FROM user_achievements WHERE user_id = $1 AND achievement_id = $2",
		userID, aid).Scan(&progress)
	if err != nil || progress < level {
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return nil, fmt.Errorf("achievements: reconcile level read: %w", err)
		}
		return nil, nil // not completed (or never unlocked) — nothing to top up
	}

	var blob sql.NullString
	err = tx.QueryRowContext(ctx,
		"SELECT rewards FROM quest_claims WHERE user_id = $1 AND achievement_id = $2 AND level = $3",
		userID, aid, level).Scan(&blob)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil // completed but never claimed — regular claim covers it
		}
		return nil, fmt.Errorf("achievements: reconcile claim read: %w", err)
	}
	var already []Reward
	if blob.Valid {
		_ = json.Unmarshal([]byte(blob.String), &already)
	}

	diff := diffRewards(already, current)
	if len(diff) == 0 {
		return nil, nil
	}

	granted := make([]GrantedReward, 0, len(diff))
	for _, r := range diff {
		gr, err := grantReward(ctx, tx, userID, aid, level, r, "quest_recalc")
		if err != nil {
			return nil, err
		}
		granted = append(granted, gr)
	}
	newBlob, err := marshalRewards(current)
	if err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx,
		"UPDATE quest_claims SET rewards = $1::jsonb, claimed_at = claimed_at WHERE user_id = $2 AND achievement_id = $3 AND level = $4",
		newBlob, userID, aid, level); err != nil {
		return nil, fmt.Errorf("achievements: reconcile ledger update: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("achievements: reconcile commit: %w", err)
	}
	return granted, nil
}

// levelRewards returns the catalog rewards of one level (nil if unknown).
