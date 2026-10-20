// Package stories implements Telegram-style 24-hour stories: a photo, a short
// video or a text slide published either from a personal account or from a
// GomoSub (when the author's role carries `can_post_stories`).
//
// The package owns three things that must never drift apart:
//   - the audience rule, via internal/storyaccess (shared with the media proxy
//     and the WebSocket room gate);
//   - the lifecycle: live for 24h, then archive for the author, "keep in
//     profile" (is_pinned) survives expiry, soft delete purges bytes at once;
//   - the realtime contract: new_story / story_updated / story_deleted to the
//     owning room, and author-only counters (story_viewed / story_reaction) to
//     stories_owner_<authorID>.
package stories

import (
	"database/sql"
	"encoding/json"
	"errors"
	"regexp"
	"time"
	"unicode/utf8"

	"github.com/gomo6/backend/internal/websocket"
)

var uuidRegex = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func isUUID(s string) bool { return uuidRegex.MatchString(s) }

const (
	// Lifetime is fixed at 24 hours. Telegram lets some accounts pick 6/12/24/48;
	// keeping it a server constant means the contract cannot be widened by a
	// client, and the product copy ("исчезнет через 24 часа") stays true.
	Lifetime = 24 * time.Hour

	// MaxTextLength covers a text slide body and a media caption alike.
	MaxTextLength = 1024

	// MaxPinnedStories caps the profile highlights row.
	MaxPinnedStories = 10

	// MaxVideoDuration is the longest clip accepted into a story, in seconds.
	MaxVideoDuration = 60.0

	// MediaBucket is the private bucket that holds story bytes. Objects are
	// only ever served through the authenticated proxy (never a public Garage
	// URL), because a story's audience is narrower than "everyone with a link".
	MediaBucket = "stories"

	// MaxTextStyleBytes bounds the free-form style blob (gradient id, align…).
	MaxTextStyleBytes = 2048
)

// Owner types.
const (
	OwnerUser  = "user"
	OwnerGosub = "gosub"
)

// Story kinds.
const (
	KindPhoto = "photo"
	KindVideo = "video"
	KindText  = "text"
)

// Audiences.
const (
	PrivacyEveryone     = "everyone"
	PrivacyFriends      = "friends"
	PrivacyCloseFriends = "close_friends"
	PrivacyOnlyMe       = "only_me"
)

var validPrivacy = map[string]struct{}{
	PrivacyEveryone:     {},
	PrivacyFriends:      {},
	PrivacyCloseFriends: {},
	PrivacyOnlyMe:       {},
}

// AllowedReactions is the closed set of quick reactions. A closed set keeps the
// viewer/footer UI trivial and stops arbitrary text from being smuggled into a
// field every viewer renders.
var AllowedReactions = map[string]struct{}{
	"❤️": {}, "🔥": {}, "😂": {}, "😮": {}, "😢": {}, "👏": {}, "🎉": {}, "💯": {},
}

// Handler serves the /api/v1/stories REST surface.
type Handler struct {
	db    *sql.DB
	hub   *websocket.Hub
	media ObjectDeleter
}

// ObjectDeleter removes media objects (the S3 client implements it). nil is
// allowed: the row is still soft-deleted, and the orphan sweep remains the
// safety net.
type ObjectDeleter interface {
	DeleteFile(bucket, key string) error
}

// NewHandler wires the handler. hub may be nil in tests — realtime fan-out is
// skipped silently when absent.
func NewHandler(db *sql.DB, hub *websocket.Hub) *Handler {
	return &Handler{db: db, hub: hub}
}

// SetMediaDeleter injects the object store so deleting a story removes its
// bytes immediately instead of waiting for a sweep.
func (h *Handler) SetMediaDeleter(d ObjectDeleter) { h.media = d }

// Author is the human who published the story.
type Author struct {
	ID             string  `json:"id"`
	Username       string  `json:"username"`
	DisplayName    *string `json:"display_name,omitempty"`
	AvatarURL      *string `json:"avatar_url,omitempty"`
	AvatarAnimated bool    `json:"avatar_animated"`
}

// Owner is the entity the story belongs to: a person or a GomoSub board.
type Owner struct {
	Type           string  `json:"type"`
	ID             string  `json:"id"`
	Name           string  `json:"name"`
	Username       *string `json:"username,omitempty"`
	Slug           *string `json:"slug,omitempty"`
	AvatarURL      *string `json:"avatar_url,omitempty"`
	AvatarAnimated bool    `json:"avatar_animated,omitempty"`
}

// Story is one slide as the client renders it.
type Story struct {
	ID             string          `json:"id"`
	OwnerType      string          `json:"owner_type"`
	OwnerID        string          `json:"owner_id"`
	AuthorID       string          `json:"author_id"`
	Author         *Author         `json:"author,omitempty"`
	Kind           string          `json:"kind"`
	MediaKey       *string         `json:"media_key,omitempty"`
	PreviewKey     *string         `json:"preview_key,omitempty"`
	ThumbHash      *string         `json:"thumb_hash,omitempty"`
	Width          *int            `json:"width,omitempty"`
	Height         *int            `json:"height,omitempty"`
	Duration       *float64        `json:"duration,omitempty"`
	ContentType    *string         `json:"content_type,omitempty"`
	Text           string          `json:"text"`
	TextStyle      json.RawMessage `json:"text_style,omitempty"`
	Privacy        string          `json:"privacy"`
	IsPinned       bool            `json:"is_pinned"`
	ViewsCount     int             `json:"views_count"`
	ReactionsCount int             `json:"reactions_count"`
	CreatedAt      time.Time       `json:"created_at"`
	ExpiresAt      time.Time       `json:"expires_at"`
	IsViewed       bool            `json:"is_viewed"`
	IsOwn          bool            `json:"is_own"`
	MyReaction     *string         `json:"my_reaction,omitempty"`
}

// Group is one avatar circle: an owner and their ordered slides (oldest first,
// so the viewer's progress bar runs left→right like the story queue).
type Group struct {
	Owner     *Owner  `json:"owner"`
	Stories   []Story `json:"stories"`
	HasUnread bool    `json:"has_unread"`
}

// RailResponse is the stories rail at the top of the feed.
type RailResponse struct {
	Groups []Group `json:"groups"`
}

// Viewer is one entry of an author's viewers list.
type Viewer struct {
	User     *Author   `json:"user"`
	ViewedAt time.Time `json:"viewed_at"`
}

// ViewersResponse is a keyset page of viewers, newest first.
type ViewersResponse struct {
	Viewers    []Viewer `json:"viewers"`
	NextBefore *string  `json:"next_before,omitempty"`
}

// ─── Errors ─────────────────────────────────────────────────────────────────

var (
	errInvalidOwner   = errors.New("invalid owner")
	errInvalidKind    = errors.New("invalid kind")
	errInvalidPrivacy = errors.New("invalid privacy")
	errTextRequired   = errors.New("text required")
	errTextTooLong    = errors.New("text too long")
	errMediaRequired  = errors.New("media required")
	errMediaForbidden = errors.New("media not allowed for text story")
	errMediaKey       = errors.New("invalid media key")
	errVideoTooLong   = errors.New("video too long")
	errStyleTooBig    = errors.New("text style too large")
	errNotAuthor      = errors.New("not the author")
)

// trimText removes surrounding whitespace without allocating when nothing
// needs trimming.
func trimText(s string) string {
	start, end := 0, len(s)
	for start < end && isSpaceByte(s[start]) {
		start++
	}
	for end > start && isSpaceByte(s[end-1]) {
		end--
	}
	return s[start:end]
}

func isSpaceByte(b byte) bool { return b == ' ' || b == '\t' || b == '\n' || b == '\r' }

func runeLen(s string) int { return utf8.RuneCountInString(s) }
