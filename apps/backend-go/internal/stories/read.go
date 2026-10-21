package stories

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gomo6/backend/internal/httpx"
	"github.com/gomo6/backend/internal/models"
	"github.com/gomo6/backend/internal/storyaccess"
	"github.com/lib/pq"
)

// storyColumns is the one projection every read uses, so a story looks
// identical whether it came from the rail, a profile, the archive or a deep
// link. The viewer is always bind argument $1 (their own view/reaction state).
const storyColumns = `
	s.id::text, s.owner_type,
	COALESCE(s.user_id::text, s.board_id::text) AS owner_id,
	s.author_id::text, au.username, au.display_name, au.avatar_url, au.avatar_animated,
	s.kind, s.media_key, s.preview_key, s.thumb_hash, s.media_width, s.media_height,
	s.media_duration, s.media_content_type, s.text, s.text_style, s.privacy, s.is_pinned,
	s.views_count, s.created_at, s.expires_at,
	(v.story_id IS NOT NULL) AS is_viewed,
	my.emoji AS my_reaction,
	(SELECT COUNT(*) FROM story_reactions srn WHERE srn.story_id = s.id) AS reactions_count`

const storyFrom = `
FROM stories s
JOIN users au ON au.id = s.author_id
LEFT JOIN story_views v ON v.story_id = s.id AND v.viewer_id = $1
LEFT JOIN story_reactions my ON my.story_id = s.id AND my.user_id = $1`

type rowScanner interface{ Scan(...any) error }

// scanStory reads the storyColumns projection. IsOwn is filled by the caller,
// which is the only place that knows the viewer.
func scanStory(row rowScanner) (Story, error) {
	var (
		st          Story
		username    string
		displayName sql.NullString
		avatarURL   sql.NullString
		animated    bool
		mediaKey    sql.NullString
		previewKey  sql.NullString
		thumbHash   sql.NullString
		width       sql.NullInt64
		height      sql.NullInt64
		duration    sql.NullFloat64
		contentType sql.NullString
		style       []byte
		myReaction  sql.NullString
	)
	err := row.Scan(
		&st.ID, &st.OwnerType, &st.OwnerID, &st.AuthorID,
		&username, &displayName, &avatarURL, &animated,
		&st.Kind, &mediaKey, &previewKey, &thumbHash, &width, &height,
		&duration, &contentType, &st.Text, &style, &st.Privacy, &st.IsPinned,
		&st.ViewsCount, &st.CreatedAt, &st.ExpiresAt,
		&st.IsViewed, &myReaction, &st.ReactionsCount,
	)
	if err != nil {
		return st, err
	}
	st.Author = &Author{
		ID:             st.AuthorID,
		Username:       username,
		DisplayName:    nullStringPtr(displayName),
		AvatarURL:      nullStringPtr(avatarURL),
		AvatarAnimated: animated,
	}
	st.MediaKey = nullStringPtr(mediaKey)
	st.PreviewKey = nullStringPtr(previewKey)
	st.ThumbHash = nullStringPtr(thumbHash)
	if width.Valid {
		w := int(width.Int64)
		st.Width = &w
	}
	if height.Valid {
		hgt := int(height.Int64)
		st.Height = &hgt
	}
	if duration.Valid {
		d := duration.Float64
		st.Duration = &d
	}
	st.ContentType = nullStringPtr(contentType)
	if len(style) > 0 {
		st.TextStyle = json.RawMessage(style)
	}
	st.MyReaction = nullStringPtr(myReaction)
	return st, nil
}

// isOwnStory reports whether the viewer controls this story as a person: the
// author always, plus the personal owner (which is the same user).
func isOwnStory(st Story, viewerID string) bool {
	return st.AuthorID == viewerID || (st.OwnerType == OwnerUser && st.OwnerID == viewerID)
}

func (h *Handler) scanStories(rows *sql.Rows, viewerID string) ([]Story, error) {
	defer rows.Close()
	list := make([]Story, 0, 16)
	for rows.Next() {
		st, err := scanStory(rows)
		if err != nil {
			return nil, err
		}
		st.IsOwn = isOwnStory(st, viewerID)
		list = append(list, st)
	}
	return list, rows.Err()
}

// rankedScanner appends a discard target for the trailing ROW_NUMBER() column
// of the rail projection, so the shared scanStory stays identical for both.
type rankedScanner struct {
	row  rowScanner
	rank *int64
}

func (r rankedScanner) Scan(dest ...any) error {
	return r.row.Scan(append(dest, r.rank)...)
}

func (h *Handler) scanStoriesWithRank(rows *sql.Rows, viewerID string) ([]Story, error) {
	defer rows.Close()
	list := make([]Story, 0, 32)
	for rows.Next() {
		var rank int64
		st, err := scanStory(rankedScanner{row: rows, rank: &rank})
		if err != nil {
			return nil, err
		}
		st.IsOwn = isOwnStory(st, viewerID)
		list = append(list, st)
	}
	return list, rows.Err()
}

// loadUserOwners builds the owner cards for personal groups in one query.
func (h *Handler) loadUserOwners(ids []string) (map[string]*Owner, error) {
	out := make(map[string]*Owner, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := h.db.Query(`
		SELECT id::text, username, display_name, avatar_url, avatar_animated
		FROM users WHERE id = ANY($1::uuid[])`, pq.Array(ids))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			id          string
			username    string
			displayName sql.NullString
			avatarURL   sql.NullString
			animated    bool
		)
		if err := rows.Scan(&id, &username, &displayName, &avatarURL, &animated); err != nil {
			return nil, err
		}
		name := username
		if displayName.Valid && displayName.String != "" {
			name = displayName.String
		}
		uname := username
		owner := &Owner{Type: OwnerUser, ID: id, Name: name, Username: &uname, AvatarAnimated: animated}
		owner.AvatarURL = nullStringPtr(avatarURL)
		out[id] = owner
	}
	return out, rows.Err()
}

// loadBoardOwners builds the owner cards for GomoSub groups in one query.
func (h *Handler) loadBoardOwners(ids []string) (map[string]*Owner, error) {
	out := make(map[string]*Owner, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := h.db.Query(`
		SELECT id::text, name, slug, gomosub_avatar_url
		FROM boards WHERE id = ANY($1::uuid[]) AND is_gomosub = true`, pq.Array(ids))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			id        string
			name      string
			slug      string
			avatarURL sql.NullString
		)
		if err := rows.Scan(&id, &name, &slug, &avatarURL); err != nil {
			return nil, err
		}
		s := slug
		owner := &Owner{Type: OwnerGosub, ID: id, Name: name, Slug: &s}
		owner.AvatarURL = nullStringPtr(avatarURL)
		out[id] = owner
	}
	return out, rows.Err()
}

// ─── Rail ───────────────────────────────────────────────────────────────────
// GET /api/v1/stories/rail
//
// The rail is personal: your own live stories, the live stories of everyone you
// follow (subject to each story's audience) and the live stories of the
// GomoSubs you belong to. It is deliberately NOT "every public story" — a
// global firehose would turn the rail into an unmoderated feed and make the
// ring's read/unread order meaningless.

const (
	// railStoryLimit caps the rows read for the rail.
	railStoryLimit = 600
	// perOwnerStoryLimit caps slides per owner in the rail; the rest stay
	// reachable from the profile ring and the archive.
	perOwnerStoryLimit = 30
)

// GetRail godoc
// @Summary      Stories rail
// @Description  Live stories of the viewer, followed users and joined GomoSubs
// @Tags         Stories
// @Produce      json
// @Success      200 {object} models.APIResponse
// @Router       /stories/rail [get]
func (h *Handler) GetRail(c *gin.Context) {
	claims := httpx.EnsureAuth(c)
	if claims == nil {
		return
	}

	query := `
	WITH ranked AS (
		SELECT` + storyColumns + `,
			ROW_NUMBER() OVER (
				PARTITION BY COALESCE(s.user_id::text, s.board_id::text)
				ORDER BY s.created_at DESC
			) AS rn` + storyFrom + `
		WHERE s.deleted_at IS NULL
		  AND s.expires_at > NOW()
		  AND (
			s.user_id = $1::uuid
			OR (s.owner_type = 'user'
			    AND s.user_id IN (SELECT target_id FROM subscriptions WHERE subscriber_id = $1::uuid)
			    AND ` + storyaccess.VisibleCondition("s", "$1") + `)
			OR (s.owner_type = 'gosub'
			    AND s.board_id IN (
					SELECT board_id FROM gomosub_memberships WHERE user_id = $1::uuid
					UNION SELECT id FROM boards WHERE owner_id = $1::uuid AND is_gomosub = true))
		  )
	)
	SELECT * FROM ranked WHERE rn <= ` + strconv.Itoa(perOwnerStoryLimit) + `
	ORDER BY created_at DESC
	LIMIT ` + strconv.Itoa(railStoryLimit)

	rows, err := h.db.Query(query, claims.UserID)
	if err != nil {
		httpx.ServerError(c, "load stories rail", err)
		return
	}
	list, err := h.scanStoriesWithRank(rows, claims.UserID)
	if err != nil {
		httpx.ServerError(c, "scan stories rail", err)
		return
	}
	groups, err := h.groupStories(list, claims.UserID)
	if err != nil {
		httpx.ServerError(c, "group stories rail", err)
		return
	}
	c.JSON(http.StatusOK, models.SuccessResponse(RailResponse{Groups: groups}))
}

// groupStories groups rows (already newest-first) into a rail. Owner order:
// the viewer's own group first, then groups with unread slides, then by the
// most recent slide — the same priority Telegram uses.
func (h *Handler) groupStories(list []Story, viewerID string) ([]Group, error) {
	if len(list) == 0 {
		return []Group{}, nil
	}
	order := make([]string, 0, 16)
	byOwner := make(map[string][]Story, 16)
	var userIDs, boardIDs []string
	seenUser := map[string]bool{}
	seenBoard := map[string]bool{}
	for _, st := range list {
		key := st.OwnerType + ":" + st.OwnerID
		if _, ok := byOwner[key]; !ok {
			order = append(order, key)
			if st.OwnerType == OwnerUser {
				if !seenUser[st.OwnerID] {
					seenUser[st.OwnerID] = true
					userIDs = append(userIDs, st.OwnerID)
				}
			} else if !seenBoard[st.OwnerID] {
				seenBoard[st.OwnerID] = true
				boardIDs = append(boardIDs, st.OwnerID)
			}
		}
		byOwner[key] = append(byOwner[key], st)
	}

	users, err := h.loadUserOwners(userIDs)
	if err != nil {
		return nil, err
	}
	boards, err := h.loadBoardOwners(boardIDs)
	if err != nil {
		return nil, err
	}
	ownerOf := make(map[string]*Owner, len(users)+len(boards))
	for k, v := range users {
		ownerOf[OwnerUser+":"+k] = v
	}
	for k, v := range boards {
		ownerOf[OwnerGosub+":"+k] = v
	}

	groups := make([]Group, 0, len(order))
	for _, key := range order {
		slides := byOwner[key]
		// The rail query walks newest→oldest; a viewer plays oldest→newest.
		for i, j := 0, len(slides)-1; i < j; i, j = i+1, j-1 {
			slides[i], slides[j] = slides[j], slides[i]
		}
		owner := ownerOf[key]
		if owner == nil {
			continue
		}
		hasUnread := false
		for _, st := range slides {
			if !st.IsViewed && !st.IsOwn {
				hasUnread = true
				break
			}
		}
		groups = append(groups, Group{Owner: owner, Stories: slides, HasUnread: hasUnread})
	}

	// The viewer's own group is always first.
	isOwnGroup := func(g Group) bool {
		return g.Owner.Type == OwnerUser && g.Owner.ID == viewerID
	}
	sortGroups(groups, isOwnGroup)
	return groups, nil
}

// sortGroups is a stable insertion sort over at most a few dozen groups.
func sortGroups(groups []Group, own func(Group) bool) {
	for i := 1; i < len(groups); i++ {
		for j := i; j > 0 && groupLess(groups[j], groups[j-1], own); j-- {
			groups[j], groups[j-1] = groups[j-1], groups[j]
		}
	}
}

func groupLess(a, b Group, own func(Group) bool) bool {
	aOwn, bOwn := own(a), own(b)
	if aOwn != bOwn {
		return aOwn
	}
	if a.HasUnread != b.HasUnread {
		return a.HasUnread
	}
	return a.Stories[len(a.Stories)-1].CreatedAt.After(b.Stories[len(b.Stories)-1].CreatedAt)
}

// ─── Per-owner reads ────────────────────────────────────────────────────────

// GetUserStories godoc
// @Summary      Stories of a user
// @Description  Live stories (default), pinned profile highlights (?scope=pinned) or the author's own archive (?scope=archive)
// @Tags         Stories
// @Produce      json
// @Param        userId path  string true  "User ID"
// @Param        scope  query string false "live | pinned | archive" default(live)
// @Success      200 {object} models.APIResponse
// @Router       /stories/user/{userId} [get]
func (h *Handler) GetUserStories(c *gin.Context) {
	claims := httpx.EnsureAuth(c)
	if claims == nil {
		return
	}
	ownerID := c.Param("userId")
	if !isUUID(ownerID) {
		c.JSON(http.StatusBadRequest, models.ErrorResponse("Invalid user_id"))
		return
	}
	scope := strings.TrimSpace(c.DefaultQuery("scope", "live"))
	self := claims.UserID == ownerID

	switch scope {
	case "live", "pinned":
		ok, err := storyaccess.CanViewUserStories(h.db, claims.UserID, ownerID)
		if err != nil {
			httpx.ServerError(c, "check story visibility", err)
			return
		}
		if !ok {
			// Empty, never 403: a private profile must not confirm whether the
			// user posted anything (same contract as threads).
			c.JSON(http.StatusOK, models.SuccessResponse([]Story{}))
			return
		}
	case "archive":
		if !self {
			c.JSON(http.StatusForbidden, models.ErrorResponse("Only the author can read the archive"))
			return
		}
	default:
		c.JSON(http.StatusBadRequest, models.ErrorResponse("Unknown scope"))
		return
	}

	query := "SELECT" + storyColumns + storyFrom + `
		WHERE s.deleted_at IS NULL
		  AND s.owner_type = 'user'
		  AND s.user_id = $2::uuid
		  AND ` + storyaccess.VisibleCondition("s", "$1")
	switch scope {
	case "live":
		query += " AND s.expires_at > NOW()"
	case "pinned":
		// Highlights survive expiry: "keep in profile" is the whole point.
		query += " AND s.is_pinned = true"
	}
	query += " ORDER BY s.created_at ASC"

	rows, err := h.db.Query(query, claims.UserID, ownerID)
	if err != nil {
		httpx.ServerError(c, "load user stories", err)
		return
	}
	list, err := h.scanStories(rows, claims.UserID)
	if err != nil {
		httpx.ServerError(c, "scan user stories", err)
		return
	}
	c.JSON(http.StatusOK, models.SuccessResponse(list))
}

// GetBoardStories godoc
// @Summary      Stories of a GomoSub
// @Description  Live community stories, or the board archive for members allowed to post
// @Tags         Stories
// @Produce      json
// @Param        boardId path  string true  "Board ID"
// @Param        scope   query string false "live | archive" default(live)
// @Success      200 {object} models.APIResponse
// @Router       /stories/board/{boardId} [get]
func (h *Handler) GetBoardStories(c *gin.Context) {
	claims := httpx.EnsureAuth(c)
	if claims == nil {
		return
	}
	boardID := c.Param("boardId")
	if !isUUID(boardID) {
		c.JSON(http.StatusBadRequest, models.ErrorResponse("Invalid board_id"))
		return
	}
	scope := strings.TrimSpace(c.DefaultQuery("scope", "live"))

	if scope == "archive" {
		ok, err := storyaccess.CanPostBoardStories(h.db, claims.UserID, boardID)
		if err != nil {
			httpx.ServerError(c, "check story archive access", err)
			return
		}
		if !ok {
			c.JSON(http.StatusForbidden, models.ErrorResponse("Only story authors of this GomoSub can read the archive"))
			return
		}
	} else if scope != "live" {
		c.JSON(http.StatusBadRequest, models.ErrorResponse("Unknown scope"))
		return
	}

	query := "SELECT" + storyColumns + storyFrom + `
		WHERE s.deleted_at IS NULL
		  AND s.owner_type = 'gosub'
		  AND s.board_id = $2::uuid
		  AND ` + storyaccess.VisibleCondition("s", "$1")
	if scope == "live" {
		query += " AND s.expires_at > NOW()"
	}
	query += " ORDER BY s.created_at ASC"

	rows, err := h.db.Query(query, claims.UserID, boardID)
	if err != nil {
		httpx.ServerError(c, "load board stories", err)
		return
	}
	list, err := h.scanStories(rows, claims.UserID)
	if err != nil {
		httpx.ServerError(c, "scan board stories", err)
		return
	}
	c.JSON(http.StatusOK, models.SuccessResponse(list))
}

// GetStory godoc
// @Summary      One story
// @Description  A single story by id, subject to its audience and soft-delete state
// @Tags         Stories
// @Produce      json
// @Param        id path string true "Story ID"
// @Success      200 {object} models.APIResponse
// @Failure      404 {object} models.APIResponse
// @Router       /stories/{id} [get]
func (h *Handler) GetStory(c *gin.Context) {
	claims := httpx.EnsureAuth(c)
	if claims == nil {
		return
	}
	id := c.Param("id")
	if !isUUID(id) {
		c.JSON(http.StatusBadRequest, models.ErrorResponse("Invalid story id"))
		return
	}
	st, err := h.loadStory(claims.UserID, id)
	if err == sql.ErrNoRows {
		c.JSON(http.StatusNotFound, models.ErrorResponse("Story not found"))
		return
	}
	if err != nil {
		httpx.ServerError(c, "load story", err)
		return
	}
	c.JSON(http.StatusOK, models.SuccessResponse(st))
}

// loadStory reads one visible, non-deleted story for the viewer.
func (h *Handler) loadStory(viewerID, storyID string) (Story, error) {
	row := h.db.QueryRow("SELECT"+storyColumns+storyFrom+`
		WHERE s.id::text = $2::text
		  AND s.deleted_at IS NULL
		  AND `+storyaccess.VisibleCondition("s", "$1"),
		viewerID, storyID)
	st, err := scanStory(row)
	if err != nil {
		return st, err
	}
	st.IsOwn = isOwnStory(st, viewerID)
	return st, nil
}

// GetViewers godoc
// @Summary      Story viewers
// @Description  Paginated viewers of a story (author or GomoSub moderator only)
// @Tags         Stories
// @Produce      json
// @Param        id     path  string true  "Story ID"
// @Param        before query string false "Cursor: viewed_at|viewer_id of the last row"
// @Param        limit  query int    false "Page size (1-100)" default(50)
// @Success      200 {object} models.APIResponse
// @Router       /stories/{id}/viewers [get]
func (h *Handler) GetViewers(c *gin.Context) {
	claims := httpx.EnsureAuth(c)
	if claims == nil {
		return
	}
	storyID := c.Param("id")
	if !isUUID(storyID) {
		c.JSON(http.StatusBadRequest, models.ErrorResponse("Invalid story id"))
		return
	}
	var ownerType, ownerID, authorID string
	err := h.db.QueryRow(`SELECT owner_type, COALESCE(user_id::text, board_id::text), author_id::text
		FROM stories WHERE id::text = $1::text AND deleted_at IS NULL`, storyID).
		Scan(&ownerType, &ownerID, &authorID)
	if err == sql.ErrNoRows {
		c.JSON(http.StatusNotFound, models.ErrorResponse("Story not found"))
		return
	}
	if err != nil {
		httpx.ServerError(c, "load story", err)
		return
	}
	allowed := authorID == claims.UserID
	if !allowed && ownerType == OwnerGosub {
		allowed, err = storyaccess.CanModerateBoardStories(h.db, claims.UserID, ownerID)
		if err != nil {
			httpx.ServerError(c, "check moderation rights", err)
			return
		}
	}
	if !allowed {
		c.JSON(http.StatusForbidden, models.ErrorResponse("Only the author can see the viewers"))
		return
	}

	limit := 50
	if raw := c.Query("limit"); raw != "" {
		if n, perr := strconv.Atoi(raw); perr == nil && n > 0 && n <= 100 {
			limit = n
		}
	}

	query := `
		SELECT u.id::text, u.username, u.display_name, u.avatar_url, u.avatar_animated, sv.viewed_at,
		       sv.viewed_at::text || '|' || sv.viewer_id::text AS cursor
		FROM story_views sv
		JOIN users u ON u.id = sv.viewer_id
		WHERE sv.story_id::text = $1::text`
	args := []interface{}{storyID}
	if before := strings.TrimSpace(c.Query("before")); before != "" {
		parts := strings.SplitN(before, "|", 2)
		if len(parts) != 2 || !isUUID(parts[1]) {
			c.JSON(http.StatusBadRequest, models.ErrorResponse("Invalid before cursor"))
			return
		}
		ts, perr := time.Parse(time.RFC3339Nano, parts[0])
		if perr != nil {
			c.JSON(http.StatusBadRequest, models.ErrorResponse("Invalid before cursor"))
			return
		}
		query += ` AND (sv.viewed_at, sv.viewer_id) < ($2::timestamptz, $3::uuid)`
		args = append(args, ts, parts[1])
	}
	query += ` ORDER BY sv.viewed_at DESC, sv.viewer_id DESC LIMIT ` + strconv.Itoa(limit)

	rows, err := h.db.Query(query, args...)
	if err != nil {
		httpx.ServerError(c, "load story viewers", err)
		return
	}
	defer rows.Close()

	resp := ViewersResponse{Viewers: make([]Viewer, 0, limit)}
	var lastCursor string
	for rows.Next() {
		var (
			v        Viewer
			userID   string
			username string
			display  sql.NullString
			avatar   sql.NullString
			animated bool
			cursor   string
		)
		if err := rows.Scan(&userID, &username, &display, &avatar, &animated, &v.ViewedAt, &cursor); err != nil {
			httpx.ServerError(c, "scan story viewer row", err)
			return
		}
		v.User = &Author{
			ID:             userID,
			Username:       username,
			DisplayName:    nullStringPtr(display),
			AvatarURL:      nullStringPtr(avatar),
			AvatarAnimated: animated,
		}
		resp.Viewers = append(resp.Viewers, v)
		lastCursor = cursor
	}
	if err := rows.Err(); err != nil {
		httpx.ServerError(c, "iterate story viewers", err)
		return
	}
	if len(resp.Viewers) == limit {
		resp.NextBefore = &lastCursor
	}
	c.JSON(http.StatusOK, models.SuccessResponse(resp))
}

func nullStringPtr(n sql.NullString) *string {
	if !n.Valid {
		return nil
	}
	v := n.String
	return &v
}
