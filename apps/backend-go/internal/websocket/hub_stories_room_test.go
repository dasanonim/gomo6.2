package websocket

import (
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

// A stories_user_<id> room is only subscribable by someone who may see that
// profile's stories at all — the same predicate the REST read uses.
func TestCanAccessRoom_StoriesUserRoom(t *testing.T) {
	const peer = "30000000-0000-0000-0000-0000000000cc"

	t.Run("visible profile", func(t *testing.T) {
		hub, mock := setupHubWithDB(t)
		mock.ExpectQuery(`SELECT EXISTS \(\s*SELECT 1 FROM users u`).
			WithArgs("user-1", peer).
			WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(true))

		if !hub.canAccessRoom("user-1", "stories_user_"+peer) {
			t.Error("expected a visible profile's story room to be subscribable")
		}
	})

	t.Run("private profile stranger", func(t *testing.T) {
		hub, mock := setupHubWithDB(t)
		mock.ExpectQuery(`SELECT EXISTS \(\s*SELECT 1 FROM users u`).
			WithArgs("user-2", peer).
			WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(false))

		if hub.canAccessRoom("user-2", "stories_user_"+peer) {
			t.Error("a stranger must not subscribe to a private profile's story room")
		}
	})

	t.Run("missing id", func(t *testing.T) {
		hub, _ := setupHubWithDB(t)
		if hub.canAccessRoom("user-1", "stories_user_") {
			t.Error("a room without an id must be denied without a query")
		}
	})
}

// stories_owner_<id> carries view/reaction counters: strictly self only.
func TestCanAccessRoom_StoriesOwnerRoom(t *testing.T) {
	hub := NewHub(nil, nil)
	if !hub.canAccessRoom("user-1", StoriesOwnerRoom("user-1")) {
		t.Error("the author must be able to subscribe to their own counters room")
	}
	if hub.canAccessRoom("user-1", StoriesOwnerRoom("user-2")) {
		t.Error("counters must never leak to another user")
	}
}

func TestCanAccessRoom_StoriesBoardRoom(t *testing.T) {
	const board = "40000000-0000-0000-0000-0000000000dd"

	t.Run("public board", func(t *testing.T) {
		hub, mock := setupHubWithDB(t)
		mock.ExpectQuery(`SELECT EXISTS \(\s*SELECT 1 FROM boards b`).
			WithArgs("user-1", board).
			WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(true))

		if !hub.canAccessRoom("user-1", "stories_board_"+board) {
			t.Error("expected public board story room access")
		}
	})

	t.Run("private board stranger", func(t *testing.T) {
		hub, mock := setupHubWithDB(t)
		mock.ExpectQuery(`SELECT EXISTS \(\s*SELECT 1 FROM boards b`).
			WithArgs("user-2", board).
			WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(false))

		if hub.canAccessRoom("user-2", "stories_board_"+board) {
			t.Error("a stranger must not subscribe to a private board's story room")
		}
	})
}

// Lifecycle events route to the owner's room; counters route to the author's
// private room and must never reach the owner's public room.
func TestHandleRedisEvent_StoriesRouting(t *testing.T) {
	const owner = "30000000-0000-0000-0000-0000000000cc"

	t.Run("new_story reaches the owner room", func(t *testing.T) {
		hub := NewHub(nil, nil)
		client := newTestClient(hub, "user-1", "Alice")
		hub.SubscribeToRoom(client, StoriesRoom("user", owner))

		hub.handleRedisEvent(RealtimeEvent{
			Type: MessageTypeNewStory,
			Payload: map[string]interface{}{
				"story_id":   "s1",
				"owner_type": "user",
				"owner_id":   owner,
				"author_id":  owner,
			},
		})
		waitForBuffer()

		select {
		case msg := <-client.Send:
			if !containsStr(string(msg), "new_story") {
				t.Errorf("expected new_story, got: %s", string(msg))
			}
		default:
			t.Error("new_story must reach subscribers of the owner room")
		}
	})

	t.Run("story_viewed goes to the author room only", func(t *testing.T) {
		hub := NewHub(nil, nil)
		author := newTestClient(hub, owner, "Author")
		viewer := newTestClient(hub, "user-1", "Viewer")
		// The viewer subscribed to the owner's public lifecycle room; a view
		// count must NOT arrive there.
		hub.SubscribeToRoom(author, StoriesOwnerRoom(owner))
		hub.SubscribeToRoom(viewer, StoriesRoom("user", owner))

		hub.handleRedisEvent(RealtimeEvent{
			Type: MessageTypeStoryViewed,
			Payload: map[string]interface{}{
				"story_id":    "s1",
				"owner_type":  "user",
				"owner_id":    owner,
				"author_id":   owner,
				"viewer_id":   "user-1",
				"views_count": float64(3),
			},
		})
		waitForBuffer()

		select {
		case msg := <-author.Send:
			if !containsStr(string(msg), "story_viewed") {
				t.Errorf("expected story_viewed for the author, got: %s", string(msg))
			}
		default:
			t.Error("the author must receive their own view counter")
		}

		select {
		case msg := <-viewer.Send:
			t.Errorf("view counters must not leak to the owner's public room: %s", string(msg))
		default:
		}
	})

	t.Run("story_deleted reaches the owner room", func(t *testing.T) {
		hub := NewHub(nil, nil)
		client := newTestClient(hub, "user-1", "Alice")
		hub.SubscribeToRoom(client, StoriesRoom("gosub", "board-1"))

		hub.handleRedisEvent(RealtimeEvent{
			Type: MessageTypeStoryDeleted,
			Payload: map[string]interface{}{
				"story_id":   "s1",
				"owner_type": "gosub",
				"owner_id":   "board-1",
				"author_id":  "user-1",
			},
		})
		waitForBuffer()

		select {
		case msg := <-client.Send:
			if !containsStr(string(msg), "story_deleted") {
				t.Errorf("expected story_deleted, got: %s", string(msg))
			}
		default:
			t.Error("story_deleted must reach subscribers of the board room")
		}
	})
}
