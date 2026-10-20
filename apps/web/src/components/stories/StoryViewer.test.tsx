import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StoryViewer } from "./StoryViewer";
import { useStoriesStore } from "@/stores/storiesStore";
import type { Story } from "@/types/stories";

vi.mock("@/components/UserAvatar", () => ({
  UserAvatar: () => <span data-testid="avatar" />,
}));

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
    viewers: vi.fn(),
  },
}));

const api = vi.mocked((await import("@/services/storiesApi")).storiesApi);

function story(overrides: Partial<Story> = {}): Story {
  return {
    id: "s1",
    owner_type: "user",
    owner_id: "peer",
    author_id: "peer",
    kind: "photo",
    media_key: "peer/1.jpg",
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

function seed(stories: Story[], currentId = stories[0].id) {
  useStoriesStore.setState({
    viewer: {
      ownerType: "user",
      ownerId: "peer",
      storyId: currentId,
      queue: [
        {
          ownerType: "user",
          ownerId: "peer",
          storyIds: stories.map((item) => item.id),
        },
      ],
    },
    byOwner: { "user:peer": stories },
    rail: [
      {
        owner: { type: "user", id: "peer", name: "Bob" },
        stories,
        has_unread: true,
      },
    ],
  });
}

function renderViewer() {
  return render(
    <MemoryRouter>
      <StoryViewer />
    </MemoryRouter>,
  );
}

describe("StoryViewer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStoriesStore.getState().reset();
    api.view.mockResolvedValue({ views_count: 1, counted: true });
    api.remove.mockResolvedValue(undefined);
    api.update.mockResolvedValue(story());
  });

  it("renders nothing while the viewer is closed", () => {
    renderViewer();
    expect(screen.queryByTestId("story-viewer")).toBeNull();
  });

  it("shows the slide and reports the view once", async () => {
    seed([story()]);
    renderViewer();

    expect(screen.getByTestId("story-image")).toHaveAttribute(
      "src",
      "/storage/v1/object/stories/peer/1.jpg",
    );
    await waitFor(() => expect(api.view).toHaveBeenCalledWith("s1"));
    expect(screen.getByText("Bob")).toBeInTheDocument();
  });

  it("moves to the next slide and closes after the last one", () => {
    seed([story({ id: "s1" }), story({ id: "s2", kind: "text", text: "привет" })]);
    renderViewer();

    fireEvent.click(screen.getByRole("button", { name: "Следующая история" }));
    expect(useStoriesStore.getState().viewer?.storyId).toBe("s2");
    expect(screen.getByText("привет")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Следующая история" }));
    expect(useStoriesStore.getState().viewer).toBeNull();
  });

  it("goes back to the previous slide", () => {
    seed([story({ id: "s1" }), story({ id: "s2" })], "s2");
    renderViewer();

    fireEvent.click(screen.getByRole("button", { name: "Предыдущая история" }));
    expect(useStoriesStore.getState().viewer?.storyId).toBe("s1");
  });

  it("closes on Escape", () => {
    seed([story()]);
    renderViewer();

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(useStoriesStore.getState().viewer).toBeNull();
  });

  it("closes on the close button", () => {
    seed([story()]);
    renderViewer();

    fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    expect(useStoriesStore.getState().viewer).toBeNull();
  });

  it("shows the audience badge and view count for your own story, not reactions", () => {
    seed([story({ is_own: true, views_count: 7, privacy: "close_friends" })]);
    renderViewer();

    expect(screen.getByText("Избранные")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /7 просмотров/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "❤️" })).toBeNull();
    expect(api.view).not.toHaveBeenCalled();
  });

  it("reacts to someone else's story from the footer", () => {
    seed([story()]);
    renderViewer();
    api.setReaction.mockResolvedValue({ emoji: "🔥", reactions_count: 1 });

    fireEvent.click(screen.getByRole("button", { name: "🔥" }));

    expect(api.setReaction).toHaveBeenCalledWith("s1", "🔥");
  });

  it("deletes an own story and moves on", async () => {
    seed([story({ id: "s1", is_own: true }), story({ id: "s2" })]);
    renderViewer();

    const trigger = screen.getByRole("button", { name: "Действия" });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByText("Удалить историю"));
    fireEvent.click(await screen.findByRole("button", { name: "Удалить" }));

    await waitFor(() => expect(api.remove).toHaveBeenCalledWith("s1"));
  });

  it("locks body scroll while open and restores it on close", () => {
    seed([story()]);
    const { unmount } = renderViewer();
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.body.style.overflow).toBe("");
  });
});
