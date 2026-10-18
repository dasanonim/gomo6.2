import { describe, it, expect, beforeEach, vi } from "vitest";

import { buildFavoriteNoteSpec, FAVORITES_NOTE_FOLDER, syncFavoriteNote } from "./favoriteNotes";

const createFavoriteNote = vi.fn();
const deleteFavoriteNote = vi.fn();

vi.mock("@/stores/messengerStore", () => ({
    getConversationReadThrough: () => null,
  useMessengerStore: {
    getState: () => ({ createFavoriteNote, deleteFavoriteNote }),
  },
}));

describe("buildFavoriteNoteSpec", () => {
  it("maps a thread to a thread share token tagged «тема» in «Избранное»", () => {
    expect(buildFavoriteNoteSpec("thread", "t-1")).toEqual({
      content: "__SHARE__:thread:t-1",
      meta: { folder: FAVORITES_NOTE_FOLDER, tags: ["тема"] },
    });
  });

  it("maps a wall post to a wall share token tagged «пост»", () => {
    expect(buildFavoriteNoteSpec("wall_post", "w-9")).toEqual({
      content: "__SHARE__:wall:w-9",
      meta: { folder: "Избранное", tags: ["пост"] },
    });
  });
});

describe("syncFavoriteNote", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createFavoriteNote.mockResolvedValue("m1");
    deleteFavoriteNote.mockResolvedValue(undefined);
  });

  it("creates a note when the item became favorited", async () => {
    await syncFavoriteNote({ itemType: "thread", itemId: "t-1", nowFavorited: true });
    expect(createFavoriteNote).toHaveBeenCalledWith("__SHARE__:thread:t-1", {
      folder: "Избранное",
      tags: ["тема"],
    });
    expect(deleteFavoriteNote).not.toHaveBeenCalled();
  });

  it("deletes the note when the item was unfavorited", async () => {
    await syncFavoriteNote({ itemType: "wall_post", itemId: "w-9", nowFavorited: false });
    expect(deleteFavoriteNote).toHaveBeenCalledWith("__SHARE__:wall:w-9");
    expect(createFavoriteNote).not.toHaveBeenCalled();
  });

  it("never throws when the store action rejects", async () => {
    createFavoriteNote.mockRejectedValueOnce(new Error("boom"));
    await expect(
      syncFavoriteNote({ itemType: "thread", itemId: "t-1", nowFavorited: true }),
    ).resolves.toBeUndefined();
  });
});
