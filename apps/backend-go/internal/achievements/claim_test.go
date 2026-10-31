package achievements

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

func claimTestCatalog(t *testing.T) *Catalog {
	t.Helper()
	cat, err := NewCatalog([]*Group{
		{
			Key: "qs_avatar", TitleKey: "t", Category: CategoryProfile,
			Icon: "smile", Kind: KindMilestone, Type: TypeOneTime, Stat: StatCounter, Track: TrackFirstSteps, SortOrder: 1,
			Levels: []Level{
				{Level: 1, Threshold: 1, NameKey: "k", DescriptionKey: "d",
					Rewards: []Reward{{Kind: RewardGems, Amount: 20}, {Kind: RewardDrops, Amount: 5}}},
			},
		},
	})
	if err != nil {
		t.Fatalf("claim catalog: %v", err)
	}
	return cat
}

func TestClaimLevel_GemsAndDrops(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	e := New(db, claimTestCatalog(t))

	mock.ExpectBegin()
	mock.ExpectQuery("SELECT COALESCE\\(current_level").
		WithArgs("u1", GroupID("qs_avatar")).
		WillReturnRows(sqlmock.NewRows([]string{"current_level"}).AddRow(1))
	mock.ExpectQuery("INSERT INTO quest_claims").
		WithArgs("u1", GroupID("qs_avatar"), 1, sqlmock.AnyArg()).
		WillReturnRows(sqlmock.NewRows([]string{"ok"}).AddRow(true))
	mock.ExpectQuery("UPDATE users SET gems").
		WithArgs(20, "u1").WillReturnRows(sqlmock.NewRows([]string{"gems"}).AddRow(120))
	mock.ExpectExec("INSERT INTO drops_transactions").
		WithArgs("u1", 20, 120, "quest", "Quest reward: +20 gems").
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectQuery("UPDATE users SET drops").
		WithArgs(5, "u1").WillReturnRows(sqlmock.NewRows([]string{"drops"}).AddRow(105))
	mock.ExpectExec("INSERT INTO drops_transactions").
		WithArgs("u1", 5, 105, "quest", "Quest reward: +5 drops").
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectCommit()

	granted, err := e.ClaimLevel(t.Context(), "u1", "qs_avatar", 1)
	if err != nil {
		t.Fatalf("ClaimLevel: %v", err)
	}
	if len(granted) != 2 {
		t.Fatalf("expected 2 granted rewards, got %d", len(granted))
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unfulfilled: %v", err)
	}
}

func TestClaimLevel_AlreadyClaimed(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	e := New(db, claimTestCatalog(t))

	mock.ExpectBegin()
	mock.ExpectQuery("SELECT COALESCE\\(current_level").
		WithArgs("u1", GroupID("qs_avatar")).
		WillReturnRows(sqlmock.NewRows([]string{"current_level"}).AddRow(1))
	// ON CONFLICT DO NOTHING → no RETURNING row.
	mock.ExpectQuery("INSERT INTO quest_claims").
		WithArgs("u1", GroupID("qs_avatar"), 1, sqlmock.AnyArg()).
		WillReturnRows(sqlmock.NewRows([]string{"ok"}))
	mock.ExpectRollback()

	if _, err := e.ClaimLevel(t.Context(), "u1", "qs_avatar", 1); !errors.Is(err, ErrQuestClaimed) {
		t.Fatalf("expected ErrQuestClaimed, got %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unfulfilled: %v", err)
	}
}

func TestClaimLevel_NotCompleted(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	e := New(db, claimTestCatalog(t))

	mock.ExpectBegin()
	mock.ExpectQuery("SELECT COALESCE\\(current_level").
		WithArgs("u1", GroupID("qs_avatar")).
		WillReturnRows(sqlmock.NewRows([]string{"current_level"}))
	mock.ExpectRollback()

	if _, err := e.ClaimLevel(t.Context(), "u1", "qs_avatar", 1); !errors.Is(err, ErrQuestNotCompleted) {
		t.Fatalf("expected ErrQuestNotCompleted, got %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unfulfilled: %v", err)
	}
}

func TestClaimLevel_UnknownQuest(t *testing.T) {
	db, _, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	e := New(db, claimTestCatalog(t))
	if _, err := e.ClaimLevel(t.Context(), "u1", "nope", 1); !errors.Is(err, ErrQuestUnknown) {
		t.Fatalf("expected ErrQuestUnknown, got %v", err)
	}
}

// fixedTapSource is a deterministic gamification.Source: 0.0 always upgrades,
// 0.99 always fails.
type fixedTapSource float64

func (f fixedTapSource) Float64() float64 { return float64(f) }

// A tap that fails persists the session — the dots survive a modal close.
func TestTapChest_FailPersistsSession(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	e := New(db, claimTestCatalog(t))

	mock.ExpectBegin()
	mock.ExpectQuery("SELECT mechanic, session::text").
		WithArgs("c1", "u1").
		WillReturnRows(sqlmock.NewRows([]string{"mechanic", "session", "opened"}).
			AddRow("rarity_chest", nil, false))
	mock.ExpectExec("UPDATE quest_chests SET session").
		WithArgs(sqlmock.AnyArg(), "c1").
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	out, err := e.tapChest(t.Context(), "quest_chests", "quest_reward", "quest", "Quest chest", "u1", "c1", fixedTapSource(0.99))
	if err != nil {
		t.Fatalf("tap: %v", err)
	}
	if out.Type != "failed" {
		t.Fatalf("expected a failed tap, got %q", out.Type)
	}
	if out.AttemptsTotal != 5 || out.AttemptsLeft != 4 {
		t.Fatalf("expected 4/5 attempts left, got %+v", out)
	}
	if out.Drops != 0 {
		t.Fatalf("a failed tap must not credit, got %+v", out)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unfulfilled: %v", err)
	}
}

// A tap from mythic with a lucky roll upgrades to eternal and opens at once,
// crediting the jackpot in the same transaction.
func TestTapChest_UpgradeOpensAndCredits(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	e := New(db, claimTestCatalog(t))

	session := `{"mechanic_key":"rarity_chest","rarity":"mythic","attempts_left":5,"opened":false}`
	mock.ExpectBegin()
	mock.ExpectQuery("SELECT mechanic, session::text").
		WithArgs("c9", "u1").
		WillReturnRows(sqlmock.NewRows([]string{"mechanic", "session", "opened"}).
			AddRow("rarity_chest", session, false))
	mock.ExpectQuery("UPDATE users SET drops").
		WithArgs(sqlmock.AnyArg(), "u1").
		WillReturnRows(sqlmock.NewRows([]string{"drops"}).AddRow(800))
	mock.ExpectExec("INSERT INTO drops_transactions").
		WithArgs("u1", "daily_reward", sqlmock.AnyArg(), 800, "daily", sqlmock.AnyArg()).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec("UPDATE daily_chests SET opened_at").
		WithArgs(sqlmock.AnyArg(), "c9").
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	out, err := e.tapChest(t.Context(), "daily_chests", "daily_reward", "daily", "Daily chest", "u1", "c9", fixedTapSource(0.0))
	if err != nil {
		t.Fatalf("tap: %v", err)
	}
	if out.Type != "opened" || out.FinalRarity != "eternal" {
		t.Fatalf("expected an eternal opening, got %+v", out)
	}
	if out.Drops <= 0 {
		t.Fatalf("the opening tap must credit drops, got %+v", out)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unfulfilled: %v", err)
	}
}

// sqlmock matches query text but never the driver arg count, so a dropped $N
// stays green in tests and explodes only against real Postgres. This pins
// every tapChest query to the arg count its call site passes.
func TestTapChestQueries_PlaceholderCounts(t *testing.T) {
	highest := func(q string) int {
		top := 0
		for i := 1; ; i++ {
			if !strings.Contains(q, fmt.Sprintf("$%d", i)) {
				return top
			}
			top = i
		}
	}
	cases := []struct {
		name string
		q    string
		args int
	}{
		{"select", fmt.Sprintf(tapChestSelectQuery, "quest_chests"), 2},
		{"session", fmt.Sprintf(tapChestSessionQuery, "quest_chests"), 2},
		{"credit", tapChestCreditQuery, 2},
		{"ledger", tapChestLedgerQuery, 6},
		{"close", fmt.Sprintf(tapChestCloseQuery, "quest_chests"), 2},
	}
	for _, tc := range cases {
		if got := highest(tc.q); got != tc.args {
			t.Errorf("%s: query has $%d but the call site passes %d args", tc.name, got, tc.args)
		}
	}
}

func TestTapChest_AlreadyOpened(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	e := New(db, claimTestCatalog(t))

	mock.ExpectBegin()
	mock.ExpectQuery("SELECT mechanic, session::text").
		WithArgs("c1", "u1").
		WillReturnRows(sqlmock.NewRows([]string{"mechanic", "session", "opened"}).
			AddRow("rarity_chest", nil, true))
	mock.ExpectRollback()

	if _, err := e.tapChest(t.Context(), "quest_chests", "quest_reward", "quest", "Quest chest", "u1", "c1", fixedTapSource(0.0)); !errors.Is(err, ErrChestOpened) {
		t.Fatalf("expected ErrChestOpened, got %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unfulfilled: %v", err)
	}
}

// Five straight misses on a fresh chest: the first four taps persist the
// shrinking session, the fifth (last attempt) opens at common and credits.
// This is the exact "после последней попытки выпадает награда" path.
func TestTapChest_ExhaustionOpensAtCommon(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	e := New(db, claimTestCatalog(t))

	session := func(left int) string {
		return `{"mechanic_key":"rarity_chest","rarity":"common","attempts_left":` + string(rune('0'+left)) + `,"opened":false}`
	}
	// First tap reads NULL (never tapped); the rest read back the session
	// the previous tap stored.
	mock.ExpectBegin()
	mock.ExpectQuery("SELECT mechanic, session::text").WithArgs("c1", "u1").
		WillReturnRows(sqlmock.NewRows([]string{"mechanic", "session", "opened"}).AddRow("rarity_chest", nil, false))
	for i := 4; i >= 1; i-- {
		mock.ExpectExec("UPDATE quest_chests SET session").WithArgs(sqlmock.AnyArg(), "c1").
			WillReturnResult(sqlmock.NewResult(0, 1))
		mock.ExpectCommit()
		if i > 1 {
			mock.ExpectBegin()
			mock.ExpectQuery("SELECT mechanic, session::text").WithArgs("c1", "u1").
				WillReturnRows(sqlmock.NewRows([]string{"mechanic", "session", "opened"}).AddRow("rarity_chest", session(i), false))
		}
	}
	// The last attempt: credit chain + stamp, like any opening tap.
	mock.ExpectBegin()
	mock.ExpectQuery("SELECT mechanic, session::text").WithArgs("c1", "u1").
		WillReturnRows(sqlmock.NewRows([]string{"mechanic", "session", "opened"}).AddRow("rarity_chest", session(1), false))
	mock.ExpectQuery("UPDATE users SET drops").WithArgs(sqlmock.AnyArg(), "u1").
		WillReturnRows(sqlmock.NewRows([]string{"drops"}).AddRow(120))
	mock.ExpectExec("INSERT INTO drops_transactions").WithArgs("u1", "quest_reward", sqlmock.AnyArg(), 120, "quest", sqlmock.AnyArg()).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec("UPDATE quest_chests SET opened_at").WithArgs(sqlmock.AnyArg(), "c1").
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	var last *ChestTap
	for i := 0; i < 5; i++ {
		last, err = e.tapChest(t.Context(), "quest_chests", "quest_reward", "quest", "Quest chest", "u1", "c1", fixedTapSource(0.99))
		if err != nil {
			t.Fatalf("tap %d: %v", i+1, err)
		}
		if i < 4 && last.Type != "failed" {
			t.Fatalf("tap %d: expected failed, got %+v", i+1, last)
		}
	}
	if last.Type != "opened" || last.FinalRarity != "common" {
		t.Fatalf("5th tap must open at common, got %+v", last)
	}
	if last.Drops <= 0 {
		t.Fatalf("the last attempt must credit drops, got %+v", last)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unfulfilled: %v", err)
	}
}
