package stories

import (
	"context"
	"log"
	"time"

	"github.com/gomo6/backend/internal/websocket"
)

// publish fans a stories event out through the hub's Redis channel. A nil or
// broken hub degrades gracefully: REST responses are unaffected.
//
// The payload always carries owner_type + owner_id; the hub uses them to pick
// the room (stories_user_<id> / stories_board_<id>) and, for author-only
// events (story_viewed / story_reaction), the author_id to pick
// stories_owner_<authorID>. Nothing private rides along: media keys, text and
// captions are never in an event — clients refetch through the audited REST
// read.
func (h *Handler) publish(ownerType, ownerID, eventType string, payload map[string]interface{}) {
	if h.hub == nil {
		return
	}
	if payload == nil {
		payload = map[string]interface{}{}
	}
	payload["owner_type"] = ownerType
	payload["owner_id"] = ownerID
	if err := h.hub.PublishToRedis(websocket.RedisChannelStories, websocket.RealtimeEvent{
		Type:    eventType,
		Payload: payload,
	}); err != nil {
		log.Printf("[Stories] redis publish %s: %v", eventType, err)
	}
}

// publishStoryEvent emits a story lifecycle event for an already-loaded story.
func (h *Handler) publishStoryEvent(st Story, eventType string) {
	payload := map[string]interface{}{
		"story_id":   st.ID,
		"author_id":  st.AuthorID,
		"owner_type": st.OwnerType,
		"owner_id":   st.OwnerID,
		"is_pinned":  st.IsPinned,
	}
	// A privacy edit must reach viewers too (so the slide disappears from a
	// rail it no longer belongs to), but the audience level itself is not sent:
	// a viewer learns only that something changed.
	h.publish(st.OwnerType, st.OwnerID, eventType, payload)
}

// ─── Maintenance ────────────────────────────────────────────────────────────

// deletedRetention is how long a soft-deleted story row is kept for auditing
// (its bytes are already gone). The rows are invisible to every read.
const deletedRetention = 7 * 24 * time.Hour

// PurgeDeleted hard-deletes soft-deleted rows older than the retention window.
// Media objects are removed at delete time, so this only trims bookkeeping.
func (h *Handler) PurgeDeleted() (int64, error) {
	res, err := h.db.Exec(`DELETE FROM stories
		WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - $1::interval`,
		deletedRetention.String())
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// StartMaintenance runs PurgeDeleted on a ticker until ctx is cancelled. It is
// started once from routes; a nil DB (tests without a database) is a no-op.
func (h *Handler) StartMaintenance(ctx context.Context, every time.Duration) {
	if h.db == nil || every <= 0 {
		return
	}
	go func() {
		// First sweep shortly after boot, then on the ticker.
		timer := time.NewTimer(time.Minute)
		defer timer.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-timer.C:
			}
			n, err := h.PurgeDeleted()
			if err != nil {
				log.Printf("[Stories] purge deleted: %v", err)
			} else if n > 0 {
				log.Printf("[Stories] purged %d deleted stories", n)
			}
			timer.Reset(every)
		}
	}()
}
