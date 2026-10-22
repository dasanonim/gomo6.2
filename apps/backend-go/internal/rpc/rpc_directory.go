package rpc

import (
	"net/http"

	"github.com/gomo6/backend/internal/httpx"
	"github.com/gomo6/backend/internal/models"

	"github.com/gin-gonic/gin"
)

// ─── GomoSub directory ──────────────────────────────────────────────────────

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
