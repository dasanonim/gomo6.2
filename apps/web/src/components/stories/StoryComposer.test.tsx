import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StoryComposer } from "./StoryComposer";
import { useStoriesStore } from "@/stores/storiesStore";

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "me", username: "me", avatar_url: null } }),
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
    friends: vi.fn(),
  },
}));

const api = vi.mocked((await import("@/services/storiesApi")).storiesApi);

beforeEach(() => {
  vi.clearAllMocks();
  useStoriesStore.getState().reset();
  useStoriesStore.setState({
    composer: { ownerType: "user", ownerId: "me", ownerName: "Me" },
  });
  api.create.mockResolvedValue({
    id: "new-story",
    owner_type: "user",
    owner_id: "me",
    author_id: "me",
    kind: "text",
    text: "привет",
    privacy: "everyone",
    is_pinned: false,
    views_count: 0,
    reactions_count: 0,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    is_viewed: false,
    is_own: true,
    my_reaction: null,
  });
});

describe("StoryComposer", () => {
  it("does not publish an empty slide", () => {
    render(<StoryComposer />);
    const publish = screen.getByRole("button", { name: "Опубликовать" });
    expect(publish).toBeDisabled();
  });

  it("publishes a text slide with the typed content and audience", async () => {
    render(<StoryComposer />);

    fireEvent.click(screen.getByRole("button", { name: "Текст" }));
    const editor = document.querySelector("[contenteditable]") as HTMLElement;
    editor.textContent = "привет";
    fireEvent.input(editor);

    const publish = screen.getByRole("button", { name: "Опубликовать" });
    expect(publish).not.toBeDisabled();
    fireEvent.click(publish);

    await waitFor(() =>
      expect(api.create).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "text", text: "привет", privacy: "everyone" }),
      ),
    );
    // The composer closes and the fresh slide opens in the player.
    expect(useStoriesStore.getState().composer).toBeNull();
    expect(useStoriesStore.getState().viewer?.storyId).toBe("new-story");
  });

  it("hides the audience picker for a GomoSub story", () => {
    useStoriesStore.setState({
      composer: { ownerType: "gosub", ownerId: "board", ownerName: "Board" },
    });
    render(<StoryComposer />);

    expect(screen.queryByText("Все")).toBeNull();
    expect(screen.getByText("Увидят участники GomoSub")).toBeInTheDocument();
  });
});
