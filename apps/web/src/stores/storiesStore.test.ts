import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStoriesStore, walkViewer } from "./storiesStore";
import type { Story, StoryGroup } from "@/types/stories";

// vi.mock is hoisted, so the mock object must be created inside the factory.
vi.mock("@/services/storiesApi", () => ({
  storiesApi: {
    rail: vi.fn(),
    userStories: vi.fn(),
    boardStories: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    view: vi.fn(),
    setReaction: vi.fn(),
    removeReaction: vi.fn(),
    closeFriends: vi.fn(),
    setCloseFriends: vi.fn(),
  },
}));

const api = vi.mocked((await import("@/services/storiesApi")).storiesApi);

function story(overrides: Partial<Story> = {}): Story {
  return {
    id: "s1",
    owner_type: "user",
    owner_id: "u1",
    author_id: "u1",
    kind: "photo",
    text: "",
    privacy: "everyone",
    is_pinned: false,
    views_count: 0,
    reactions_count: 0,
    created_at: "2026-10-20T10:00:00.000Z",
    expires_at: "2026-10-21T10:00:00.000Z",
    is_viewed: false,
    is_own: false,
    my_reaction: null,
    ...overrides,
  };
}

function group(stories: Story[]): StoryGroup {
  return {
    owner: { type: "user", id: "u1", name: "Alice" },
    stories,
    has_unread: stories.some((s) => !s.is_viewed),
  };
}

describe("storiesStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStoriesStore.getState().reset();
  });

  it("fills the rail and the per-owner lists from one request", async () => {
    api.rail.mockResolvedValue([group([story()])]);

    await useStoriesStore.getState().loadRail();

    expect(useStoriesStore.getState().rail).toHaveLength(1);
    expect(useStoriesStore.getState().storiesFor("user", "u1").map((s) => s.id)).toEqual(["s1"]);
    expect(useStoriesStore.getState().railLoaded).toBe(true);
  });

  it("does not refetch a loaded rail unless forced", async () => {
    api.rail.mockResolvedValue([]);
    await useStoriesStore.getState().loadRail();
    await useStoriesStore.getState().loadRail();
    expect(api.rail).toHaveBeenCalledTimes(1);

    await useStoriesStore.getState().loadRail(true);
    expect(api.rail).toHaveBeenCalledTimes(2);
  });

  it("marks a slide viewed once and keeps the ring in sync", async () => {
    api.rail.mockResolvedValue([group([story(), story({ id: "s2" })])]);
    api.view.mockResolvedValue({ views_count: 1, counted: true });
    await useStoriesStore.getState().loadRail();

    const target = useStoriesStore.getState().storiesFor("user", "u1")[0];
    await useStoriesStore.getState().markViewed(target);

    expect(api.view).toHaveBeenCalledTimes(1);
    expect(useStoriesStore.getState().storiesFor("user", "u1")[0].is_viewed).toBe(true);
    // The group is still unread because of the second slide.
    expect(useStoriesStore.getState().rail[0].has_unread).toBe(true);

    await useStoriesStore.getState().markViewed(target);
    expect(api.view).toHaveBeenCalledTimes(1);
  });

  it("never reports a view for your own story", async () => {
    api.rail.mockResolvedValue([[group([story({ is_own: true })])][0]]);
    await useStoriesStore.getState().loadRail();

    await useStoriesStore.getState().markViewed(useStoriesStore.getState().storiesFor("user", "u1")[0]);
    expect(api.view).not.toHaveBeenCalled();
  });

  it("rolls a failed view back so it is retried on the next open", async () => {
    api.rail.mockResolvedValue([group([story()])]);
    api.view.mockRejectedValue(new Error("offline"));
    await useStoriesStore.getState().loadRail();

    await useStoriesStore.getState().markViewed(useStoriesStore.getState().storiesFor("user", "u1")[0]);
    expect(useStoriesStore.getState().storiesFor("user", "u1")[0].is_viewed).toBe(false);
  });

  it("adds a published story to the rail and the owner list immediately", async () => {
    api.create.mockResolvedValue(story({ id: "new", created_at: "2026-10-20T12:00:00.000Z" }));

    const published = await useStoriesStore.getState().publish(
      { owner_type: "user", kind: "text", text: "hi" },
      { ownerType: "user", ownerId: "u1", ownerName: "Alice" },
    );

    expect(published.id).toBe("new");
    expect(useStoriesStore.getState().storiesFor("user", "u1").map((s) => s.id)).toEqual(["new"]);
    expect(useStoriesStore.getState().rail[0].stories[0].id).toBe("new");
  });

  it("keeps an only_me story out of the rail", async () => {
    api.create.mockResolvedValue(story({ id: "private", privacy: "only_me", is_own: true }));

    await useStoriesStore.getState().publish(
      { owner_type: "user", kind: "text", text: "secret", privacy: "only_me" },
      { ownerType: "user", ownerId: "u1", ownerName: "Alice" },
    );

    expect(useStoriesStore.getState().rail).toHaveLength(0);
    expect(useStoriesStore.getState().storiesFor("user", "u1")).toHaveLength(0);
  });

  it("drops a deleted story from every list and empties the group", async () => {
    api.rail.mockResolvedValue([group([story()])]);
    await useStoriesStore.getState().loadRail();
    api.remove.mockResolvedValue(undefined);

    await useStoriesStore.getState().removeStory(useStoriesStore.getState().storiesFor("user", "u1")[0]);

    expect(useStoriesStore.getState().rail).toHaveLength(0);
    expect(useStoriesStore.getState().storiesFor("user", "u1")).toHaveLength(0);
  });

  it("toggles a reaction optimistically and reverts on failure", async () => {
    api.rail.mockResolvedValue([group([story({ reactions_count: 2 })])]);
    await useStoriesStore.getState().loadRail();
    const target = useStoriesStore.getState().storiesFor("user", "u1")[0];

    api.setReaction.mockResolvedValue({ emoji: "🔥", reactions_count: 3 });
    await useStoriesStore.getState().react(target, "🔥");
    let current = useStoriesStore.getState().storiesFor("user", "u1")[0];
    expect(current.my_reaction).toBe("🔥");
    expect(current.reactions_count).toBe(3);

    // Replacing one reaction with another must not inflate the counter.
    api.setReaction.mockResolvedValue({ emoji: "🎉", reactions_count: 3 });
    await useStoriesStore.getState().react(current, "🎉");
    current = useStoriesStore.getState().storiesFor("user", "u1")[0];
    expect(current.my_reaction).toBe("🎉");
    expect(current.reactions_count).toBe(3);

    api.removeReaction.mockRejectedValue(new Error("offline"));
    await useStoriesStore.getState().react(current, "🎉");
    current = useStoriesStore.getState().storiesFor("user", "u1")[0];
    expect(current.my_reaction).toBe("🎉");
    expect(current.reactions_count).toBe(3);
  });

  it("loads close friends once and refreshes after saving", async () => {
    const friend = { id: "f1", username: "bob", avatar_animated: false };
    api.closeFriends.mockResolvedValue([friend]);
    await useStoriesStore.getState().loadCloseFriends();
    await useStoriesStore.getState().loadCloseFriends();
    expect(api.closeFriends).toHaveBeenCalledTimes(1);

    api.setCloseFriends.mockResolvedValue(undefined);
    await useStoriesStore.getState().saveCloseFriends(["f1"]);
    expect(api.setCloseFriends).toHaveBeenCalledWith(["f1"]);
    expect(api.closeFriends).toHaveBeenCalledTimes(2);
  });

  it("refetches only the affected owner on a realtime event", async () => {
    api.userStories.mockResolvedValue([story({ id: "realtime" })]);

    useStoriesStore.getState().applyRealtimeEvent("new_story", {
      owner_type: "user",
      owner_id: "u2",
    });

    await vi.waitFor(() =>
      expect(useStoriesStore.getState().storiesFor("user", "u2").map((s) => s.id)).toEqual([
        "realtime",
      ]),
    );
    expect(api.userStories).toHaveBeenCalledWith("u2", "live");
  });
});

describe("walkViewer", () => {
  const base = {
    ownerType: "user" as const,
    ownerId: "u1",
    storyId: "b",
    queue: [
      { ownerType: "user" as const, ownerId: "u1", storyIds: ["a", "b"] },
      { ownerType: "gosub" as const, ownerId: "g1", storyIds: ["c"] },
    ],
  };

  it("moves inside one owner first", () => {
    expect(walkViewer({ ...base, storyId: "a" }, 1)).toMatchObject({
      ownerId: "u1",
      storyId: "b",
    });
  });

  it("crosses to the next owner's first slide", () => {
    expect(walkViewer({ ...base, storyId: "b" }, 1)).toMatchObject({
      ownerType: "gosub",
      ownerId: "g1",
      storyId: "c",
    });
  });

  it("crosses back to the previous owner's last slide", () => {
    const fromBoard = { ...base, ownerType: "gosub" as const, ownerId: "g1", storyId: "c" };
    expect(walkViewer(fromBoard, -1)).toMatchObject({ ownerId: "u1", storyId: "b" });
  });

  it("returns null at both ends so the caller closes the viewer", () => {
    expect(walkViewer({ ...base, storyId: "b" }, 1)?.ownerId).toBe("g1");
    const atEnd = { ...base, ownerType: "gosub" as const, ownerId: "g1", storyId: "c" };
    expect(walkViewer(atEnd, 1)).toBeNull();
    expect(walkViewer({ ...base, storyId: "a" }, -1)).toBeNull();
  });
});
