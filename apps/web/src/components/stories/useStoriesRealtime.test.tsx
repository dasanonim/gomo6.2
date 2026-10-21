import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStoriesStore } from "@/stores/storiesStore";
import type { Story } from "@/types/stories";
import { useStoriesRealtime } from "./useStoriesRealtime";

const ws = vi.hoisted(() => ({
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  on: vi.fn((_type: string, _handler: (message: unknown) => void) => vi.fn()),
}));

vi.mock("@/services/websocket", () => ({ wsService: ws }));

function story(id: string): Story {
  return {
    id,
    owner_type: "user",
    owner_id: "peer",
    author_id: "peer",
    kind: "photo",
    text: "",
    privacy: "everyone",
    is_pinned: false,
    views_count: 0,
    reactions_count: 0,
    created_at: "2026-10-20T10:00:00.000Z",
    expires_at: "2099-10-21T10:00:00.000Z",
    is_viewed: false,
    is_own: false,
    my_reaction: null,
  };
}

describe("useStoriesRealtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStoriesStore.getState().reset();
  });

  it("subscribes to every rail owner plus the author's counter room", () => {
    useStoriesStore.setState({
      rail: [
        {
          owner: { type: "user", id: "peer", name: "Peer" },
          stories: [story("s1")],
          has_unread: true,
        },
        {
          owner: { type: "gosub", id: "board", name: "Board" },
          stories: [story("b1")],
          has_unread: false,
        },
      ],
      byOwner: { "user:peer": [story("s1")] },
    });

    const { unmount } = renderHook(() => useStoriesRealtime("me"));

    expect(ws.subscribe).toHaveBeenCalledWith("stories_user_peer");
    expect(ws.subscribe).toHaveBeenCalledWith("stories_board_board");
    expect(ws.subscribe).toHaveBeenCalledWith("stories_owner_me");

    unmount();
    expect(ws.unsubscribe).toHaveBeenCalledWith("stories_user_peer");
    expect(ws.unsubscribe).toHaveBeenCalledWith("stories_owner_me");
  });

  it("applies a live view counter to the stored story", () => {
    useStoriesStore.setState({
      rail: [
        {
          owner: { type: "user", id: "peer", name: "Peer" },
          stories: [story("s1")],
          has_unread: true,
        },
      ],
      byOwner: { "user:peer": [story("s1")] },
    });

    renderHook(() => useStoriesRealtime("me"));

    const entry = ws.on.mock.calls.find(([type]) => type === "story_viewed");
    expect(entry).toBeTruthy();
    act(() => {
      entry![1]({ data: { story_id: "s1", views_count: 7 } });
    });

    expect(useStoriesStore.getState().storiesFor("user", "peer")[0].views_count).toBe(7);
  });

  it("re-subscribes when the rail gains an owner and drops the old rooms", () => {
    useStoriesStore.setState({
      rail: [
        {
          owner: { type: "user", id: "peer", name: "Peer" },
          stories: [story("s1")],
          has_unread: true,
        },
      ],
      byOwner: { "user:peer": [story("s1")] },
    });

    const { rerender } = renderHook(() => useStoriesRealtime("me"));
    act(() => {
      useStoriesStore.setState({
        rail: [
          {
            owner: { type: "user", id: "another", name: "Another" },
            stories: [story("s2")],
            has_unread: true,
          },
        ],
      });
    });
    rerender();

    expect(ws.unsubscribe).toHaveBeenCalledWith("stories_user_peer");
    expect(ws.subscribe).toHaveBeenCalledWith("stories_user_another");
  });
});
