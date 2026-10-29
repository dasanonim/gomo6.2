package achievements

import (
	"database/sql/driver"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/gomo6/backend/internal/activity"
)

// testCatalog covers counter quests, the derived meta quest and one_time.
func testCatalog(t *testing.T) *Catalog {
	t.Helper()
	cat, err := NewCatalog([]*Group{
		{
			Key: "qs_first_thread", TitleKey: "t.thread", Category: CategoryContent,
			Icon: "message-square", Kind: KindMilestone, Type: TypeOneTime, Stat: StatCounter, Track: TrackFirstSteps, SortOrder: 1,
			Levels: []Level{
				{Level: 1, Threshold: 1, NameKey: "k1", DescriptionKey: "d1", Rewards: []Reward{{Kind: RewardGems, Amount: 10}}},
			},
		},
		{
			Key: "qs_first_wall", TitleKey: "t.wall", Category: CategoryContent,
			Icon: "pen-line", Kind: KindMilestone, Type: TypeOneTime, Stat: StatCounter, Track: TrackFirstSteps, SortOrder: 2,
			Levels: []Level{
				{Level: 1, Threshold: 1, NameKey: "k1", DescriptionKey: "d1", Rewards: []Reward{{Kind: RewardGems, Amount: 10}}},
			},
		},
		{
			Key: "entries", TitleKey: "t.entries", Category: CategoryContent,
			Icon: "notebook-pen", Kind: KindMilestone, Type: TypeProgressive, Stat: StatCounter, Track: TrackMain, SortOrder: 3,
			Levels: []Level{
				{Level: 1, Threshold: 1, NameKey: "k1", DescriptionKey: "d1", Rewards: []Reward{{Kind: RewardGems, Amount: 10}}},
				{Level: 2, Threshold: 10, NameKey: "k2", DescriptionKey: "d2", Rewards: []Reward{{Kind: RewardGems, Amount: 25}}},
			},
		},
		{
			Key: "likes_received", TitleKey: "t.likes", Category: CategoryContent,
			Icon: "heart", Kind: KindMilestone, Type: TypeProgressive, Stat: StatCounter, Track: TrackMain, SortOrder: 4,
			Levels: []Level{
				{Level: 1, Threshold: 10, NameKey: "l1", DescriptionKey: "ld1", Rewards: []Reward{{Kind: RewardGems, Amount: 15}}},
				{Level: 2, Threshold: 100, NameKey: "l2", DescriptionKey: "ld2", Rewards: []Reward{{Kind: RewardGems, Amount: 50}}},
			},
		},
		{
			Key: "qs_complete", TitleKey: "t.meta", Category: CategoryOnboarding,
			Icon: "trophy", Kind: KindMilestone, Type: TypeOneTime, Stat: StatDerived, Track: TrackFirstSteps, SortOrder: 5,
			Levels: []Level{
				{Level: 1, Threshold: 2, NameKey: "m1", DescriptionKey: "md1", Rewards: []Reward{{Kind: RewardChest, Mechanic: "rarity_chest"}}},
			},
		},
	})
	if err != nil {
		t.Fatalf("test catalog: %v", err)
	}
	return cat
}

func newEngine(t *testing.T) (*Engine, sqlmock.Sqlmock) {
	t.Helper()
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
	t.Cleanup(func() {
		if err := mock.ExpectationsWereMet(); err != nil {
			t.Errorf("unfulfilled mock expectations: %v", err)
		}
		db.Close()
	})
	return New(db, testCatalog(t)), mock
}

func expectCurrentLevel(mock sqlmock.Sqlmock, key string, level int) {
	rows := sqlmock.NewRows([]string{"current_level"})
	if level > 0 {
		rows.AddRow(level)
	}
	mock.ExpectQuery("SELECT COALESCE\\(current_level").WithArgs("u1", GroupID(key)).WillReturnRows(rows)
}

func expectExactUpsert(mock sqlmock.Sqlmock, key string, level, progress int) {
	mock.ExpectExec("INSERT INTO user_achievements").
		WithArgs("u1", GroupID(key), level, progress, sqlmock.AnyArg()).
		WillReturnResult(sqlmock.NewResult(1, 1))
}

// expectCounterReconcile stubs a counter event: a sourceCount query returning
// the live value, the counter write, a level read and the exact upsert.
func expectCounterReconcile(mock sqlmock.Sqlmock, fragment, key string, value, level int) {
	mock.ExpectQuery(fragment).WithArgs("u1").
		WillReturnRows(sqlmock.NewRows([]string{"v"}).AddRow(value))
	mock.ExpectExec("INSERT INTO user_achievement_counters").
		WithArgs("u1", key, value).WillReturnResult(sqlmock.NewResult(1, 1))
	expectCurrentLevel(mock, key, 0)
	if level > 0 {
		expectExactUpsert(mock, key, level, value)
	}
}

// ──────────────── counter events ────────────────

// A thread crosses threshold 1 → the thread first-step and the combined
// entries ladder reconcile from live data, then the meta quest is checked.
func TestHandleEvent_ThreadUnlock(t *testing.T) {
	e, mock := newEngine(t)

	expectCounterReconcile(mock, "FROM threads t WHERE t.user_id", "qs_first_thread", 1, 1)
	expectCounterReconcile(mock, "FROM threads t WHERE t.user_id", "entries", 1, 1)
	// meta: 1 of 2 first steps done → no unlock yet
	mock.ExpectQuery("FROM user_achievements").WithArgs("u1", sqlmock.AnyArg()).
		WillReturnRows(sqlmock.NewRows([]string{"v"}).AddRow(1))
	expectCurrentLevel(mock, "qs_complete", 0)

	e.HandleEvent(Event{UserID: "u1", Type: EventEntryCreated, TargetType: "thread"})
}

// A wall post feeds the wall first-step (not the thread one) plus entries.
func TestHandleEvent_WallPostSplit(t *testing.T) {
	e, mock := newEngine(t)

	expectCounterReconcile(mock, "FROM profile_wall_posts w WHERE", "qs_first_wall", 1, 1)
	expectCounterReconcile(mock, "author_id", "entries", 1, 1)
	mock.ExpectQuery("FROM user_achievements").WithArgs("u1", sqlmock.AnyArg()).
		WillReturnRows(sqlmock.NewRows([]string{"v"}).AddRow(1))
	expectCurrentLevel(mock, "qs_complete", 0)

	e.HandleEvent(Event{UserID: "u1", Type: EventEntryCreated, TargetType: "wall_post"})
}

// A received like reconciles likes_received (no meta: not a first-steps event)
// and crosses level 1 here (test threshold 10, value 42).
func TestHandleEvent_LikeReceivedUnlock(t *testing.T) {
	e, mock := newEngine(t)

	expectCounterReconcile(mock, "FROM post_likes pl", "likes_received", 42, 1)

	e.HandleEvent(Event{UserID: "u1", Type: EventLikeReceived})
}

// A failed level write must not notify: otherwise the toast and the bell
// promise a level the achievements page can never show (the reported
// "toast says earned but nothing on the page" ghost).
type stubNotifier struct {
	calls int
}

func (s *stubNotifier) NotifyMilestone(userID string, g *Group, prevLevel, newLevel int) {
	s.calls++
}

func TestHandleEvent_UpsertFailureSkipsNotify(t *testing.T) {
	e, mock := newEngine(t)
	stub := &stubNotifier{}
	e.Notifier = stub

	mock.ExpectQuery("FROM post_likes pl").WithArgs("u1").
		WillReturnRows(sqlmock.NewRows([]string{"v"}).AddRow(42))
	mock.ExpectExec("INSERT INTO user_achievement_counters").
		WithArgs("u1", "likes_received", 42).WillReturnResult(sqlmock.NewResult(1, 1))
	expectCurrentLevel(mock, "likes_received", 0)
	mock.ExpectExec("INSERT INTO user_achievements").
		WithArgs("u1", GroupID("likes_received"), 1, 42, sqlmock.AnyArg()).
		WillReturnError(errors.New("boom"))

	e.HandleEvent(Event{UserID: "u1", Type: EventLikeReceived})

	if stub.calls != 0 {
		t.Errorf("notify must not fire when the level write failed, got %d call(s)", stub.calls)
	}
}

// The counter reconciles to the LIVE value even when an earlier event was
// missed — the quest never lags the real row count.
func TestHandleEvent_CounterSelfHeals(t *testing.T) {
	e, mock := newEngine(t)

	expectCounterReconcile(mock, "FROM threads t WHERE t.user_id", "qs_first_thread", 5, 1)
	expectCounterReconcile(mock, "FROM threads t WHERE t.user_id", "entries", 5, 1)
	mock.ExpectQuery("FROM user_achievements").WithArgs("u1", sqlmock.AnyArg()).
		WillReturnRows(sqlmock.NewRows([]string{"v"}).AddRow(1))
	expectCurrentLevel(mock, "qs_complete", 0)

	e.HandleEvent(Event{UserID: "u1", Type: EventEntryCreated})
}

func TestHandleEvent_UnknownTypeNoop(t *testing.T) {
	e, _ := newEngine(t)
	// No DB expectations registered: an unknown event must not touch the DB.
	e.HandleEvent(Event{UserID: "u1", Type: "totally_unknown"})
}

// ──────────────── meta quest ────────────────

// An avatar event for a quest missing from the catalog is a no-op for the
// counter, but the meta quest is still re-evaluated (and unlocks here).
func TestHandleEvent_MetaUnlock(t *testing.T) {
	e, mock := newEngine(t)

	// qs_avatar is not in the test catalog → no queries for it.
	mock.ExpectQuery("FROM user_achievements").WithArgs("u1", sqlmock.AnyArg()).
		WillReturnRows(sqlmock.NewRows([]string{"v"}).AddRow(2))
	expectCurrentLevel(mock, "qs_complete", 0)
	expectExactUpsert(mock, "qs_complete", 1, 2)

	e.HandleEvent(Event{UserID: "u1", Type: EventAvatarUpdated})
}

// ──────────────── sync / recompute ────────────────

// The mirror insert takes 12 args ($1…$12; $3 is used twice).
const mirrorArgs = 12

func mirrorArgValues() []driver.Value {
	args := make([]driver.Value, mirrorArgs)
	for i := range args {
		args[i] = sqlmock.AnyArg()
	}
	return args
}

func TestSync_CreatesMirror(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	e := New(db, testCatalog(t))

	mock.ExpectQuery("SELECT group_key, COALESCE\\(definition_hash").
		WillReturnRows(sqlmock.NewRows([]string{"group_key", "definition_hash"}))
	for range testCatalog(t).Groups() {
		mock.ExpectExec("INSERT INTO achievements").WithArgs(mirrorArgValues()...).
			WillReturnResult(sqlmock.NewResult(1, 1))
	}
	mock.ExpectExec("DELETE FROM user_achievements").WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec("DELETE FROM achievements").WillReturnResult(sqlmock.NewResult(1, 1))

	dirty, err := e.Sync(t.Context())
	if err != nil {
		t.Fatalf("Sync: %v", err)
	}
	if len(dirty) != 0 {
		t.Errorf("fresh catalog must not be dirty, got %v", dirty)
	}
}

func TestSync_DetectsDirty(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	e := New(db, testCatalog(t))

	mock.ExpectQuery("SELECT group_key, COALESCE\\(definition_hash").
		WillReturnRows(sqlmock.NewRows([]string{"group_key", "definition_hash"}).
			AddRow("entries", "stale-hash"))
	for range testCatalog(t).Groups() {
		mock.ExpectExec("INSERT INTO achievements").WithArgs(mirrorArgValues()...).
			WillReturnResult(sqlmock.NewResult(1, 1))
	}
	mock.ExpectExec("DELETE FROM user_achievements").WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec("DELETE FROM achievements").WillReturnResult(sqlmock.NewResult(1, 1))

	dirty, err := e.Sync(t.Context())
	if err != nil {
		t.Fatalf("Sync: %v", err)
	}
	if len(dirty) != 1 || dirty[0] != "entries" {
		t.Errorf("expected dirty=[entries], got %v", dirty)
	}
}

func TestGroupID_Deterministic(t *testing.T) {
	a := GroupID("entries")
	b := GroupID("entries")
	if a != b {
		t.Errorf("GroupID not deterministic: %s != %s", a, b)
	}
	if a == GroupID("likes_received") {
		t.Errorf("different keys share id %s", a)
	}
	if !strings.Contains(a, "-") {
		t.Errorf("expected UUID string, got %q", a)
	}
}

// RecomputeUser iterates every quest and reconciles each from live data.
func TestRecomputeUser(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	e := New(db, testCatalog(t))

	values := map[string]int{
		"qs_first_thread": 1,
		"qs_first_wall":   0,
		"entries":         11,
		"likes_received":  5,
		"qs_complete":     2,
	}
	fragments := map[string]string{
		"qs_first_thread": "FROM threads t WHERE t.user_id",
		"qs_first_wall":   "FROM profile_wall_posts w WHERE",
		"entries":         "author_id",
		"likes_received":  "FROM post_likes pl",
		"qs_complete":     "FROM user_achievements",
	}
	for _, g := range testCatalog(t).Groups() {
		if g.Stat == StatDerived {
			mock.ExpectQuery(fragments[g.Key]).WithArgs("u1", sqlmock.AnyArg()).
				WillReturnRows(sqlmock.NewRows([]string{"v"}).AddRow(values[g.Key]))
		} else {
			mock.ExpectQuery(fragments[g.Key]).WithArgs("u1").
				WillReturnRows(sqlmock.NewRows([]string{"v"}).AddRow(values[g.Key]))
			mock.ExpectExec("INSERT INTO user_achievement_counters").
				WithArgs("u1", g.Key, values[g.Key]).WillReturnResult(sqlmock.NewResult(1, 1))
		}
		expectCurrentLevel(mock, g.Key, 0)
		if lvl := g.LevelFor(values[g.Key]); lvl > 0 {
			expectExactUpsert(mock, g.Key, lvl, values[g.Key])
		}
	}

	e.RecomputeUser(t.Context(), "u1")
}

// ──────────── activity ledger ────────────

// waitForLedger polls until cond holds (the ledger write is asynchronous).
func waitForLedger(t *testing.T, cond func() bool) {
	t.Helper()
	for i := 0; i < 600; i++ {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("ledger write not observed within timeout")
}

// Every handled event must land in the append-only activity ledger, carrying
// the target the action touched so moderation can point at the object.
func TestHandleEvent_RecordsActivityLedger(t *testing.T) {
	e, mock := newEngine(t)
	e.SetActivityRecorder(activity.New(e.db))

	mock.ExpectExec(`INSERT INTO user_activity_events`).
		WithArgs("u1", "test_event", "post", "p-1").
		WillReturnResult(sqlmock.NewResult(1, 1))

	// "test_event" maps to no counter/derived group, so the only DB work is the
	// ledger insert.
	e.HandleEvent(Event{UserID: "u1", Type: EventType("test_event"), TargetType: "post", TargetID: "p-1"})

	waitForLedger(t, func() bool { return mock.ExpectationsWereMet() == nil })
}

// A nil recorder leaves the engine working and writes nothing to the ledger.
func TestHandleEvent_NoLedgerWhenUnset(t *testing.T) {
	e, _ := newEngine(t)
	e.SetActivityRecorder(nil)

	e.HandleEvent(Event{UserID: "u1", Type: EventType("test_event")})
}
