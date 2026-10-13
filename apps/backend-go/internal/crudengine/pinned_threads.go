package crudengine

import (
	"database/sql"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/gomo6/backend/internal/cache"
	"github.com/gomo6/backend/internal/crud"
	"github.com/gomo6/backend/internal/httpx"
	"github.com/gomo6/backend/internal/models"
	"github.com/gomo6/backend/internal/privacy"
	"github.com/google/uuid"
)

// MaxPinnedProfileThreads is the hard cap on «Закреплённые темы» per profile.
// The block on the profile page shows at most this many rows; the write path
// refuses a fourth pin instead of silently evicting the oldest (the UI disables
// the menu item at the cap).
const MaxPinnedProfileThreads = 3

// ─── Pinned profile threads («Закреплённые темы») ───────────────────────────
//
// A profile owner pins up to MaxPinnedProfileThreads threads (their own or
// somebody else's) and they render as a compact list between the identity panel
// and the tab bar. The table is a generic CRUD table (registry entry in
// table_registry.go) with three hooks here:
//
//   - handleProfilePinnedThreadsGet — the read. Gates on the profile owner's
//     privacy exactly like the threads tab (privacy.CanViewUserContent) and
//     returns only the pin rows ({thread_id, position}); the caller resolves
//     the thread bodies through GET /threads, which is the surface that already
//     enforces board/channel visibility. That split is deliberate: a pin can
//     never widen what a viewer may see, it only orders threads the viewer
//     could already read.
//   - preparePinnedThreadBody — the POST guard: thread existence, board
//     visibility for the caller, the 3-pin cap and the position assignment.
//   - upsertPinnedThread — idempotent INSERT ... ON CONFLICT so a double click
//     (or a re-pin of an already pinned thread) is a no-op instead of a 500
//     from the UNIQUE (user_id, thread_id) constraint.
//   - invalidatePinnedThreadsCache — drop the cached reads after a write.
//
// Ownership (user_id = caller on POST, `user_id = caller` on DELETE) is declared
// in the registry (PostOwner/WriteOwner: OwnSingle) and enforced by the generic
// dispatchers — nothing here needs to re-check it.

// handleProfilePinnedThreadsGet serves
// GET /api/v1/profile_pinned_threads?user_id=eq.<uuid>&order=position.asc.
//
// The profile's privacy is the same gate as the threads tab: a private profile
// hides its pinned threads from non-friends (and guests) — the response is an
// empty list rather than an error, so the block simply does not render.
func (h *Engine) handleProfilePinnedThreadsGet(c *gin.Context) {
	ownerID := strings.TrimPrefix(c.Query("user_id"), "eq.")
	if ownerID == "" {
		c.JSON(http.StatusBadRequest, models.ErrorResponse("user_id filter is required"))
		return
	}
	if _, err := uuid.Parse(ownerID); err != nil {
		c.JSON(http.StatusBadRequest, models.ErrorResponse("Invalid user ID format"))
		return
	}

	viewerID := httpx.AuthenticatedUserID(c)
	visible, err := privacy.CanViewUserContent(h.db, viewerID, ownerID)
	if err != nil {
		httpx.ServerError(c, "check profile privacy", err)
		return
	}
	if !visible {
		c.JSON(http.StatusOK, models.SuccessResponse([]map[string]interface{}{}))
		return
	}

	rows, err := h.db.Query(`
		SELECT p.thread_id, p.position, p.created_at
		FROM profile_pinned_threads p
		JOIN threads t ON t.id = p.thread_id
		WHERE p.user_id = $1
		ORDER BY p.position ASC, p.created_at ASC
		LIMIT $2`, ownerID, MaxPinnedProfileThreads)
	if err != nil {
		httpx.ServerError(c, "database error", err)
		return
	}
	defer rows.Close()

	results := []map[string]interface{}{}
	columns, _ := rows.Columns()
	for rows.Next() {
		values := make([]interface{}, len(columns))
		valuePtrs := make([]interface{}, len(columns))
		for i := range columns {
			valuePtrs[i] = &values[i]
		}
		if err := rows.Scan(valuePtrs...); err != nil {
			httpx.ServerError(c, "database error", err)
			return
		}
		row := make(map[string]interface{}, len(columns))
		for i, col := range columns {
			row[col] = crud.DecodeColumnValue(values[i])
		}
		results = append(results, row)
	}
	if err := rows.Err(); err != nil {
		httpx.ServerError(c, "database error", err)
		return
	}

	c.JSON(http.StatusOK, models.SuccessResponse(results))
}

// preparePinnedThreadBody is the POST body guard for profile_pinned_threads.
// Runs before ownership forcing, so the caller is read from the context (user_id
// is injected afterwards by OwnSingle).
func preparePinnedThreadBody(h *Engine, c *gin.Context, tableName, method string, data map[string]interface{}) bool {
	// Only POST (pin) is routed for this table; guard defensively so a future
	// PUT route cannot skip the cap.
	if method != "POST" {
		return true
	}

	callerID := httpx.AuthenticatedUserID(c)
	if callerID == "" {
		c.JSON(http.StatusUnauthorized, models.ErrorResponse("Not authenticated"))
		return false
	}

	threadID := strings.TrimSpace(crud.WallResultString(data["thread_id"]))
	if threadID == "" {
		c.JSON(http.StatusBadRequest, models.ErrorResponse("thread_id is required"))
		return false
	}
	if _, err := uuid.Parse(threadID); err != nil {
		c.JSON(http.StatusBadRequest, models.ErrorResponse("Invalid thread ID format"))
		return false
	}

	// The thread must exist. Its board must be visible to the caller (a private
	// board requires ownership or membership) so a pin cannot reference a board
	// the caller cannot open — the read path drops invisible rows anyway, but
	// rejecting here keeps the pin list honest for its owner.
	var boardID, boardVisibility, boardOwner sql.NullString
	err := h.db.QueryRow(`
		SELECT b.id, b.visibility, b.owner_id
		FROM threads t
		LEFT JOIN boards b ON b.id = t.board_id
		WHERE t.id = $1`, threadID).Scan(&boardID, &boardVisibility, &boardOwner)
	if err == sql.ErrNoRows {
		c.JSON(http.StatusNotFound, models.ErrorResponse("Thread not found"))
		return false
	}
	if err != nil {
		httpx.ServerError(c, "lookup thread", err)
		return false
	}
	if boardVisibility.Valid && boardVisibility.String == "private" {
		allowed := boardOwner.Valid && boardOwner.String == callerID
		if !allowed {
			var member bool
			if err := h.db.QueryRow(
				`SELECT EXISTS(SELECT 1 FROM gomosub_memberships WHERE board_id = $1 AND user_id = $2)`,
				boardID.String, callerID).Scan(&member); err != nil {
				httpx.ServerError(c, "check board access", err)
				return false
			}
			allowed = member
		}
		if !allowed {
			c.JSON(http.StatusForbidden, models.ErrorResponse("Board is private"))
			return false
		}
	}

	// Already pinned → keep the existing position (the upsert is a no-op update)
	// and skip the cap so a double click never fails.
	var existingPosition sql.NullInt32
	err = h.db.QueryRow(
		`SELECT position FROM profile_pinned_threads WHERE user_id = $1 AND thread_id = $2`,
		callerID, threadID).Scan(&existingPosition)
	if err != nil && err != sql.ErrNoRows {
		httpx.ServerError(c, "lookup pinned thread", err)
		return false
	}
	if err == nil {
		data["position"] = int(existingPosition.Int32)
		return true
	}

	var count int
	if err := h.db.QueryRow(
		`SELECT COUNT(*) FROM profile_pinned_threads WHERE user_id = $1`, callerID).Scan(&count); err != nil {
		httpx.ServerError(c, "count pinned threads", err)
		return false
	}
	if count >= MaxPinnedProfileThreads {
		c.JSON(http.StatusConflict, models.ErrorResponse("Pinned threads limit reached"))
		return false
	}

	var maxPosition sql.NullInt32
	if err := h.db.QueryRow(
		`SELECT MAX(position) FROM profile_pinned_threads WHERE user_id = $1`, callerID).Scan(&maxPosition); err != nil && err != sql.ErrNoRows {
		httpx.ServerError(c, "lookup pinned thread order", err)
		return false
	}
	position := 1
	if maxPosition.Valid {
		position = int(maxPosition.Int32) + 1
	}
	data["position"] = position
	return true
}

// upsertPinnedThread builds the idempotent pin statement. A re-pin keeps the
// existing position (DO UPDATE with a self-assignment) so the response always
// carries the row instead of tripping the UNIQUE constraint.
func upsertPinnedThread(data map[string]interface{}) (query string, args []interface{}, ok bool) {
	userID := crud.WallResultString(data["user_id"])
	threadID := crud.WallResultString(data["thread_id"])
	if userID == "" || threadID == "" {
		return "", nil, false
	}

	position := 0
	switch v := data["position"].(type) {
	case int:
		position = v
	case int64:
		position = int(v)
	case float64:
		position = int(v)
	}

	return `INSERT INTO profile_pinned_threads (user_id, thread_id, position)
	        VALUES ($1, $2, $3)
	        ON CONFLICT (user_id, thread_id)
	        DO UPDATE SET position = profile_pinned_threads.position
	        RETURNING *`, []interface{}{userID, threadID, position}, true
}

// invalidatePinnedThreadsCache drops the cached pinned-thread reads of the
// profile owner after a pin/unpin. The read is served by the REST data cache
// (data:/api/v1/...), so the profile block would otherwise show a stale list for
// up to the cache TTL.
func invalidatePinnedThreadsCache(h *Engine, _ *gin.Context, result map[string]interface{}) {
	if h.redis == nil {
		return
	}
	if userID := crud.WallResultString(result["user_id"]); userID != "" {
		cache.InvalidateByPattern(h.redis, "data:/api/v1/profile_pinned_threads*user_id=eq."+userID+"*")
		cache.InvalidateByPattern(h.redis, "data:/api/v1/profile_pinned_threads*user_id="+userID+"*")
	}
}
