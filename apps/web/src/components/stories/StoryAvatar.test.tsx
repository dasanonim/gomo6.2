import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StoryAvatar } from "./StoryAvatar";
import { useStoriesStore } from "@/stores/storiesStore";
import type { Story } from "@/types/stories";

vi.mock("@/components/UserAvatar", () => ({
  UserAvatar: ({ alt }: { alt?: string }) => <span data-testid="avatar">{alt}</span>,
}));

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
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    is_viewed: false,
    is_own: false,
    my_reaction: null,
    ...overrides,
  };
}

function renderAvatar(props: Partial<React.ComponentProps<typeof StoryAvatar>> = {}) {
  return render(
    <StoryAvatar
      ownerType="user"
      ownerId="u1"
      ownerName="Alice"
      stories={[]}
      {...props}
    />,
  );
}

describe("StoryAvatar", () => {
  beforeEach(() => {
    useStoriesStore.getState().reset();
  });

  it("opens the viewer at the first unread slide", () => {
    renderAvatar({
      stories: [story({ id: "seen", is_viewed: true }), story({ id: "fresh" })],
    });

    fireEvent.click(screen.getByRole("button", { name: /Alice/ }));

    expect(useStoriesStore.getState().viewer).toMatchObject({
      ownerType: "user",
      ownerId: "u1",
      storyId: "fresh",
    });
  });

  it("starts from the first slide when everything is read", () => {
    renderAvatar({ stories: [story({ id: "a", is_viewed: true })] });

    fireEvent.click(screen.getByRole("button", { name: /Alice/ }));

    expect(useStoriesStore.getState().viewer?.storyId).toBe("a");
  });

  it("opens the composer when the owner has no live story", () => {
    renderAvatar({ ownerName: "Alice", showAdd: true });

    fireEvent.click(screen.getByRole("button", { name: /Добавить историю/ }));

    expect(useStoriesStore.getState().composer).toMatchObject({
      ownerType: "user",
      ownerId: "u1",
      ownerName: "Alice",
    });
    expect(useStoriesStore.getState().viewer).toBeNull();
  });

  it("ignores expired slides when deciding what to open", () => {
    renderAvatar({
      stories: [story({ id: "old", expires_at: new Date(Date.now() - 1000).toISOString() })],
    });

    fireEvent.click(screen.getByRole("button", { name: /Alice/ }));

    expect(useStoriesStore.getState().viewer).toBeNull();
  });

  it("draws one ring segment per slide and one fewer after a view", () => {
    const { rerender } = renderAvatar({
      stories: [story({ id: "a", is_viewed: true }), story({ id: "b" })],
    });
    expect(document.querySelectorAll("[data-segment]")).toHaveLength(2);

    rerender(
      <StoryAvatar
        ownerType="user"
        ownerId="u1"
        ownerName="Alice"
        stories={[story({ id: "a", is_viewed: true }), story({ id: "b", is_viewed: true })]}
      />,
    );
    expect(document.querySelectorAll("[data-read='true']")).toHaveLength(2);
  });

  it("marks the ring green when an unread close-friends slide exists", () => {
    renderAvatar({ stories: [story({ privacy: "close_friends" })] });
    const stops = Array.from(document.querySelectorAll("stop")).map((s) =>
      s.getAttribute("stop-color"),
    );
    expect(stops).toContain("var(--story-ring-close-from)");
  });
});
