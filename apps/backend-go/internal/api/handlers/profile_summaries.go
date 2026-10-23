package handlers

import (
	"database/sql"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/gomo6/backend/internal/auth"
	"github.com/gomo6/backend/internal/crud"
	"github.com/gomo6/backend/internal/httpx"
	"github.com/gomo6/backend/internal/metrics"
	"github.com/gomo6/backend/internal/models"
	"github.com/gomo6/backend/internal/privacy"
	profilepkg "github.com/gomo6/backend/internal/profiles"
	"github.com/gomo6/backend/internal/publicid"
	"github.com/google/uuid"
	"github.com/lib/pq"
)

// maxProfileSummaryIDs caps one batch. The frontend batches every author on a
// screen; 100 covers any realistic feed/thread page while keeping the URL under
// the usual 8 KB request-line limit (a UUID is 36 bytes).
const maxProfileSummaryIDs = 100

// ProfileSummary is the display projection behind every UserBadge/AdminBadge:
// identity fields, the public customization, and the one role-derived flag the
// UI needs. It deliberately carries no email, privacy toggles or owner-only
// columns.
//
// Roles is populated only for the viewer's own row (the header/menu needs the
// full role set). For everyone else is_admin is enough — returning a list of
// every author's roles would expose more than the badge ever shows.
type ProfileSummary struct {
	ID              string                 `json:"id"`
	PublicID        *int64                 `json:"public_id"`
	Username        string                 `json:"username"`
	DisplayName     *string                `json:"display_name"`
	AvatarURL       *string                `json:"avatar_url"`
	NicknameEmojiID *string                `json:"nickname_emoji_id"`
	IsAdmin         bool                   `json:"is_admin"`
	Roles           []string               `json:"roles,omitempty"`
	Customization   map[string]interface{} `json:"customization"`
}

// GetProfileSummaries returns the public display data for up to 100 users in
// one request. It replaces the per-author triple of
// /profiles?id=eq.… + /user_roles?user_id=eq.… + /users/:id/customization that
// every rendered badge used to issue (an HTTP N+1 measured at ~70% of the
// production request volume).
//
// ids accepts a comma-separated list of UUIDs and/or public numbers, so a
// /profile/<n> link batches exactly like a UUID author. Unknown ids are simply
// absent from the response; malformed tokens are a 400.
//
// GetProfileSummaries godoc
// @Summary      Batch profile display data
// @Description  Public profile + customization + admin flag for up to 100 users
// @Tags         Profiles
// @Produce      json
// @Param        ids query string true "Comma-separated UUIDs or public ids"
// @Success      200 {object} models.APIResponse{data=[]ProfileSummary}
// @Router       /profiles/summary [get]
func (h *ProfilesHandler) GetProfileSummaries(c *gin.Context) {
	raw := strings.TrimSpace(c.Query("ids"))
	if raw == "" {
		c.JSON(http.StatusBadRequest, models.ErrorResponse("ids parameter required"))
		return
	}

	parts := strings.Split(raw, ",")
	if len(parts) > maxProfileSummaryIDs {
		c.JSON(http.StatusBadRequest, models.ErrorResponse("too many ids (max 100)"))
		return
	}

	uuids := make([]string, 0, len(parts))
	publicIDs := make([]int64, 0, len(parts))
	seenUUID := make(map[string]struct{}, len(parts))
	seenPublic := make(map[int64]struct{}, len(parts))

	for _, part := range parts {
		token := strings.TrimSpace(part)
		if token == "" {
			continue
		}
		if parsed, err := uuid.Parse(token); err == nil {
			normalized := parsed.String()
			if _, dup := seenUUID[normalized]; !dup {
				seenUUID[normalized] = struct{}{}
				uuids = append(uuids, normalized)
			}
			continue
		}
		if n, ok := publicid.Parse(token); ok {
			if _, dup := seenPublic[n]; !dup {
				seenPublic[n] = struct{}{}
				publicIDs = append(publicIDs, n)
			}
			continue
		}
		c.JSON(http.StatusBadRequest, models.ErrorResponse("Invalid user id: "+token))
		return
	}

	if len(uuids) == 0 && len(publicIDs) == 0 {
		c.JSON(http.StatusBadRequest, models.ErrorResponse("ids parameter required"))
		return
	}

	rows, err := h.db.Query(`
		SELECT u.id::text, u.public_id, u.username, u.display_name, u.avatar_url, u.nickname_emoji_id
		FROM users u
		WHERE u.id = ANY($1::uuid[]) OR u.public_id = ANY($2::bigint[])
		LIMIT $3`,
		pq.Array(uuids), pq.Array(publicIDs), maxProfileSummaryIDs)
	if err != nil {
		httpx.ServerError(c, "handler error", err)
		return
	}
	defer rows.Close()

	summaries := make([]ProfileSummary, 0, len(uuids)+len(publicIDs))
	resolvedIDs := make([]string, 0, len(uuids)+len(publicIDs))
	for rows.Next() {
		var s ProfileSummary
		var publicID sql.NullInt64
		var displayName, avatarURL, nicknameEmojiID sql.NullString
		if err := rows.Scan(&s.ID, &publicID, &s.Username, &displayName, &avatarURL, &nicknameEmojiID); err != nil {
			httpx.ServerError(c, "handler error", err)
			return
		}
		if publicID.Valid {
			v := publicID.Int64
			s.PublicID = &v
		}
		if displayName.Valid {
			v := displayName.String
			s.DisplayName = &v
		}
		if avatarURL.Valid {
			v := avatarURL.String
			s.AvatarURL = &v
		}
		if nicknameEmojiID.Valid {
			v := nicknameEmojiID.String
			s.NicknameEmojiID = &v
		}
		summaries = append(summaries, s)
		resolvedIDs = append(resolvedIDs, s.ID)
	}
	if err := rows.Err(); err != nil {
		httpx.ServerError(c, "handler error", err)
		return
	}

	// The caller may have mixed UUIDs and public numbers, and a private profile
	// can hide its avatar. Resolve visibility in one batch (the same helper
	// GetProfiles uses) rather than leaking a hidden avatar through the badge.
	var viewerID string
	if claims, exists := c.Get("claims"); exists {
		if uc, ok := claims.(*auth.Claims); ok {
			viewerID = uc.UserID
		}
	}

	visibility, err := privacy.ResolveProfileVisibilityBatch(h.db, viewerID, resolvedIDs)
	if err != nil {
		httpx.ServerError(c, "handler error", err)
		return
	}

	for i := range summaries {
		if vis, ok := visibility[summaries[i].ID]; ok && vis.HideAvatar {
			summaries[i].AvatarURL = nil
		}
	}

	// Guests see no admin badge today (the old per-user roles request was
	// skipped for them), so skip the query entirely and leave is_admin=false.
	if viewerID != "" && len(resolvedIDs) > 0 {
		rolesByUser := make(map[string][]string, len(resolvedIDs))
		roleRows, err := h.db.Query(
			`SELECT user_id::text, role FROM user_roles WHERE user_id = ANY($1::uuid[])`,
			pq.Array(resolvedIDs),
		)
		if err != nil {
			httpx.ServerError(c, "handler error", err)
			return
		}
		for roleRows.Next() {
			var uid, role string
			if err := roleRows.Scan(&uid, &role); err != nil {
				roleRows.Close()
				httpx.ServerError(c, "handler error", err)
				return
			}
			rolesByUser[uid] = append(rolesByUser[uid], role)
		}
		if err := roleRows.Err(); err != nil {
			roleRows.Close()
			httpx.ServerError(c, "handler error", err)
			return
		}
		roleRows.Close()

		for i := range summaries {
			roles := rolesByUser[summaries[i].ID]
			for _, role := range roles {
				if role == "admin" {
					summaries[i].IsAdmin = true
					break
				}
			}
			// Only the viewer may learn their own full role set; everyone else
			// gets the boolean the badge needs.
			if summaries[i].ID == viewerID {
				summaries[i].Roles = roles
			}
		}
	}

	if len(resolvedIDs) > 0 {
		customizationByUser, err := h.loadPublicCustomizations(resolvedIDs)
		if err != nil {
			httpx.ServerError(c, "handler error", err)
			return
		}
		for i := range summaries {
			summaries[i].Customization = customizationByUser[summaries[i].ID]
		}
	}

	metrics.App.ProfileSummaryRequested(len(summaries))
	c.JSON(http.StatusOK, models.SuccessResponse(summaries))
}

// loadPublicCustomizations reads and sanitizes the public display columns for a
// batch of users in one query. Sanitization is the same path GetUserCustomization
// uses, so a legacy row with hostile CSS is neutralized identically here.
func (h *ProfilesHandler) loadPublicCustomizations(userIDs []string) (map[string]map[string]interface{}, error) {
	rows, err := h.db.Query(
		`SELECT user_id::text, `+publicCustomizationColumns+`
		 FROM profile_customization WHERE user_id = ANY($1::uuid[])`,
		pq.Array(userIDs),
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := make(map[string]map[string]interface{}, len(userIDs))
	for rows.Next() {
		row, err := crud.ScanRowToMap(rows)
		if err != nil {
			return nil, err
		}
		uid, _ := row["user_id"].(string)
		delete(row, "user_id")
		profilepkg.SanitizeProfileCustomizationRow(row)
		if uid != "" {
			result[uid] = row
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}
