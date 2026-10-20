//go:build integration

package stories

// Real-database tests for the stories package. They need a migrated database:
//
//	DATABASE_URL_TEST=postgres://user:pass@127.0.0.1:5432/db \
//	  go test -tags=integration ./internal/stories -run TestIntegration
//
// Unlike the sqlmock tests (which pin the SQL shape), these tests prove the
// actual audience rules end to end: private profiles, friendships, close
// friends, GomoSub membership, roles, views and the rail. Every fixture is
// created under a unique name and removed afterwards.

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gomo6/backend/internal/auth"
	"github.com/gomo6/backend/internal/testutil"
	_ "github.com/lib/pq"
)

type itEnv struct {
	t      *testing.T
	db     *sql.DB
	h      *Handler
	users  []string
	boards []string
	seq    int
}

func newIT(t *testing.T) *itEnv {
	t.Helper()
	gin.SetMode(gin.TestMode)
	dsn := os.Getenv("DATABASE_URL_TEST")
	if dsn == "" {
		t.Skip("DATABASE_URL_TEST is not set")
	}
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if err := db.Ping(); err != nil {
		_ = db.Close()
		t.Skipf("database unavailable: %v", err)
	}
	// The schema must already contain the stories migration.
	var exists bool
	if err := db.QueryRow(`SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'stories')`).Scan(&exists); err != nil || !exists {
		_ = db.Close()
		t.Skip("stories tables are not migrated in DATABASE_URL_TEST")
	}

	env := &itEnv{t: t, db: db, h: NewHandler(db, nil)}
	t.Cleanup(env.cleanup)
	return env
}

func (e *itEnv) cleanup() {
	for _, b := range e.boards {
		_, _ = e.db.Exec(`DELETE FROM boards WHERE id::text = $1`, b)
	}
	for _, u := range e.users {
		_, _ = e.db.Exec(`DELETE FROM users WHERE id::text = $1`, u)
	}
	_ = e.db.Close()
}

func (e *itEnv) user(tag string) string {
	e.t.Helper()
	e.seq++
	suffix := fmt.Sprintf("%d_%d_%s", time.Now().UnixNano(), e.seq, tag)
	var id string
	err := e.db.QueryRow(`
		INSERT INTO users (username, email, password_hash, display_name, wallet_address)
		VALUES ($1, $2, 'x', $3, $4) RETURNING id::text`,
		"it_"+suffix, suffix+"@example.test", tag, ("it" + randomHex())[:14]).Scan(&id)
	if err != nil {
		e.t.Fatalf("create user %s: %v", tag, err)
	}
	e.users = append(e.users, id)
	return id
}

func (e *itEnv) board(name, visibility, ownerID string) string {
	e.t.Helper()
	e.seq++
	suffix := fmt.Sprintf("%d_%d_%s", time.Now().UnixNano(), e.seq, name)
	var id string
	err := e.db.QueryRow(`
		INSERT INTO boards (slug, name, is_gomosub, owner_id, visibility)
		VALUES ($1, $2, true, $3, $4) RETURNING id::text`,
		"it-"+suffix, name, ownerID, visibility).Scan(&id)
	if err != nil {
		e.t.Fatalf("create board: %v", err)
	}
	e.boards = append(e.boards, id)
	return id
}

func (e *itEnv) friend(a, b string) {
	e.t.Helper()
	if _, err := e.db.Exec(`INSERT INTO friendships (user1_id, user2_id)
		VALUES (LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid))
		ON CONFLICT DO NOTHING`, a, b); err != nil {
		e.t.Fatalf("friend: %v", err)
	}
	if _, err := e.db.Exec(`INSERT INTO subscriptions (subscriber_id, target_id)
		VALUES ($1::uuid, $2::uuid), ($2::uuid, $1::uuid) ON CONFLICT DO NOTHING`, a, b); err != nil {
		e.t.Fatalf("subscribe: %v", err)
	}
}

func (e *itEnv) follow(follower, target string) {
	e.t.Helper()
	if _, err := e.db.Exec(`INSERT INTO subscriptions (subscriber_id, target_id)
		VALUES ($1::uuid, $2::uuid) ON CONFLICT DO NOTHING`, follower, target); err != nil {
		e.t.Fatalf("follow: %v", err)
	}
}

func (e *itEnv) privateProfile(userID string) {
	e.t.Helper()
	if _, err := e.db.Exec(`INSERT INTO privacy_settings (user_id, private_profile)
		VALUES ($1::uuid, true)
		ON CONFLICT (user_id) DO UPDATE SET private_profile = true`, userID); err != nil {
		e.t.Fatalf("privacy settings: %v", err)
	}
}

func (e *itEnv) closeFriend(ownerID, friendID string) {
	e.t.Helper()
	if _, err := e.db.Exec(`INSERT INTO story_close_friends (owner_id, friend_id)
		VALUES ($1::uuid, $2::uuid) ON CONFLICT DO NOTHING`, ownerID, friendID); err != nil {
		e.t.Fatalf("close friend: %v", err)
	}
}

func (e *itEnv) member(boardID, userID string, permissions string) {
	e.t.Helper()
	var roleID string
	if permissions != "" {
		if err := e.db.QueryRow(`INSERT INTO gomosub_roles (board_id, name, permissions)
			VALUES ($1::uuid, $2, $3::jsonb) RETURNING id::text`,
			boardID, fmt.Sprintf("role_%d", time.Now().UnixNano()), permissions).Scan(&roleID); err != nil {
			e.t.Fatalf("create role: %v", err)
		}
	}
	if _, err := e.db.Exec(`INSERT INTO gomosub_memberships (board_id, user_id, role_id)
		VALUES ($1::uuid, $2::uuid, NULLIF($3, '')::uuid) ON CONFLICT DO NOTHING`,
		boardID, userID, roleID); err != nil {
		e.t.Fatalf("membership: %v", err)
	}
}

func (e *itEnv) story(ownerType, ownerID, authorID, privacy string, created time.Time, expires time.Time, pinned bool) string {
	e.t.Helper()
	var userID, boardID interface{}
	if ownerType == OwnerUser {
		userID = ownerID
	} else {
		boardID = ownerID
	}
	var id string
	err := e.db.QueryRow(`
		INSERT INTO stories (owner_type, user_id, board_id, author_id, kind, text, privacy, is_pinned, created_at, expires_at)
		VALUES ($1, $2, $3, $4::uuid, 'text', 'hello', $5, $6, $7, $8)
		RETURNING id::text`,
		ownerType, userID, boardID, authorID, privacy, pinned, created, expires).Scan(&id)
	if err != nil {
		e.t.Fatalf("create story: %v", err)
	}
	return id
}

// randomHex keeps the NOT NULL unique wallet_address distinct per fixture.
func randomHex() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func claimsFor(userID string) *auth.Claims {
	return &auth.Claims{UserID: userID, Username: "it"}
}

func (e *itEnv) listStories(viewer, ownerID, scope string) []Story {
	e.t.Helper()
	q := map[string]string{}
	if scope != "" {
		q["scope"] = scope
	}
	c, w := testutil.NewGETContextWithParams("/api/v1/stories/user/"+ownerID, q,
		map[string]string{"userId": ownerID})
	c.Set("claims", claimsFor(viewer))
	e.h.GetUserStories(c)
	if w.Code != http.StatusOK {
		e.t.Fatalf("list stories status %d: %s", w.Code, w.Body.String())
	}
	var resp struct {
		Data []Story `json:"data"`
	}
	decodeJSON(e.t, w.Body.Bytes(), &resp)
	return resp.Data
}

func (e *itEnv) listBoardStories(viewer, boardID, scope string) (int, []Story) {
	e.t.Helper()
	q := map[string]string{}
	if scope != "" {
		q["scope"] = scope
	}
	c, w := testutil.NewGETContextWithParams("/api/v1/stories/board/"+boardID, q,
		map[string]string{"boardId": boardID})
	c.Set("claims", claimsFor(viewer))
	e.h.GetBoardStories(c)
	var resp struct {
		Data []Story `json:"data"`
	}
	decodeJSON(e.t, w.Body.Bytes(), &resp)
	return w.Code, resp.Data
}

func (e *itEnv) rail(viewer string) []Group {
	e.t.Helper()
	c, w := testutil.NewGETContext("/api/v1/stories/rail", nil)
	c.Set("claims", claimsFor(viewer))
	e.h.GetRail(c)
	if w.Code != http.StatusOK {
		e.t.Fatalf("rail status %d: %s", w.Code, w.Body.String())
	}
	var resp struct {
		Data RailResponse `json:"data"`
	}
	decodeJSON(e.t, w.Body.Bytes(), &resp)
	return resp.Data.Groups
}

func idsOf(list []Story) []string {
	out := make([]string, 0, len(list))
	for _, s := range list {
		out = append(out, s.ID)
	}
	return out
}

// ─── Personal audiences ─────────────────────────────────────────────────────

func TestIntegration_UserStoryAudiences(t *testing.T) {
	e := newIT(t)
	owner := e.user("owner")
	friend := e.user("friend")
	follower := e.user("follower") // follows, but is not a mutual friend
	e.friend(owner, friend)
	e.follow(follower, owner)

	now := time.Now().UTC()
	expires := now.Add(2 * time.Hour)
	everyone := e.story(OwnerUser, owner, owner, PrivacyEveryone, now.Add(-4*time.Minute), expires, false)
	friends := e.story(OwnerUser, owner, owner, PrivacyFriends, now.Add(-3*time.Minute), expires, false)
	close := e.story(OwnerUser, owner, owner, PrivacyCloseFriends, now.Add(-2*time.Minute), expires, false)
	mine := e.story(OwnerUser, owner, owner, PrivacyOnlyMe, now.Add(-time.Minute), expires, false)
	e.closeFriend(owner, friend)

	if got := idsOf(e.listStories(owner, owner, "")); len(got) != 4 {
		t.Fatalf("the author must see all four slides, got %v", got)
	}

	// A follower sees only the public slide.
	if got := idsOf(e.listStories(follower, owner, "")); len(got) != 1 || got[0] != everyone {
		t.Fatalf("follower sees %v, want only %s", got, everyone)
	}

	// A mutual friend sees public + friends + close friends — never only_me.
	got := idsOf(e.listStories(friend, owner, ""))
	if len(got) != 3 {
		t.Fatalf("friend sees %v, want public+friends+close", got)
	}
	for _, id := range got {
		if id == mine {
			t.Fatal("only_me must never reach a friend")
		}
	}
	if got[0] != everyone || got[1] != friends || got[2] != close {
		t.Fatalf("unexpected friend view: %v", got)
	}
}

func TestIntegration_PrivateProfileRestrictsEveryoneAudience(t *testing.T) {
	e := newIT(t)
	owner := e.user("private-owner")
	visitor := e.user("visitor")
	friend := e.user("friend")
	e.privateProfile(owner)
	e.friend(owner, friend)

	now := time.Now().UTC()
	id := e.story(OwnerUser, owner, owner, PrivacyEveryone, now.Add(-time.Minute), now.Add(time.Hour), false)

	if got := e.listStories(visitor, owner, ""); len(got) != 0 {
		t.Fatalf("a private profile must hide its stories from a stranger, got %v", idsOf(got))
	}
	if got := idsOf(e.listStories(friend, owner, "")); len(got) != 1 || got[0] != id {
		t.Fatalf("a mutual friend must still see the story, got %v", got)
	}
}

// ─── GomoSub audiences and posting rights ───────────────────────────────────

func TestIntegration_BoardStoryAccessAndPosting(t *testing.T) {
	e := newIT(t)
	owner := e.user("board-owner")
	member := e.user("member")
	publisher := e.user("publisher")
	stranger := e.user("stranger")

	publicBoard := e.board("Публичный", "public", owner)
	memberBoard := e.board("Приватный", "private", owner)
	e.member(memberBoard, member, "")
	e.member(memberBoard, publisher, `{"can_post_stories": true}`)

	now := time.Now().UTC()
	pub := e.story(OwnerGosub, publicBoard, publisher, PrivacyEveryone, now.Add(-time.Minute), now.Add(time.Hour), false)
	priv := e.story(OwnerGosub, memberBoard, publisher, PrivacyEveryone, now.Add(-time.Minute), now.Add(time.Hour), false)

	// Public board: any authenticated user sees the story.
	if code, got := e.listBoardStories(stranger, publicBoard, ""); code != http.StatusOK || len(got) != 1 || got[0].ID != pub {
		t.Fatalf("stranger on a public board: status=%d stories=%v", code, idsOf(got))
	}
	// Private board: members only.
	if _, got := e.listBoardStories(stranger, memberBoard, ""); len(got) != 0 {
		t.Fatalf("stranger must not see a private board's stories, got %v", idsOf(got))
	}
	if _, got := e.listBoardStories(member, memberBoard, ""); len(got) != 1 || got[0].ID != priv {
		t.Fatalf("member must see the private board's stories, got %v", idsOf(got))
	}

	// Posting: a plain member without the permission is refused.
	if code := e.createBoardStory(member, memberBoard); code != http.StatusForbidden {
		t.Fatalf("member without can_post_stories: status=%d, want 403", code)
	}
	// A role with can_post_stories may publish.
	if code := e.createBoardStory(publisher, memberBoard); code != http.StatusCreated {
		t.Fatalf("publisher with can_post_stories: status=%d, want 201", code)
	}
	// The owner always may.
	if code := e.createBoardStory(owner, memberBoard); code != http.StatusCreated {
		t.Fatalf("board owner: status=%d, want 201", code)
	}
	// A stranger may not.
	if code := e.createBoardStory(stranger, memberBoard); code != http.StatusForbidden {
		t.Fatalf("stranger: status=%d, want 403", code)
	}
}

func (e *itEnv) createBoardStory(author, boardID string) int {
	e.t.Helper()
	key := author + "/story.jpg"
	c, w := testutil.NewPOSTContext("/api/v1/stories", map[string]interface{}{
		"owner_type": OwnerGosub,
		"board_id":   boardID,
		"kind":       KindPhoto,
		"media_key":  key,
	}, claimsFor(author), nil)
	e.h.CreateStory(c)
	return w.Code
}

// ─── Rail, views, viewers ───────────────────────────────────────────────────

func TestIntegration_RailViewsAndViewers(t *testing.T) {
	e := newIT(t)
	author := e.user("author")
	follower := e.user("follower")
	stranger := e.user("stranger")
	e.follow(follower, author)

	now := time.Now().UTC()
	st := e.story(OwnerUser, author, author, PrivacyEveryone, now.Add(-2*time.Minute), now.Add(time.Hour), false)

	rail := e.rail(follower)
	if len(rail) != 1 || rail[0].Owner.ID != author || len(rail[0].Stories) != 1 || rail[0].Stories[0].ID != st {
		t.Fatalf("follower's rail must contain the author's story, got %+v", rail)
	}
	if rail[0].HasUnread != true {
		t.Error("an unseen slide must mark the group unread")
	}
	if got := e.rail(stranger); len(got) != 0 {
		t.Fatalf("a non-follower must not get the author in the rail: %+v", got)
	}

	// First view counts, a re-open does not.
	count, counted := e.view(follower, st)
	if !counted || count != 1 {
		t.Fatalf("first view: counted=%v count=%d, want true/1", counted, count)
	}
	count, counted = e.view(follower, st)
	if counted || count != 1 {
		t.Fatalf("second view: counted=%v count=%d, want false/1", counted, count)
	}

	// The author's own view never counts.
	count, counted = e.view(author, st)
	if counted || count != 1 {
		t.Fatalf("author view: counted=%v count=%d, want false/1", counted, count)
	}

	// The rail reports the slide as read for the follower now.
	rail = e.rail(follower)
	if rail[0].HasUnread {
		t.Error("after the view the group must be read")
	}

	// Viewers list: author only.
	viewers := e.viewers(author, st)
	if len(viewers) != 1 || viewers[0].User.ID != follower {
		t.Fatalf("author must see the follower in the viewers list, got %+v", viewers)
	}
	if code := e.viewersStatus(stranger, st); code != http.StatusForbidden {
		t.Fatalf("stranger viewers status = %d, want 403", code)
	}
}

func (e *itEnv) view(viewer, storyID string) (int, bool) {
	e.t.Helper()
	c, w := testutil.NewPOSTContext("/api/v1/stories/"+storyID+"/view", nil,
		claimsFor(viewer), map[string]string{"id": storyID})
	e.h.RecordView(c)
	if w.Code != http.StatusOK {
		e.t.Fatalf("view status %d: %s", w.Code, w.Body.String())
	}
	var resp struct {
		Data struct {
			ViewsCount int  `json:"views_count"`
			Counted    bool `json:"counted"`
		} `json:"data"`
	}
	decodeJSON(e.t, w.Body.Bytes(), &resp)
	return resp.Data.ViewsCount, resp.Data.Counted
}

func (e *itEnv) viewersStatus(viewer, storyID string) int {
	_, status := e.viewersRaw(viewer, storyID)
	return status
}

func (e *itEnv) viewers(author, storyID string) []Viewer {
	list, status := e.viewersRaw(author, storyID)
	if status != http.StatusOK {
		e.t.Fatalf("viewers status %d", status)
	}
	return list
}

func (e *itEnv) viewersRaw(viewer, storyID string) ([]Viewer, int) {
	e.t.Helper()
	c, w := testutil.NewGETContextWithParams("/api/v1/stories/"+storyID+"/viewers", nil,
		map[string]string{"id": storyID})
	c.Set("claims", claimsFor(viewer))
	e.h.GetViewers(c)
	var resp struct {
		Data ViewersResponse `json:"data"`
	}
	decodeJSON(e.t, w.Body.Bytes(), &resp)
	return resp.Data.Viewers, w.Code
}

// ─── Lifecycle: expiry, archive, delete, reactions ──────────────────────────

func TestIntegration_ExpiryArchiveAndPinned(t *testing.T) {
	e := newIT(t)
	owner := e.user("archive-owner")
	visitor := e.user("visitor")
	e.friend(owner, visitor)

	now := time.Now().UTC()
	live := e.story(OwnerUser, owner, owner, PrivacyEveryone, now.Add(-time.Hour), now.Add(time.Hour), false)
	expired := e.story(OwnerUser, owner, owner, PrivacyEveryone, now.Add(-30*time.Hour), now.Add(-6*time.Hour), false)
	pinnedExpired := e.story(OwnerUser, owner, owner, PrivacyEveryone, now.Add(-40*time.Hour), now.Add(-16*time.Hour), true)

	if got := idsOf(e.listStories(visitor, owner, "")); len(got) != 1 || got[0] != live {
		t.Fatalf("only the live slide belongs to the profile, got %v", got)
	}
	if got := idsOf(e.listStories(owner, owner, "archive")); len(got) != 3 {
		t.Fatalf("the archive keeps expired stories, got %v", got)
	}
	if got := idsOf(e.listStories(visitor, owner, "pinned")); len(got) != 1 || got[0] != pinnedExpired {
		t.Fatalf("a pinned story survives expiry in the highlights, got %v", got)
	}
	if got := e.rail(visitor); len(got) != 1 || len(got[0].Stories) != 1 || got[0].Stories[0].ID != live {
		t.Fatalf("the rail must only carry live slides, got %+v", got)
	}

	// Pinned cap is enforced by the handler.
	for i := 0; i < MaxPinnedStories-1; i++ {
		e.story(OwnerUser, owner, owner, PrivacyEveryone, now.Add(-time.Duration(i+2)*time.Hour), now.Add(time.Hour), true)
	}
	c, w := testutil.NewPUTContext("/api/v1/stories/"+live,
		map[string]interface{}{"is_pinned": true}, claimsFor(owner), map[string]string{"id": live})
	e.h.UpdateStory(c)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("pinning above the cap: status=%d, want 400", w.Code)
	}
	_ = expired
}

func TestIntegration_DeleteAndReactions(t *testing.T) {
	e := newIT(t)
	author := e.user("author")
	viewer := e.user("viewer")
	e.friend(author, viewer)

	now := time.Now().UTC()
	st := e.story(OwnerUser, author, author, PrivacyEveryone, now.Add(-time.Minute), now.Add(time.Hour), false)

	// React: allowed once, replaced by a second tap.
	if code := e.react(viewer, st, "🔥"); code != http.StatusOK {
		t.Fatalf("react status=%d", code)
	}
	if code := e.react(viewer, st, "🎉"); code != http.StatusOK {
		t.Fatalf("re-reaction status=%d", code)
	}
	var emoji string
	var reactions int
	if err := e.db.QueryRow(`SELECT r.emoji, (SELECT COUNT(*) FROM story_reactions WHERE story_id::text = $1)
		FROM story_reactions r WHERE r.story_id::text = $1 AND r.user_id::text = $2`, st, viewer).
		Scan(&emoji, &reactions); err != nil {
		t.Fatalf("read reaction: %v", err)
	}
	if emoji != "🎉" || reactions != 1 {
		t.Fatalf("reaction = %q count=%d, want one 🎉", emoji, reactions)
	}
	// The author cannot react to their own story.
	if code := e.react(author, st, "🔥"); code != http.StatusBadRequest {
		t.Fatalf("own reaction status=%d, want 400", code)
	}

	// A stranger cannot delete; the author can.
	c, w := testutil.NewDELETEContextWithClaims("/api/v1/stories/"+st, nil,
		map[string]string{"id": st}, claimsFor(viewer))
	e.h.DeleteStory(c)
	if w.Code != http.StatusForbidden {
		t.Fatalf("stranger delete status=%d, want 403", w.Code)
	}
	c, w = testutil.NewDELETEContextWithClaims("/api/v1/stories/"+st, nil,
		map[string]string{"id": st}, claimsFor(author))
	e.h.DeleteStory(c)
	if w.Code != http.StatusOK {
		t.Fatalf("author delete status=%d: %s", w.Code, w.Body.String())
	}

	// Gone from every read path.
	if got := e.listStories(author, author, ""); len(got) != 0 {
		t.Fatalf("a deleted story must disappear, got %v", idsOf(got))
	}
	c, w = testutil.NewGETContextWithParams("/api/v1/stories/"+st, nil, map[string]string{"id": st})
	c.Set("claims", claimsFor(author))
	e.h.GetStory(c)
	if w.Code != http.StatusNotFound {
		t.Fatalf("single story status=%d, want 404", w.Code)
	}
}

func (e *itEnv) react(userID, storyID, emoji string) int {
	e.t.Helper()
	c, w := testutil.NewPUTContext("/api/v1/stories/"+storyID+"/reaction",
		map[string]interface{}{"emoji": emoji}, claimsFor(userID), map[string]string{"id": storyID})
	e.h.SetReaction(c)
	return w.Code
}

// ─── Close friends ──────────────────────────────────────────────────────────

func TestIntegration_CloseFriendsOnlyKeepsMutualFriends(t *testing.T) {
	e := newIT(t)
	owner := e.user("cf-owner")
	friend := e.user("cf-friend")
	stranger := e.user("cf-stranger")
	e.friend(owner, friend)

	c, w := testutil.NewPUTContext("/api/v1/stories/close-friends",
		map[string]interface{}{"user_ids": []string{friend, stranger, owner}},
		claimsFor(owner), nil)
	e.h.PutCloseFriends(c)
	if w.Code != http.StatusOK {
		t.Fatalf("put close friends status=%d: %s", w.Code, w.Body.String())
	}

	c, w = testutil.NewGETContext("/api/v1/stories/close-friends", nil)
	c.Set("claims", claimsFor(owner))
	e.h.GetCloseFriends(c)
	var resp struct {
		Data struct {
			Friends []Author `json:"friends"`
		} `json:"data"`
	}
	decodeJSON(t, w.Body.Bytes(), &resp)
	if len(resp.Data.Friends) != 1 || resp.Data.Friends[0].ID != friend {
		t.Fatalf("close friends = %+v, want only the mutual friend", resp.Data.Friends)
	}
}

// decodeJSON is a tiny helper so the assertions stay readable; a malformed
// response is a test failure, never a silent zero value.
func decodeJSON(t *testing.T, raw []byte, dst interface{}) {
	t.Helper()
	if err := json.Unmarshal(raw, dst); err != nil {
		t.Fatalf("decode response %s: %v", string(raw), err)
	}
}
