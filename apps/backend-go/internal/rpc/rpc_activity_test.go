package rpc

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/gomo6/backend/internal/auth"
	"github.com/gomo6/backend/internal/testutil"
)

// ─── GetGomoSubChannelActivity ──────────────────────────────────────────────

func TestGetGomoSubChannelActivity_Success(t *testing.T) {
	h, mock := setupRPCHandler(t)

	viewer := "770e8400-e29b-41d4-a716-446655443333"
	boardID := "550e8400-e29b-41d4-a716-446655440000"
	channelID := "660e8400-e29b-41d4-a716-446655441111"
	// Two channels come from the board; only the one the viewer can read must
	// survive into the response.
	mock.ExpectQuery(`(?s)SELECT ch\.id,.*FROM channels ch WHERE ch\.board_id = \$1`).
		WithArgs(boardID).
		WillReturnRows(sqlmock.NewRows([]string{"id", "last_activity_at"}).
			AddRow(channelID, time.Now()).
			AddRow("660e8400-e29b-41d4-a716-446655442222", time.Now()))
	// channelaccess.CanReadChannel per channel: first readable, second denied.
	mock.ExpectQuery(`(?s)SELECT EXISTS\(.*`).
		WithArgs(channelID, viewer).
		WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(true))
	mock.ExpectQuery(`(?s)SELECT EXISTS\(.*`).
		WithArgs("660e8400-e29b-41d4-a716-446655442222", viewer).
		WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(false))

	c, w := testutil.NewRPCGETContext(map[string]string{"_board_id": boardID})
	c.Set("claims", &auth.Claims{UserID: viewer})
	h.GetGomoSubChannelActivity(c)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp struct {
		Data []ChannelActivityItem `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to parse: %v", err)
	}
	if len(resp.Data) != 1 {
		t.Fatalf("expected 1 readable channel, got %+v", resp.Data)
	}
	if len(resp.Data) > 0 && resp.Data[0].ChannelID != channelID {
		t.Fatalf("expected readable channel %s, got %s", channelID, resp.Data[0].ChannelID)
	}
}

func TestGetGomoSubChannelActivity_MissingParam(t *testing.T) {
	h, _ := setupRPCHandler(t)

	c, w := testutil.NewRPCGETContext(map[string]string{})
	c.Set("claims", &auth.Claims{UserID: "viewer"})
	h.GetGomoSubChannelActivity(c)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestGetGomoSubChannelActivity_InvalidUUID(t *testing.T) {
	h, _ := setupRPCHandler(t)

	c, w := testutil.NewRPCGETContext(map[string]string{"_board_id": "not-a-uuid"})
	c.Set("claims", &auth.Claims{UserID: "viewer"})
	h.GetGomoSubChannelActivity(c)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestGetGomoSubChannelActivity_DBError(t *testing.T) {
	h, mock := setupRPCHandler(t)

	boardID := "550e8400-e29b-41d4-a716-446655440000"
	mock.ExpectQuery(`(?s)SELECT ch\.id,.*FROM channels ch WHERE ch\.board_id = \$1`).
		WithArgs(boardID).
		WillReturnError(sqlmock.ErrCancelled)

	c, w := testutil.NewRPCGETContext(map[string]string{"_board_id": boardID})
	c.Set("claims", &auth.Claims{UserID: "viewer"})
	h.GetGomoSubChannelActivity(c)

	if w.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500, got %d", w.Code)
	}
}
