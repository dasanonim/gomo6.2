package stories

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gomo6/backend/internal/bg"
	"github.com/gomo6/backend/internal/httpx"
	"github.com/gomo6/backend/internal/logsafe"
	"github.com/gomo6/backend/internal/models"
	"github.com/gomo6/backend/internal/storage"
	"github.com/gomo6/backend/internal/storyaccess"
	"github.com/lib/pq"
)

// mediaPool removes story objects off the request path. Bounded and
// drop-tolerant: the row is already soft-deleted, so a dropped task only delays
// the physical delete, it never resurrects content.
var mediaPool = bg.New("stories-media", 2, 512)

type createStoryRequest struct {
	OwnerType   string          `json:"owner_type"`
	BoardID     *string         `json:"board_id"`
	Kind        string          `json:"kind"`
	MediaKey    *string         `json:"media_key"`
	PreviewKey  *string         `json:"preview_key"`
	ThumbHash   *string         `json:"thumb_hash"`
	Width       *int            `json:"width"`
	Height      *int            `json:"height"`
	Duration    *float64        `json:"duration"`
	ContentType *string         `json:"content_type"`
	Text        string          `json:"text"`
	TextStyle   json.RawMessage `json:"text_style"`
	Privacy     string          `json:"privacy"`
}

// normalizedStory is the server-authoritative shape after validation.
type normalizedStory struct {
	ownerType   string
	boardID     *string
	kind        string
	mediaKey    *string
	previewKey  *string
	thumbHash   *string
	width       *int
	height      *int
	duration    *float64
	contentType *string
	text        string
	style       []byte
	privacy     string
}

// CreateStory godoc
// @Summary      Publish a story
// @Description  Publish a photo, video or text story from a personal account or a GomoSub
// @Tags         Stories
// @Accept       json
// @Produce      json
// @Param        request body createStoryRequest true "Story payload"
// @Success      201 {object} models.APIResponse
// @Failure      400 {object} models.APIResponse
// @Failure      403 {object} models.APIResponse
// @Router       /stories [post]
func (h *Handler) CreateStory(c *gin.Context) {
	claims := httpx.EnsureAuth(c)
	if claims == nil {
		return
	}
	var req createStoryRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, models.ErrorResponse("Invalid request body"))
		return
	}
	body, err := normalizeStory(req, claims.UserID)
	if err != nil {
		c.JSON(http.StatusBadRequest, models.ErrorResponse(err.Error()))
		return
	}

	if body.ownerType == OwnerGosub {
		ok, perr := storyaccess.CanPostBoardStories(h.db, claims.UserID, *body.boardID)
		if perr != nil {
			httpx.ServerError(c, "check story posting rights", perr)
			return
		}
		if !ok {
			c.JSON(http.StatusForbidden, models.ErrorResponse("You cannot post stories in this GomoSub"))
			return
		}
	}

	var (
		id        string
		createdAt time.Time
		expiresAt time.Time
	)
	expiresAt = time.Now().UTC().Add(Lifetime)
	err = h.db.QueryRow(`
		INSERT INTO stories (
			owner_type, user_id, board_id, author_id, kind,
			media_key, preview_key, thumb_hash, media_width, media_height,
			media_duration, media_content_type, text, text_style, privacy, expires_at
		) VALUES (
			$1, $2, $3, $4, $5,
			$6, $7, $8, $9, $10,
			$11, $12, $13, $14, $15, $16
		) RETURNING id::text, created_at, expires_at`,
		body.ownerType,
		nullableUserID(body.ownerType, claims.UserID),
		body.boardID,
		claims.UserID,
		body.kind,
		body.mediaKey, body.previewKey, body.thumbHash, body.width, body.height,
		body.duration, body.contentType, body.text, nilIfEmptyBytes(body.style), body.privacy, expiresAt,
	).Scan(&id, &createdAt, &expiresAt)
	if err != nil {
		httpx.ServerError(c, "save story", err)
		return
	}

	st, err := h.loadStory(claims.UserID, id)
	if err != nil {
		httpx.ServerError(c, "reload story", err)
		return
	}
	if st.Privacy != PrivacyOnlyMe {
		h.publishStoryEvent(st, "new_story")
	}
	c.JSON(http.StatusCreated, models.SuccessResponse(st))
}

// nullableUserID keeps the CHECK constraint honest: a GomoSub story has no
// user owner, a personal story has no board.
// nilIfEmptyBytes stores an absent style blob as SQL NULL instead of an empty
// bytea, so "no style" has exactly one representation in the database.
func nilIfEmptyBytes(b []byte) interface{} {
	if len(b) == 0 {
		return nil
	}
	return b
}

func nullableUserID(ownerType, userID string) interface{} {
	if ownerType == OwnerUser {
		return userID
	}
	return nil
}

func normalizeStory(req createStoryRequest, authorID string) (normalizedStory, error) {
	out := normalizedStory{
		ownerType: strings.TrimSpace(req.OwnerType),
		kind:      strings.TrimSpace(req.Kind),
		privacy:   strings.TrimSpace(req.Privacy),
		text:      trimText(req.Text),
	}
	if out.ownerType == "" {
		out.ownerType = OwnerUser
	}
	switch out.ownerType {
	case OwnerUser:
		if req.BoardID != nil && strings.TrimSpace(*req.BoardID) != "" {
			return out, errInvalidOwner
		}
	case OwnerGosub:
		if req.BoardID == nil || !isUUID(strings.TrimSpace(*req.BoardID)) {
			return out, errInvalidOwner
		}
		boardID := strings.TrimSpace(*req.BoardID)
		out.boardID = &boardID
		// A community story's audience is the board, never a per-story list.
		out.privacy = PrivacyEveryone
	default:
		return out, errInvalidOwner
	}

	if out.privacy == "" {
		out.privacy = PrivacyEveryone
	}
	if _, ok := validPrivacy[out.privacy]; !ok {
		return out, errInvalidPrivacy
	}

	switch out.kind {
	case KindPhoto, KindVideo:
		if req.MediaKey == nil || strings.TrimSpace(*req.MediaKey) == "" {
			return out, errMediaRequired
		}
		key := strings.TrimSpace(*req.MediaKey)
		if err := validateOwnedKey(authorID, key); err != nil {
			return out, err
		}
		out.mediaKey = &key
		if req.PreviewKey != nil && strings.TrimSpace(*req.PreviewKey) != "" {
			preview := strings.TrimSpace(*req.PreviewKey)
			if err := validateOwnedKey(authorID, preview); err != nil {
				return out, err
			}
			out.previewKey = &preview
		}
		out.thumbHash = trimmedPtr(req.ThumbHash)
		out.contentType = trimmedPtr(req.ContentType)
		out.width = req.Width
		out.height = req.Height
		if out.kind == KindVideo {
			if req.Duration != nil {
				if *req.Duration <= 0 || *req.Duration > MaxVideoDuration {
					return out, errVideoTooLong
				}
				duration := *req.Duration
				out.duration = &duration
			}
		} else if req.Duration != nil {
			// A photo with a duration is a client bug, not a story we accept:
			// the player would advance on a timer that means nothing.
			return out, errInvalidKind
		}
	case KindText:
		if req.MediaKey != nil && strings.TrimSpace(*req.MediaKey) != "" {
			return out, errMediaForbidden
		}
		if out.text == "" {
			return out, errTextRequired
		}
	default:
		return out, errInvalidKind
	}

	if runeLen(out.text) > MaxTextLength {
		return out, errTextTooLong
	}
	if len(req.TextStyle) > MaxTextStyleBytes {
		return out, errStyleTooBig
	}
	if len(req.TextStyle) > 0 {
		if !json.Valid(req.TextStyle) {
			return out, errInvalidKind
		}
		out.style = []byte(req.TextStyle)
	}
	return out, nil
}

func validateOwnedKey(authorID, key string) error {
	if err := storage.ValidateObjectKey(key); err != nil {
		return errMediaKey
	}
	// Keys are <authorID>/<random>.<ext>. The prefix check is what stops a user
	// from attaching somebody else's object (or a guessed key) to their story.
	if !strings.HasPrefix(key, authorID+"/") {
		return errMediaKey
	}
	return nil
}

func trimmedPtr(s *string) *string {
	if s == nil {
		return nil
	}
	v := strings.TrimSpace(*s)
	if v == "" {
		return nil
	}
	return &v
}

// ─── Update ─────────────────────────────────────────────────────────────────

type updateStoryRequest struct {
	Privacy  *string `json:"privacy"`
	IsPinned *bool   `json:"is_pinned"`
}

// UpdateStory godoc
// @Summary      Edit own story
// @Description  Change the audience of a personal story and/or keep it in the profile highlights
// @Tags         Stories
// @Accept       json
// @Produce      json
// @Param        id path string true "Story ID"
// @Param        request body updateStoryRequest true "Fields to change"
// @Success      200 {object} models.APIResponse
// @Router       /stories/{id} [put]
func (h *Handler) UpdateStory(c *gin.Context) {
	claims := httpx.EnsureAuth(c)
	if claims == nil {
		return
	}
	id := c.Param("id")
	if !isUUID(id) {
		c.JSON(http.StatusBadRequest, models.ErrorResponse("Invalid story id"))
		return
	}
	var req updateStoryRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, models.ErrorResponse("Invalid request body"))
		return
	}
	if req.Privacy == nil && req.IsPinned == nil {
		c.JSON(http.StatusBadRequest, models.ErrorResponse("Nothing to update"))
		return
	}

	var authorID, ownerType string
	err := h.db.QueryRow(`SELECT author_id::text, owner_type FROM stories
		WHERE id::text = $1::text AND deleted_at IS NULL`, id).Scan(&authorID, &ownerType)
	if err == sql.ErrNoRows {
		c.JSON(http.StatusNotFound, models.ErrorResponse("Story not found"))
		return
	}
	if err != nil {
		httpx.ServerError(c, "load story", err)
		return
	}
	if authorID != claims.UserID {
		c.JSON(http.StatusForbidden, models.ErrorResponse("Only the author can edit the story"))
		return
	}

	sets := make([]string, 0, 2)
	args := []interface{}{id}
	if req.Privacy != nil {
		privacy := strings.TrimSpace(*req.Privacy)
		if ownerType == OwnerGosub {
			// The board is the audience; per-story privacy would be a silent
			// no-op, so reject it instead of pretending it worked.
			c.JSON(http.StatusBadRequest, models.ErrorResponse("GomoSub stories cannot change privacy"))
			return
		}
		if _, ok := validPrivacy[privacy]; !ok {
			c.JSON(http.StatusBadRequest, models.ErrorResponse("Invalid privacy"))
			return
		}
		args = append(args, privacy)
		sets = append(sets, "privacy = $"+itoa(len(args)))
	}
	if req.IsPinned != nil {
		if *req.IsPinned && ownerType == OwnerUser {
			var pinned int
			if perr := h.db.QueryRow(`SELECT COUNT(*) FROM stories
				WHERE user_id::text = $1::text AND is_pinned AND deleted_at IS NULL AND id::text <> $2::text`,
				claims.UserID, id).Scan(&pinned); perr != nil {
				httpx.ServerError(c, "count pinned stories", perr)
				return
			}
			if pinned >= MaxPinnedStories {
				c.JSON(http.StatusBadRequest, models.ErrorResponse("Too many pinned stories"))
				return
			}
		}
		args = append(args, *req.IsPinned && ownerType == OwnerUser)
		sets = append(sets, "is_pinned = $"+itoa(len(args)))
	}

	res, err := h.db.Exec(`UPDATE stories SET `+strings.Join(sets, ", ")+
		` WHERE id::text = $1::text AND deleted_at IS NULL`, args...)
	if err != nil {
		httpx.ServerError(c, "update story", err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		c.JSON(http.StatusNotFound, models.ErrorResponse("Story not found"))
		return
	}

	st, err := h.loadStory(claims.UserID, id)
	if err != nil {
		httpx.ServerError(c, "reload story", err)
		return
	}
	h.publishStoryEvent(st, "story_updated")
	c.JSON(http.StatusOK, models.SuccessResponse(st))
}

// itoa keeps the placeholder arithmetic readable next to the SQL it builds.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [4]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}

// ─── Delete ─────────────────────────────────────────────────────────────────

// DeleteStory godoc
// @Summary      Delete a story
// @Description  Soft-delete a story and remove its media; the author or a GomoSub moderator may delete
// @Tags         Stories
// @Produce      json
// @Param        id path string true "Story ID"
// @Success      200 {object} models.APIResponse
// @Router       /stories/{id} [delete]
func (h *Handler) DeleteStory(c *gin.Context) {
	claims := httpx.EnsureAuth(c)
	if claims == nil {
		return
	}
	id := c.Param("id")
	if !isUUID(id) {
		c.JSON(http.StatusBadRequest, models.ErrorResponse("Invalid story id"))
		return
	}

	var authorID, ownerType, ownerID string
	var mediaKey, previewKey sql.NullString
	err := h.db.QueryRow(`SELECT author_id::text, owner_type,
		COALESCE(user_id::text, board_id::text), media_key, preview_key
		FROM stories WHERE id::text = $1::text AND deleted_at IS NULL`, id).
		Scan(&authorID, &ownerType, &ownerID, &mediaKey, &previewKey)
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
		c.JSON(http.StatusForbidden, models.ErrorResponse("Not allowed to delete this story"))
		return
	}

	res, err := h.db.Exec(`UPDATE stories SET deleted_at = NOW()
		WHERE id::text = $1::text AND deleted_at IS NULL`, id)
	if err != nil {
		httpx.ServerError(c, "delete story", err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		c.JSON(http.StatusNotFound, models.ErrorResponse("Story not found"))
		return
	}

	// Bytes go away off the request path; the audience rule already refuses a
	// deleted row, so the only thing left to protect is the object itself.
	if h.media != nil {
		for _, key := range []sql.NullString{mediaKey, previewKey} {
			if !key.Valid || key.String == "" {
				continue
			}
			objectKey := key.String
			deleter := h.media
			mediaPool.Go(func() {
				if derr := deleter.DeleteFile(MediaBucket, objectKey); derr != nil {
					logsafe.Printf("[stories] delete media %s: %v", objectKey, derr)
				}
			})
		}
	}

	h.publish(ownerType, ownerID, "story_deleted", map[string]interface{}{
		"story_id":   id,
		"owner_type": ownerType,
		"owner_id":   ownerID,
		"author_id":  authorID,
	})
	c.JSON(http.StatusOK, models.SuccessResponse(gin.H{"id": id, "deleted": true}))
}

// ─── Views ──────────────────────────────────────────────────────────────────

// RecordView godoc
// @Summary      Mark a story as viewed
// @Description  Records the view once (idempotent) and updates the author's counter
// @Tags         Stories
// @Produce      json
// @Param        id path string true "Story ID"
// @Success      200 {object} models.APIResponse
// @Router       /stories/{id}/view [post]
func (h *Handler) RecordView(c *gin.Context) {
	claims := httpx.EnsureAuth(c)
	if claims == nil {
		return
	}
	id := c.Param("id")
	if !isUUID(id) {
		c.JSON(http.StatusBadRequest, models.ErrorResponse("Invalid story id"))
		return
	}

	var authorID, ownerType, ownerID string
	var expiresAt time.Time
	err := h.db.QueryRow(`SELECT author_id::text, owner_type,
		COALESCE(user_id::text, board_id::text), expires_at
		FROM stories WHERE id::text = $1::text AND deleted_at IS NULL`, id).
		Scan(&authorID, &ownerType, &ownerID, &expiresAt)
	if err == sql.ErrNoRows {
		c.JSON(http.StatusNotFound, models.ErrorResponse("Story not found"))
		return
	}
	if err != nil {
		httpx.ServerError(c, "load story", err)
		return
	}
	visible, err := storyaccess.CanViewStory(h.db, claims.UserID, id)
	if err != nil {
		httpx.ServerError(c, "check story visibility", err)
		return
	}
	if !visible {
		c.JSON(http.StatusForbidden, models.ErrorResponse("No access to this story"))
		return
	}

	// Own views never count: the author is not in their own audience, and a
	// self-view would make the footer show a fake "1 viewer".
	if authorID == claims.UserID {
		var count int
		if qerr := h.db.QueryRow(`SELECT views_count FROM stories WHERE id::text = $1::text`, id).Scan(&count); qerr != nil {
			httpx.ServerError(c, "load views count", qerr)
			return
		}
		c.JSON(http.StatusOK, models.SuccessResponse(gin.H{"views_count": count, "counted": false}))
		return
	}

	count, counted, err := h.recordView(id, claims.UserID)
	if err != nil {
		httpx.ServerError(c, "record story view", err)
		return
	}
	if counted {
		h.publish(ownerType, ownerID, "story_viewed", map[string]interface{}{
			"story_id":    id,
			"owner_type":  ownerType,
			"owner_id":    ownerID,
			"author_id":   authorID,
			"viewer_id":   claims.UserID,
			"views_count": count,
		})
	}
	c.JSON(http.StatusOK, models.SuccessResponse(gin.H{"views_count": count, "counted": counted, "is_viewed": true}))
}

// recordView inserts the view once and bumps the denormalized counter in the
// same transaction. Returns the current count and whether this call was the
// first view by that user.
func (h *Handler) recordView(storyID, viewerID string) (int, bool, error) {
	tx, err := h.db.Begin()
	if err != nil {
		return 0, false, err
	}
	defer func() { _ = tx.Rollback() }()

	res, err := tx.Exec(`
		INSERT INTO story_views (story_id, viewer_id) VALUES ($1::uuid, $2::uuid)
		ON CONFLICT (story_id, viewer_id) DO NOTHING`, storyID, viewerID)
	if err != nil {
		return 0, false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, false, err
	}
	counted := n > 0

	var count int
	if counted {
		err = tx.QueryRow(`UPDATE stories SET views_count = views_count + 1
			WHERE id::text = $1::text RETURNING views_count`, storyID).Scan(&count)
	} else {
		err = tx.QueryRow(`SELECT views_count FROM stories WHERE id::text = $1::text`, storyID).Scan(&count)
	}
	if err != nil {
		return 0, false, err
	}
	if err := tx.Commit(); err != nil {
		return 0, false, err
	}
	return count, counted, nil
}

// ─── Reactions ──────────────────────────────────────────────────────────────

type reactionRequest struct {
	Emoji string `json:"emoji"`
}

// SetReaction godoc
// @Summary      React to a story
// @Description  Set (or replace) the viewer's single reaction
// @Tags         Stories
// @Accept       json
// @Produce      json
// @Param        id path string true "Story ID"
// @Param        request body reactionRequest true "Emoji from the allowed set"
// @Success      200 {object} models.APIResponse
// @Router       /stories/{id}/reaction [put]
func (h *Handler) SetReaction(c *gin.Context) {
	claims := httpx.EnsureAuth(c)
	if claims == nil {
		return
	}
	id := c.Param("id")
	if !isUUID(id) {
		c.JSON(http.StatusBadRequest, models.ErrorResponse("Invalid story id"))
		return
	}
	var req reactionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, models.ErrorResponse("Invalid request body"))
		return
	}
	emoji := strings.TrimSpace(req.Emoji)
	if _, ok := AllowedReactions[emoji]; !ok {
		c.JSON(http.StatusBadRequest, models.ErrorResponse("Unsupported reaction"))
		return
	}
	authorID, ownerType, ownerID, ok := h.storyForInteraction(c, id)
	if !ok {
		return
	}
	if authorID == claims.UserID {
		c.JSON(http.StatusBadRequest, models.ErrorResponse("You cannot react to your own story"))
		return
	}

	_, err := h.db.Exec(`
		INSERT INTO story_reactions (story_id, user_id, emoji)
		VALUES ($1::uuid, $2::uuid, $3)
		ON CONFLICT (story_id, user_id) DO UPDATE SET emoji = EXCLUDED.emoji, created_at = NOW()`,
		id, claims.UserID, emoji)
	if err != nil {
		httpx.ServerError(c, "save story reaction", err)
		return
	}
	count := h.reactionCount(id)
	h.publish(ownerType, ownerID, "story_reaction", map[string]interface{}{
		"story_id":        id,
		"owner_type":      ownerType,
		"owner_id":        ownerID,
		"author_id":       authorID,
		"user_id":         claims.UserID,
		"emoji":           emoji,
		"reactions_count": count,
	})
	c.JSON(http.StatusOK, models.SuccessResponse(gin.H{"emoji": emoji, "reactions_count": count}))
}

// DeleteReaction godoc
// @Summary      Remove the reaction
// @Description  Removes the viewer's reaction from a story
// @Tags         Stories
// @Produce      json
// @Param        id path string true "Story ID"
// @Success      200 {object} models.APIResponse
// @Router       /stories/{id}/reaction [delete]
func (h *Handler) DeleteReaction(c *gin.Context) {
	claims := httpx.EnsureAuth(c)
	if claims == nil {
		return
	}
	id := c.Param("id")
	if !isUUID(id) {
		c.JSON(http.StatusBadRequest, models.ErrorResponse("Invalid story id"))
		return
	}
	authorID, ownerType, ownerID, ok := h.storyForInteraction(c, id)
	if !ok {
		return
	}
	if _, err := h.db.Exec(`DELETE FROM story_reactions WHERE story_id::text = $1::text AND user_id::text = $2::text`,
		id, claims.UserID); err != nil {
		httpx.ServerError(c, "delete story reaction", err)
		return
	}
	count := h.reactionCount(id)
	h.publish(ownerType, ownerID, "story_reaction", map[string]interface{}{
		"story_id":        id,
		"owner_type":      ownerType,
		"owner_id":        ownerID,
		"author_id":       authorID,
		"user_id":         claims.UserID,
		"emoji":           "",
		"reactions_count": count,
	})
	c.JSON(http.StatusOK, models.SuccessResponse(gin.H{"reactions_count": count}))
}

// storyForInteraction loads the story header and checks the viewer may see it.
// It writes the error response itself and reports ok=false when the caller must
// stop.
func (h *Handler) storyForInteraction(c *gin.Context, storyID string) (authorID, ownerType, ownerID string, ok bool) {
	err := h.db.QueryRow(`SELECT author_id::text, owner_type, COALESCE(user_id::text, board_id::text)
		FROM stories WHERE id::text = $1::text AND deleted_at IS NULL`, storyID).
		Scan(&authorID, &ownerType, &ownerID)
	if err == sql.ErrNoRows {
		c.JSON(http.StatusNotFound, models.ErrorResponse("Story not found"))
		return "", "", "", false
	}
	if err != nil {
		httpx.ServerError(c, "load story", err)
		return "", "", "", false
	}
	visible, verr := storyaccess.CanViewStory(h.db, httpx.AuthenticatedUserID(c), storyID)
	if verr != nil {
		httpx.ServerError(c, "check story visibility", verr)
		return "", "", "", false
	}
	if !visible {
		c.JSON(http.StatusForbidden, models.ErrorResponse("No access to this story"))
		return "", "", "", false
	}
	return authorID, ownerType, ownerID, true
}

func (h *Handler) reactionCount(storyID string) int {
	var count int
	if err := h.db.QueryRow(`SELECT COUNT(*) FROM story_reactions WHERE story_id::text = $1::text`, storyID).
		Scan(&count); err != nil {
		return 0
	}
	return count
}

// ─── Close friends ──────────────────────────────────────────────────────────

// GetCloseFriends godoc
// @Summary      Close friends list
// @Description  Users in the viewer's «Избранные» list (the close_friends audience)
// @Tags         Stories
// @Produce      json
// @Success      200 {object} models.APIResponse
// @Router       /stories/close-friends [get]
func (h *Handler) GetCloseFriends(c *gin.Context) {
	claims := httpx.EnsureAuth(c)
	if claims == nil {
		return
	}
	rows, err := h.db.Query(`
		SELECT u.id::text, u.username, u.display_name, u.avatar_url, u.avatar_animated
		FROM story_close_friends scf
		JOIN users u ON u.id = scf.friend_id
		WHERE scf.owner_id = $1::uuid
		ORDER BY u.username ASC`, claims.UserID)
	if err != nil {
		httpx.ServerError(c, "load close friends", err)
		return
	}
	defer rows.Close()

	friends := make([]Author, 0, 16)
	for rows.Next() {
		var (
			a        Author
			display  sql.NullString
			avatar   sql.NullString
			animated bool
		)
		if err := rows.Scan(&a.ID, &a.Username, &display, &avatar, &animated); err != nil {
			httpx.ServerError(c, "scan close friend", err)
			return
		}
		a.DisplayName = nullStringPtr(display)
		a.AvatarURL = nullStringPtr(avatar)
		a.AvatarAnimated = animated
		friends = append(friends, a)
	}
	if err := rows.Err(); err != nil {
		httpx.ServerError(c, "iterate close friends", err)
		return
	}
	c.JSON(http.StatusOK, models.SuccessResponse(gin.H{"friends": friends}))
}

type closeFriendsRequest struct {
	UserIDs []string `json:"user_ids"`
}

// PutCloseFriends godoc
// @Summary      Replace the close friends list
// @Description  Sets the «Избранные» audience; ids that are not mutual friends are ignored
// @Tags         Stories
// @Accept       json
// @Produce      json
// @Param        request body closeFriendsRequest true "Full list of user ids"
// @Success      200 {object} models.APIResponse
// @Router       /stories/close-friends [put]
func (h *Handler) PutCloseFriends(c *gin.Context) {
	claims := httpx.EnsureAuth(c)
	if claims == nil {
		return
	}
	var req closeFriendsRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, models.ErrorResponse("Invalid request body"))
		return
	}
	if len(req.UserIDs) > 300 {
		c.JSON(http.StatusBadRequest, models.ErrorResponse("Too many close friends"))
		return
	}
	ids := make([]string, 0, len(req.UserIDs))
	seen := map[string]bool{}
	for _, raw := range req.UserIDs {
		id := strings.TrimSpace(raw)
		if !isUUID(id) || id == claims.UserID || seen[id] {
			continue
		}
		seen[id] = true
		ids = append(ids, id)
	}

	tx, err := h.db.Begin()
	if err != nil {
		httpx.ServerError(c, "begin close friends update", err)
		return
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.Exec(`DELETE FROM story_close_friends WHERE owner_id = $1::uuid`, claims.UserID); err != nil {
		httpx.ServerError(c, "clear close friends", err)
		return
	}
	if len(ids) > 0 {
		// Only mutual friends may be added: the close-friends list is an
		// audience for people you actually know, and a stale entry after a
		// friendship ends would silently keep showing stories to an ex-friend.
		_, err = tx.Exec(`
			INSERT INTO story_close_friends (owner_id, friend_id)
			SELECT $1::uuid, fid FROM unnest($2::uuid[]) AS fid
			WHERE EXISTS (
				SELECT 1 FROM friendships f
				WHERE f.user1_id = LEAST($1::uuid, fid)
				  AND f.user2_id = GREATEST($1::uuid, fid)
			)
			ON CONFLICT DO NOTHING`, claims.UserID, pq.Array(ids))
		if err != nil {
			httpx.ServerError(c, "save close friends", err)
			return
		}
	}
	if err := tx.Commit(); err != nil {
		httpx.ServerError(c, "commit close friends", err)
		return
	}
	c.JSON(http.StatusOK, models.SuccessResponse(gin.H{"ok": true}))
}
