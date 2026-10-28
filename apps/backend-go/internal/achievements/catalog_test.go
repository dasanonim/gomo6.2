package achievements

import (
	"strings"
	"testing"
)

func TestDefaultCatalog_Valid(t *testing.T) {
	cat, err := Default()
	if err != nil {
		t.Fatalf("Default() error: %v", err)
	}
	if cat.Len() != 17 {
		t.Errorf("expected 17 groups, got %d", cat.Len())
	}

	var onboarding, main int
	seen := map[string]struct{}{}
	for _, g := range cat.Groups() {
		if _, dup := seen[g.Key]; dup {
			t.Errorf("duplicate group key %q", g.Key)
		}
		seen[g.Key] = struct{}{}
		if !g.IsCode() {
			t.Errorf("group %s: catalog entries must be origin=code", g.Key)
		}
		if g.IsAward() {
			t.Errorf("group %s: MVP catalog must not contain awards", g.Key)
		}
		if g.IsOnboarding() {
			onboarding++
		} else {
			main++
		}
		for _, lvl := range g.Levels {
			if !lvl.HasClaimable() {
				t.Errorf("group %s level %d: MVP levels must carry rewards", g.Key, lvl.Level)
			}
		}
	}
	if onboarding != 10 {
		t.Errorf("expected 10 onboarding groups (9 steps + meta), got %d", onboarding)
	}
	if main != 7 {
		t.Errorf("expected 7 main-ladder groups, got %d", main)
	}
}

func TestDefaultCatalog_MetaQuest(t *testing.T) {
	cat, _ := Default()
	g, ok := cat.Get("qs_complete")
	if !ok {
		t.Fatal("qs_complete group missing")
	}
	if g.Stat != StatDerived {
		t.Errorf("qs_complete must be derived, got stat=%q", g.Stat)
	}
	if len(g.Levels) != 1 || g.Levels[0].Threshold != 9 {
		t.Errorf("qs_complete must have one level with threshold 9, got %+v", g.Levels)
	}
}

func TestLevelFor(t *testing.T) {
	g := &Group{Levels: []Level{
		{Level: 1, Threshold: 1},
		{Level: 2, Threshold: 50},
		{Level: 3, Threshold: 500},
	}}
	cases := []struct {
		value int
		want  int
	}{
		{0, 0}, {1, 1}, {49, 1}, {50, 2}, {499, 2}, {500, 3}, {100000, 3},
	}
	for _, c := range cases {
		if got := g.LevelFor(c.value); got != c.want {
			t.Errorf("LevelFor(%d) = %d, want %d", c.value, got, c.want)
		}
	}
}

func TestRewardKinds(t *testing.T) {
	if err := (Reward{Kind: RewardGems, Amount: 10}).Validate("x", 1); err != nil {
		t.Errorf("valid gems reward rejected: %v", err)
	}
	if err := (Reward{Kind: RewardDrops, Amount: 5}).Validate("x", 1); err != nil {
		t.Errorf("valid drops reward rejected: %v", err)
	}
	if err := (Reward{Kind: RewardChest}).Validate("x", 1); err != nil {
		t.Errorf("valid chest reward rejected: %v", err)
	}
	if err := (Reward{Kind: RewardGems, Amount: 0}).Validate("x", 1); err == nil {
		t.Error("zero gems amount must be rejected")
	}
	if err := (Reward{Kind: "cosmetic"}).Validate("x", 1); err == nil {
		t.Error("unknown reward kind must be rejected")
	}
}

func TestValidate_BadReward(t *testing.T) {
	g := validMilestone("x")
	g.Levels[0].Rewards = []Reward{{Kind: "cosmetic"}}
	expectError(t, g, "unknown reward kind")
}

func validMilestone(key string) *Group {
	return &Group{
		Key: key, TitleKey: "achievements." + key + ".title", Category: CategoryContent,
		Icon: "star", Kind: KindMilestone, Type: TypeProgressive, Stat: StatCounter, SortOrder: 1,
		Levels: []Level{
			{Level: 1, Threshold: 1, NameKey: "k1", DescriptionKey: "d1"},
			{Level: 2, Threshold: 10, NameKey: "k2", DescriptionKey: "d2"},
		},
	}
}

func validAward(key string) *Group {
	return &Group{
		Key: key, TitleKey: "achievements." + key + ".title",
		DescriptionKey: "achievements." + key + ".description",
		Category:       CategoryContent, Icon: "gem", Kind: KindAward, SortOrder: 1,
	}
}

func expectError(t *testing.T, g *Group, substr string) {
	t.Helper()
	if err := g.Validate(); err == nil {
		t.Fatalf("expected error containing %q, got nil", substr)
	} else if !strings.Contains(err.Error(), substr) {
		t.Fatalf("expected error containing %q, got %q", substr, err)
	}
}

func TestValidate_DuplicateKeys(t *testing.T) {
	a := validMilestone("x")
	b := validMilestone("x")
	if _, err := NewCatalog([]*Group{a, b}); err == nil {
		t.Fatal("expected duplicate key error")
	} else if !strings.Contains(err.Error(), "duplicate group key") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestValidate_EmptyLevels(t *testing.T) {
	g := validMilestone("x")
	g.Levels = nil
	expectError(t, g, "no levels")
}

func TestValidate_NonContiguousLevels(t *testing.T) {
	g := validMilestone("x")
	g.Levels[1].Level = 3 // 1, 3 instead of 1, 2
	expectError(t, g, "must be 1..N")
}

func TestValidate_NonIncreasingThresholds(t *testing.T) {
	g := validMilestone("x")
	g.Levels[1].Threshold = 1 // not > 1
	expectError(t, g, "strictly increasing")
}

func TestValidate_ZeroThreshold(t *testing.T) {
	g := validMilestone("x")
	g.Levels[0].Threshold = 0
	expectError(t, g, "threshold must be positive")
}

func TestValidate_OneTimeMultiLevel(t *testing.T) {
	g := validMilestone("x")
	g.Type = TypeOneTime
	expectError(t, g, "one_time must have exactly one level")
}

func TestValidate_ProgressiveSingleLevel(t *testing.T) {
	g := validMilestone("x")
	g.Levels = []Level{{Level: 1, Threshold: 1, NameKey: "k", DescriptionKey: "d"}}
	expectError(t, g, "progressive must have at least two levels")
}

func TestValidate_EmptyNameKey(t *testing.T) {
	g := validMilestone("x")
	g.Levels[0].NameKey = ""
	expectError(t, g, "name/description keys are empty")
}

func TestValidate_BadCategory(t *testing.T) {
	g := validMilestone("x")
	g.Category = "nowhere"
	expectError(t, g, "invalid category")
}

func TestValidate_EmptyIcon(t *testing.T) {
	g := validMilestone("x")
	g.Icon = ""
	expectError(t, g, "icon is empty")
}

func TestValidate_BadStat(t *testing.T) {
	g := validMilestone("x")
	g.Stat = "magic"
	expectError(t, g, "invalid stat kind")
}

func TestValidate_BadTrack(t *testing.T) {
	g := validMilestone("x")
	g.Track = "secret"
	expectError(t, g, "invalid track")
}

func TestValidate_AwardWithLevels(t *testing.T) {
	g := validAward("x")
	g.Levels = []Level{{Level: 1, Threshold: 1, NameKey: "k", DescriptionKey: "d"}}
	expectError(t, g, "award must not have levels")
}

func TestValidate_AwardWithoutDescription(t *testing.T) {
	g := validAward("x")
	g.DescriptionKey = ""
	expectError(t, g, "award description key is empty")
}

func TestValidate_ValidAward(t *testing.T) {
	if err := validAward("x").Validate(); err != nil {
		t.Fatalf("valid award rejected: %v", err)
	}
}

func TestHash_Stable(t *testing.T) {
	a := validMilestone("x")
	b := validMilestone("x")
	ha, err := a.Hash()
	if err != nil {
		t.Fatal(err)
	}
	hb, err := b.Hash()
	if err != nil {
		t.Fatal(err)
	}
	if ha != hb {
		t.Errorf("hash not stable: %s != %s", ha, hb)
	}

	diff := validMilestone("y")
	hd, _ := diff.Hash()
	if hd == ha {
		t.Errorf("different groups hash equal")
	}

	changed := validMilestone("x")
	changed.Levels[0].Threshold = 99
	hc, _ := changed.Hash()
	if hc == ha {
		t.Errorf("definition change did not change hash")
	}
}
