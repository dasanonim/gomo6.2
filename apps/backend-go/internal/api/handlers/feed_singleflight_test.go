package handlers

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// TestDoFeedSingleflight_SharesOneCall verifies concurrent identical feed
// misses collapse into a single DB query: fn must run exactly once while all
// callers receive its page.
func TestDoFeedSingleflight_SharesOneCall(t *testing.T) {
	var calls atomic.Int32
	fn := func() ([]feedItem, error) {
		calls.Add(1)
		time.Sleep(50 * time.Millisecond)
		return []feedItem{{ItemType: "thread", ItemID: "t1"}}, nil
	}

	const waiters = 10
	var wg sync.WaitGroup
	results := make([][]feedItem, waiters)
	shared := make([]bool, waiters)
	for i := 0; i < waiters; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			items, err, wasShared := doFeedSingleflight("k", fn)
			if err != nil {
				t.Errorf("waiter %d: unexpected error %v", i, err)
				return
			}
			results[i] = items
			shared[i] = wasShared
		}(i)
	}
	wg.Wait()

	if got := calls.Load(); got != 1 {
		t.Fatalf("fn ran %d times, want exactly 1", got)
	}
	for i := range results {
		if len(results[i]) != 1 || results[i][0].ItemID != "t1" {
			t.Fatalf("waiter %d got %+v, want the shared page", i, results[i])
		}
	}
	sharedCount := 0
	for _, s := range shared {
		if s {
			sharedCount++
		}
	}
	if sharedCount != waiters-1 {
		t.Fatalf("shared hits = %d, want %d (everyone but the winner)", sharedCount, waiters-1)
	}
}

// TestDoFeedSingleflight_DistinctKeysRunSeparately verifies different cursors
// do not share a call.
func TestDoFeedSingleflight_DistinctKeysRunSeparately(t *testing.T) {
	var calls atomic.Int32
	fn := func() ([]feedItem, error) {
		calls.Add(1)
		return nil, nil
	}
	if _, _, _ = doFeedSingleflight("a", fn); true {
	}
	if _, _, shared := doFeedSingleflight("b", fn); shared {
		t.Fatal("distinct key must not report a shared hit")
	}
	if got := calls.Load(); got != 2 {
		t.Fatalf("fn ran %d times, want 2", got)
	}
}

// TestFeedFlightKey_VariesByViewerAndCursor guards the stampede key: the same
// viewer+cursor must map to one key, while viewer, limit and cursors split it.
func TestFeedFlightKey_VariesByViewerAndCursor(t *testing.T) {
	since := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	sort := 1792790394.5
	id := "thread-1"

	base := feedFlightKey("u1", 20, &since, &sort, &id)
	if feedFlightKey("u1", 20, &since, &sort, &id) != base {
		t.Fatal("identical params must produce an identical key")
	}
	otherViewer := feedFlightKey("u2", 20, &since, &sort, &id)
	otherLimit := feedFlightKey("u1", 10, &since, &sort, &id)
	otherCursor := feedFlightKey("u1", 20, &since, &sort, nil)
	anon := feedFlightKey(nil, 20, nil, nil, nil)
	for name, k := range map[string]string{
		"viewer": otherViewer, "limit": otherLimit, "cursor": otherCursor, "anon": anon,
	} {
		if k == base {
			t.Fatalf("%s must produce a distinct key", name)
		}
	}
}
