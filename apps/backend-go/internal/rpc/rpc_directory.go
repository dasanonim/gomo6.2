package rpc

import (
	"net/http"
	"time"

	"github.com/gomo6/backend/internal/channelaccess"
	"github.com/gomo6/backend/internal/httpx"
	"github.com/gomo6/backend/internal/models"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// ─── GomoSub directory ──────────────────────────────────────────────────────

// ChannelActivityItem is one accessible channel's last activity timestamp —
// feeds the sidebar unread dots (localStorage last-seen vs server time).
type ChannelActivityItem struct {
	ChannelID      string `json:"channel_id"`
	LastActivityAt string `json:"last_activity_at"`
}

// GetGomoSubChannelActivity returns the last activity time of every channel in
// a board the viewer can READ (private channels without read access are
// omitted — the sidebar must not leak activity it cannot open).
//
// GetGomoSubChannelActivity godoc
// @Summary      GomoSub channel activity
// @Description  Last activity timestamp per readable channel of a board
// @Tags         RPC
// @Produce      json
// @Param        _board_id query string true "Board ID"
// @Success      200 {object} models.APIResponse
// @Router       /rpc/get_gomosub_channel_activity [get]
func (h *RPCHandler) GetGomoSubChannelActivity(c *gin.Context) {
	claims, ok := httpx.BearerClaims(c)
	if !ok {
		c.JSON(http.StatusUnauthorized, models.ErrorResponse("Authorization required"))
		return
	}
	boardID := c.Query("_board_id")
	if boardID == "" {
		c.JSON(http.StatusBadRequest, models.ErrorResponse("_board_id parameter required"))
		return
	}
	if _, err := uuid.Parse(boardID); err != nil {
		c.JSON(http.StatusBadRequest, models.ErrorResponse("Invalid board ID"))
		return
	}

	const query = `
		SELECT ch.id,
		       NULLIF(GREATEST(
		         COALESCE((SELECT max(m.created_at) FROM channel_messages m WHERE m.channel_id = ch.id AND m.deleted_at IS NULL), to_timestamp(0)),
		         COALESCE((SELECT max(t.updated_at) FROM threads t WHERE t.channel_id = ch.id), to_timestamp(0))
		       ), to_timestamp(0)) AS last_activity_at
		FROM channels ch
		WHERE ch.board_id = $1
	`

	rows, err := h.db.Query(query, boardID)
	if err != nil {
		httpx.ServerError(c, "handler error", err)
		return
	}
	defer rows.Close()

	items := []ChannelActivityItem{}
	type rowTS struct {
		id string
		at *time.Time
	}
	var rowsBuf []rowTS
	for rows.Next() {
		var r rowTS
		if err := rows.Scan(&r.id, &r.at); err != nil {
			httpx.ServerError(c, "handler error", err)
			return
		}
		rowsBuf = append(rowsBuf, r)
	}
	if err := rows.Err(); err != nil {
		httpx.ServerError(c, "handler error", err)
		return
	}

	for _, r := range rowsBuf {
		canRead, err := channelaccess.CanReadChannel(h.db, claims.UserID, r.id)
		if err != nil {
			// Fail closed for this channel: skip the row rather than 500.
			continue
		}
		if !canRead || r.at == nil {
			// Unreadable or content-free → never unread.
			continue
		}
		items = append(items, ChannelActivityItem{ChannelID: r.id, LastActivityAt: r.at.UTC().Format(time.RFC3339)})
	}

	c.JSON(http.StatusOK, models.SuccessResponse(items))
}

// GomoSubDirectoryItem is one public community in the /g catalog. Member and
// channel counts come from correlated subqueries so the whole catalog is a
// single request instead of the old N+1 head-counts per board.
type GomoSubDirectoryItem struct {
	ID           string   `json:"id"`
	Slug         string   `json:"slug"`
	Name         string   `json:"name"`
	Description  *string  `json:"description"`
	CoverImage   *string  `json:"cover_image_url"`
	AvatarURL    *string  `json:"gomosub_avatar_url"`
	Tags         []string `json:"gomosub_tags"`
	Visibility   string   `json:"visibility"`
	CreatedAt    string   `json:"created_at"`
	MemberCount  int64    `json:"member_count"`
	ChannelCount int64    `json:"channel_count"`
	Joined       bool     `json:"joined"`
}

// GetGomoSubsDirectory returns every public gomosub with its member/channel
// counts for the /g catalog page. Anonymous callers get the same rows with
// joined=false; with a token, joined reflects the viewer's memberships.
//
// GetGomoSubsDirectory godoc
// @Summary      GomoSub directory
// @Description  Public catalog of gomosubs with member/channel counts
// @Tags         RPC
// @Produce      json
// @Success      200 {object} models.APIResponse
// @Router       /rpc/gomosubs_directory [get]
func (h *RPCHandler) GetGomoSubsDirectory(c *gin.Context) {
	viewerID := rpcLikesViewerID(c)

	const query = `
		SELECT b.id, b.slug, b.name, b.description, b.cover_image_url,
		       b.gomosub_avatar_url, b.gomosub_tags, b.visibility, b.created_at,
		       (SELECT count(*) FROM gomosub_memberships m WHERE m.board_id = b.id) AS member_count,
		       (SELECT count(*) FROM channels ch WHERE ch.board_id = b.id) AS channel_count,
		       EXISTS(SELECT 1 FROM gomosub_memberships jm WHERE jm.board_id = b.id AND jm.user_id = $1) AS joined
		FROM boards b
		WHERE b.is_gomosub = true AND b.visibility = 'public'
		ORDER BY b.created_at DESC
	`

	var viewerArg any
	if viewerID == "" {
		// $1 never matches — EXISTS subquery is skipped by the planner for
		// every row once the value is NULL.
		viewerArg = nil
	} else {
		viewerArg = viewerID
	}

	rows, err := h.db.Query(query, viewerArg)
	if err != nil {
		httpx.ServerError(c, "handler error", err)
		return
	}
	defer rows.Close()

	items := []GomoSubDirectoryItem{}
	for rows.Next() {
		var it GomoSubDirectoryItem
		var tags models.JSONB // NULL → nil
		if err := rows.Scan(
			&it.ID, &it.Slug, &it.Name, &it.Description, &it.CoverImage,
			&it.AvatarURL, &tags, &it.Visibility, &it.CreatedAt,
			&it.MemberCount, &it.ChannelCount, &it.Joined,
		); err != nil {
			httpx.ServerError(c, "handler error", err)
			return
		}
		it.Tags = []string{}
		for _, t := range tags {
			if s, ok := t.(string); ok {
				it.Tags = append(it.Tags, s)
			}
		}
		items = append(items, it)
	}
	if err := rows.Err(); err != nil {
		httpx.ServerError(c, "handler error", err)
		return
	}

	c.JSON(http.StatusOK, models.SuccessResponse(items))
}
