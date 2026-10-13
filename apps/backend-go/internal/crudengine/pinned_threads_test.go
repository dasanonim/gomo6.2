package crudengine

import (
	"net/http"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/gomo6/backend/internal/auth"
)

const pinnedTestOwner = "11111111-1111-1111-1111-111111111111"
const pinnedTestViewer = "22222222-2222-2222-2222-222222222222"
const pinnedTestThread = "33333333-3333-3333-3333-333333333333"

// TestPinnedThreads_RegistryEntry locks the security posture of the new table:
// public reads (a profile's pinned list is public), caller-forced ownership on
// writes, and the idempotent upsert + read override the handler relies on.
func TestPinnedThreads_RegistryEntry(t *testing.T) {
	meta := GenericTableByName("profile_pinned_threads")
	if meta == nil {
		t.Fatal("profile_pinned_threads missing from the registry")
	}
	if meta.ReadAccess != GuestRead {
		t.Errorf("ReadAccess = %v, want GuestRead", meta.ReadAccess)
	}
	if meta.PostOwner != OwnSingle || meta.WriteOwner != OwnSingle {
		t.Errorf("ownership = (%v, %v), want (OwnSingle, OwnSingle)", meta.PostOwner, meta.WriteOwner)
	}
	if !meta.Upsert || meta.BuildUpsert == nil {
		t.Error("pin must be an idempotent upsert (Upsert + BuildUpsert)")
	}
	if meta.PrepareBody == nil {
		t.Error("PrepareBody must enforce the 3-pin cap and the position")
	}
	if meta.ReadHandler == nil {
		t.Error("ReadHandler must serve the profile-privacy-gated list")
	}
	if meta.InvalidateCache == nil {
		t.Error("InvalidateCache must drop the cached reads after a write")
	}
	if !meta.WritableColumns["thread_id"] {
		t.Error("thread_id must be client-writable")
	}
	if meta.WritableColumns["user_id"] || meta.WritableColumns["position"] {
		t.Error("user_id and position must be server-managed")
	}
	if MaxPinnedProfileThreads != 3 {
		t.Errorf("MaxPinnedProfileThreads = %d, want 3", MaxPinnedProfileThreads)
	}
}

func TestHandleProfilePinnedThreadsGet_RequiresUserID(t *testing.T) {
	h, _ := setupEngine(t)

	c, w := newRequestContext("GET", "/api/v1/profile_pinned_threads", nil, nil)
	h.handleProfilePinnedThreadsGet(c)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
	}
}

func TestHandleProfilePinnedThreadsGet_RejectsInvalidUserID(t *testing.T) {
	h, _ := setupEngine(t)

	c, w := newRequestContext("GET", "/api/v1/profile_pinned_threads?user_id=eq.not-a-uuid", nil, nil)
	h.handleProfilePinnedThreadsGet(c)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
	}
}

// A private profile hides its pinned threads from anonymous viewers — the
// response is an empty list (the block just does not render), never an error.
func TestHandleProfilePinnedThreadsGet_PrivateProfileHidesPins(t *testing.T) {
	h, mock := setupEngine(t)

	mock.ExpectQuery(`SELECT .*FROM privacy_settings WHERE user_id = \$1`).
		WithArgs(pinnedTestOwner).
		WillReturnRows(sqlmock.NewRows([]string{
			"private_profile", "private_hide_avatar", "private_hide_wall", "private_hide_threads",
			"private_hide_stats", "private_hide_friends", "private_hide_gifts", "private_hide_achievements",
		}).AddRow(true, false, false, true, false, true, true, true))

	c, w := newRequestContext("GET", "/api/v1/profile_pinned_threads?user_id=eq."+pinnedTestOwner, nil, nil)
	h.handleProfilePinnedThreadsGet(c)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"data":[]`) {
		t.Fatalf("expected an empty list, got %s", w.Body.String())
	}
}

func TestHandleProfilePinnedThreadsGet_PublicProfileReturnsPins(t *testing.T) {
	h, mock := setupEngine(t)

	mock.ExpectQuery(`SELECT .*FROM privacy_settings WHERE user_id = \$1`).
		WithArgs(pinnedTestOwner).
		WillReturnRows(sqlmock.NewRows([]string{
			"private_profile", "private_hide_avatar", "private_hide_wall", "private_hide_threads",
			"private_hide_stats", "private_hide_friends", "private_hide_gifts", "private_hide_achievements",
		}).AddRow(false, false, false, true, false, true, true, true))

	mock.ExpectQuery(`SELECT p.thread_id, p.position, p.created_at`).
		WithArgs(pinnedTestOwner, MaxPinnedProfileThreads).
		WillReturnRows(sqlmock.NewRows([]string{"thread_id", "position", "created_at"}).
			AddRow(pinnedTestThread, 1, "2026-01-01T00:00:00Z"))

	c, w := newRequestContext("GET", "/api/v1/profile_pinned_threads?user_id=eq."+pinnedTestOwner, nil, nil)
	h.handleProfilePinnedThreadsGet(c)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), pinnedTestThread) {
		t.Fatalf("expected the pinned thread in the payload, got %s", w.Body.String())
	}
}

func TestPreparePinnedThreadBody_RequiresThreadID(t *testing.T) {
	h, _ := setupEngine(t)
	c, w := newRequestContext("POST", "/api/v1/profile_pinned_threads", nil, &auth.Claims{UserID: pinnedTestViewer})

	if preparePinnedThreadBody(h, c, "profile_pinned_threads", "POST", map[string]interface{}{}) {
		t.Fatal("expected the guard to reject a missing thread_id")
	}
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestPreparePinnedThreadBody_RequiresAuth(t *testing.T) {
	h, _ := setupEngine(t)
	c, w := newRequestContext("POST", "/api/v1/profile_pinned_threads", nil, nil)

	data := map[string]interface{}{"thread_id": pinnedTestThread}
	if preparePinnedThreadBody(h, c, "profile_pinned_threads", "POST", data) {
		t.Fatal("expected the guard to reject an unauthenticated caller")
	}
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
}

func TestPreparePinnedThreadBody_ThreadNotFound(t *testing.T) {
	h, mock := setupEngine(t)

	mock.ExpectQuery(`SELECT b.id, b.visibility, b.owner_id`).
		WithArgs(pinnedTestThread).
		WillReturnRows(sqlmock.NewRows([]string{"id", "visibility", "owner_id"}))

	c, w := newRequestContext("POST", "/api/v1/profile_pinned_threads", nil, &auth.Claims{UserID: pinnedTestViewer})
	data := map[string]interface{}{"thread_id": pinnedTestThread}

	if preparePinnedThreadBody(h, c, "profile_pinned_threads", "POST", data) {
		t.Fatal("expected the guard to reject a missing thread")
	}
	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}

func TestPreparePinnedThreadBody_PrivateBoardRejected(t *testing.T) {
	h, mock := setupEngine(t)

	mock.ExpectQuery(`SELECT b.id, b.visibility, b.owner_id`).
		WithArgs(pinnedTestThread).
		WillReturnRows(sqlmock.NewRows([]string{"id", "visibility", "owner_id"}).
			AddRow("44444444-4444-4444-4444-444444444444", "private", pinnedTestOwner))
	mock.ExpectQuery(`SELECT EXISTS\(SELECT 1 FROM gomosub_memberships`).
		WithArgs("44444444-4444-4444-4444-444444444444", pinnedTestViewer).
		WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(false))

	c, w := newRequestContext("POST", "/api/v1/profile_pinned_threads", nil, &auth.Claims{UserID: pinnedTestViewer})
	data := map[string]interface{}{"thread_id": pinnedTestThread}

	if preparePinnedThreadBody(h, c, "profile_pinned_threads", "POST", data) {
		t.Fatal("expected the guard to reject a private board for a non-member")
	}
	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", w.Code)
	}
}

func TestPreparePinnedThreadBody_EnforcesCap(t *testing.T) {
	h, mock := setupEngine(t)

	mock.ExpectQuery(`SELECT b.id, b.visibility, b.owner_id`).
		WithArgs(pinnedTestThread).
		WillReturnRows(sqlmock.NewRows([]string{"id", "visibility", "owner_id"}).
			AddRow(nil, nil, nil)) // global topic: board columns NULL
	mock.ExpectQuery(`SELECT position FROM profile_pinned_threads`).
		WithArgs(pinnedTestViewer, pinnedTestThread).
		WillReturnRows(sqlmock.NewRows([]string{"position"}))
	mock.ExpectQuery(`SELECT COUNT\(\*\) FROM profile_pinned_threads`).
		WithArgs(pinnedTestViewer).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(MaxPinnedProfileThreads))

	c, w := newRequestContext("POST", "/api/v1/profile_pinned_threads", nil, &auth.Claims{UserID: pinnedTestViewer})
	data := map[string]interface{}{"thread_id": pinnedTestThread}

	if preparePinnedThreadBody(h, c, "profile_pinned_threads", "POST", data) {
		t.Fatal("expected the guard to reject a fourth pin")
	}
	if w.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d", w.Code)
	}
}

func TestPreparePinnedThreadBody_AssignsNextPosition(t *testing.T) {
	h, mock := setupEngine(t)

	mock.ExpectQuery(`SELECT b.id, b.visibility, b.owner_id`).
		WithArgs(pinnedTestThread).
		WillReturnRows(sqlmock.NewRows([]string{"id", "visibility", "owner_id"}).
			AddRow(nil, nil, nil))
	mock.ExpectQuery(`SELECT position FROM profile_pinned_threads`).
		WithArgs(pinnedTestViewer, pinnedTestThread).
		WillReturnRows(sqlmock.NewRows([]string{"position"}))
	mock.ExpectQuery(`SELECT COUNT\(\*\) FROM profile_pinned_threads`).
		WithArgs(pinnedTestViewer).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(1))
	mock.ExpectQuery(`SELECT MAX\(position\) FROM profile_pinned_threads`).
		WithArgs(pinnedTestViewer).
		WillReturnRows(sqlmock.NewRows([]string{"max"}).AddRow(2))

	c, _ := newRequestContext("POST", "/api/v1/profile_pinned_threads", nil, &auth.Claims{UserID: pinnedTestViewer})
	data := map[string]interface{}{"thread_id": pinnedTestThread}

	if !preparePinnedThreadBody(h, c, "profile_pinned_threads", "POST", data) {
		t.Fatal("expected the guard to accept the pin")
	}
	if data["position"] != 3 {
		t.Fatalf("position = %v, want 3", data["position"])
	}
}

// A re-pin keeps the existing position and skips the cap (idempotent upsert).
func TestPreparePinnedThreadBody_AlreadyPinnedKeepsPosition(t *testing.T) {
	h, mock := setupEngine(t)

	mock.ExpectQuery(`SELECT b.id, b.visibility, b.owner_id`).
		WithArgs(pinnedTestThread).
		WillReturnRows(sqlmock.NewRows([]string{"id", "visibility", "owner_id"}).
			AddRow(nil, nil, nil))
	mock.ExpectQuery(`SELECT position FROM profile_pinned_threads`).
		WithArgs(pinnedTestViewer, pinnedTestThread).
		WillReturnRows(sqlmock.NewRows([]string{"position"}).AddRow(2))

	c, _ := newRequestContext("POST", "/api/v1/profile_pinned_threads", nil, &auth.Claims{UserID: pinnedTestViewer})
	data := map[string]interface{}{"thread_id": pinnedTestThread}

	if !preparePinnedThreadBody(h, c, "profile_pinned_threads", "POST", data) {
		t.Fatal("expected the guard to accept a re-pin")
	}
	if data["position"] != 2 {
		t.Fatalf("position = %v, want the existing 2", data["position"])
	}
}

func TestUpsertPinnedThread_BuildsIdempotentStatement(t *testing.T) {
	query, args, ok := upsertPinnedThread(map[string]interface{}{
		"user_id":   pinnedTestViewer,
		"thread_id": pinnedTestThread,
		"position":  2,
	})
	if !ok {
		t.Fatal("expected a statement")
	}
	if !strings.Contains(query, "ON CONFLICT (user_id, thread_id)") {
		t.Fatalf("expected an idempotent upsert, got %s", query)
	}
	if len(args) != 3 || args[0] != pinnedTestViewer || args[1] != pinnedTestThread || args[2] != 2 {
		t.Fatalf("unexpected args: %v", args)
	}
	if _, _, ok := upsertPinnedThread(map[string]interface{}{"thread_id": pinnedTestThread}); ok {
		t.Fatal("expected the builder to refuse a missing user_id")
	}
}
