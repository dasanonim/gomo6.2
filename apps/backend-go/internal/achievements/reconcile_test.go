package achievements

import (
	"encoding/json"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

func mustMarshal(t *testing.T, rs []Reward) string {
	t.Helper()
	b, err := json.Marshal(rs)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestDiffRewards(t *testing.T) {
	chest := Reward{Kind: RewardChest, Mechanic: "rarity_chest"}
	cases := []struct {
		name    string
		already []Reward
		current []Reward
		want    []Reward // nil = nothing owed
	}{
		{"no claim yet", nil, []Reward{{Kind: RewardDrops, Amount: 10}}, []Reward{{Kind: RewardDrops, Amount: 10}}},
		{"exact match", []Reward{{Kind: RewardDrops, Amount: 10}}, []Reward{{Kind: RewardDrops, Amount: 10}}, nil},
		{"drops grew", []Reward{{Kind: RewardDrops, Amount: 5}}, []Reward{{Kind: RewardDrops, Amount: 20}}, []Reward{{Kind: RewardDrops, Amount: 15}}},
		{"gems added", []Reward{{Kind: RewardDrops, Amount: 10}}, []Reward{{Kind: RewardDrops, Amount: 10}, {Kind: RewardGems, Amount: 5}}, []Reward{{Kind: RewardGems, Amount: 5}}},
		{"shrunk keeps old", []Reward{{Kind: RewardDrops, Amount: 50}}, []Reward{{Kind: RewardDrops, Amount: 10}}, nil},
		{"chest added", []Reward{{Kind: RewardDrops, Amount: 300}}, []Reward{{Kind: RewardDrops, Amount: 300}, chest}, []Reward{chest}},
		{"chest kept", []Reward{{Kind: RewardDrops, Amount: 300}, chest}, []Reward{{Kind: RewardDrops, Amount: 300}, chest}, nil},
		{"second chest added", []Reward{chest}, []Reward{chest, chest}, []Reward{chest}},
		{"chest removed keeps old", []Reward{{Kind: RewardDrops, Amount: 300}, chest}, []Reward{{Kind: RewardDrops, Amount: 300}}, nil},
	}
	for _, c := range cases {
		got := diffRewards(c.already, c.current)
		if len(got) != len(c.want) {
			t.Errorf("%s: diff len = %d, want %d (%v)", c.name, len(got), len(c.want), got)
			continue
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Errorf("%s: diff[%d] = %+v, want %+v", c.name, i, got[i], c.want[i])
			}
		}
	}
}

func reconcileTestCatalog(t *testing.T) *Catalog {
	t.Helper()
	cat, err := NewCatalog([]*Group{
		{
			Key: "re_a", TitleKey: "t", Category: CategoryContent,
			Icon: "star", Kind: KindMilestone, Type: TypeProgressive, Stat: StatCounter, Track: TrackMain, SortOrder: 1,
			Levels: []Level{
				{Level: 1, Threshold: 1, NameKey: "k", DescriptionKey: "d", Rewards: []Reward{{Kind: RewardDrops, Amount: 10}}},
				{Level: 2, Threshold: 10, NameKey: "k", DescriptionKey: "d",
					Rewards: []Reward{{Kind: RewardDrops, Amount: 50}, {Kind: RewardGems, Amount: 5}, {Kind: RewardChest, Mechanic: "rarity_chest"}}},
			},
		},
		{
			Key: "re_b", TitleKey: "t", Category: CategoryContent,
			Icon: "star", Kind: KindMilestone, Type: TypeOneTime, Stat: StatCounter, Track: TrackMain, SortOrder: 2,
			Levels: []Level{
				{Level: 1, Threshold: 1, NameKey: "k", DescriptionKey: "d", Rewards: []Reward{{Kind: RewardDrops, Amount: 10}}},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return cat
}

func TestReconcileUser_TopUp(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	e := New(db, reconcileTestCatalog(t))

	// re_a level 1: completed, claimed 5 of the current 10 → top up 5.
	mock.ExpectBegin()
	mock.ExpectQuery("SELECT COALESCE\\(current_level").
		WithArgs("u1", GroupID("re_a")).WillReturnRows(sqlmock.NewRows([]string{"current_level"}).AddRow(2))
	mock.ExpectQuery("SELECT rewards FROM quest_claims").
		WithArgs("u1", GroupID("re_a"), 1).
		WillReturnRows(sqlmock.NewRows([]string{"rewards"}).AddRow(mustMarshal(t, []Reward{{Kind: RewardDrops, Amount: 5}})))
	mock.ExpectQuery("UPDATE users SET drops").
		WithArgs(5, "u1").WillReturnRows(sqlmock.NewRows([]string{"drops"}).AddRow(105))
	mock.ExpectExec("INSERT INTO drops_transactions").
		WithArgs("u1", 5, 105, "quest_recalc", "Quest recalc: +5 drops").
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec("UPDATE quest_claims SET rewards").
		WithArgs(sqlmock.AnyArg(), "u1", GroupID("re_a"), 1).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectCommit()

	// re_a level 2: completed, claimed 50 drops (no gems/chest yet) → gems + chest.
	mock.ExpectBegin()
	mock.ExpectQuery("SELECT COALESCE\\(current_level").
		WithArgs("u1", GroupID("re_a")).WillReturnRows(sqlmock.NewRows([]string{"current_level"}).AddRow(2))
	mock.ExpectQuery("SELECT rewards FROM quest_claims").
		WithArgs("u1", GroupID("re_a"), 2).
		WillReturnRows(sqlmock.NewRows([]string{"rewards"}).AddRow(mustMarshal(t, []Reward{{Kind: RewardDrops, Amount: 50}})))
	mock.ExpectQuery("UPDATE users SET gems").
		WithArgs(5, "u1").WillReturnRows(sqlmock.NewRows([]string{"gems"}).AddRow(10))
	mock.ExpectExec("INSERT INTO drops_transactions").
		WithArgs("u1", 5, 10, "quest_recalc", "Quest recalc: +5 gems").
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectQuery("INSERT INTO quest_chests").
		WithArgs("u1", GroupID("re_a"), 2, "rarity_chest").
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow("00000000-0000-0000-0000-000000000001"))
	mock.ExpectExec("UPDATE quest_claims SET rewards").
		WithArgs(sqlmock.AnyArg(), "u1", GroupID("re_a"), 2).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectCommit()

	// re_b: never unlocked → skipped without touching claims.
	mock.ExpectBegin()
	mock.ExpectQuery("SELECT COALESCE\\(current_level").
		WithArgs("u1", GroupID("re_b")).WillReturnRows(sqlmock.NewRows([]string{"current_level"}))
	mock.ExpectRollback()

	topped, err := e.ReconcileUser(t.Context(), "u1")
	if err != nil {
		t.Fatalf("ReconcileUser: %v", err)
	}
	if len(topped) != 2 {
		t.Fatalf("expected 2 topped-up levels, got %d (%v)", len(topped), topped)
	}
	if topped[0].GroupKey != "re_a" || topped[0].Level != 1 || len(topped[0].Granted) != 1 {
		t.Errorf("unexpected first top-up: %+v", topped[0])
	}
	if topped[1].GroupKey != "re_a" || topped[1].Level != 2 || len(topped[1].Granted) != 2 {
		t.Errorf("unexpected second top-up: %+v", topped[1])
	}
	if topped[1].Granted[1].ChestID == "" {
		t.Errorf("chest top-up must report the chest id")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unfulfilled: %v", err)
	}
}

func TestReconcileUser_NothingOwed(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	e := New(db, reconcileTestCatalog(t))

	for _, lvl := range []int{1, 2} {
		mock.ExpectBegin()
		mock.ExpectQuery("SELECT COALESCE\\(current_level").
			WithArgs("u1", GroupID("re_a")).WillReturnRows(sqlmock.NewRows([]string{"current_level"}).AddRow(2))
		current := e.levelRewards("re_a", lvl)
		mock.ExpectQuery("SELECT rewards FROM quest_claims").
			WithArgs("u1", GroupID("re_a"), lvl).
			WillReturnRows(sqlmock.NewRows([]string{"rewards"}).AddRow(mustMarshal(t, current)))
		mock.ExpectRollback()
	}
	mock.ExpectBegin()
	mock.ExpectQuery("SELECT COALESCE\\(current_level").
		WithArgs("u1", GroupID("re_b")).WillReturnRows(sqlmock.NewRows([]string{"current_level"}).AddRow(1))
	mock.ExpectQuery("SELECT rewards FROM quest_claims").
		WithArgs("u1", GroupID("re_b"), 1).
		WillReturnRows(sqlmock.NewRows([]string{"rewards"}).AddRow(mustMarshal(t, e.levelRewards("re_b", 1))))
	mock.ExpectRollback()

	topped, err := e.ReconcileUser(t.Context(), "u1")
	if err != nil {
		t.Fatalf("ReconcileUser: %v", err)
	}
	if len(topped) != 0 {
		t.Errorf("expected no top-ups, got %v", topped)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unfulfilled: %v", err)
	}
}
