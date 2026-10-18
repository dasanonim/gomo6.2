import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __forgetDraftsInMemoryForTests,
  __resetDraftsForTests,
  clearDraft,
  flushDrafts,
  readDraft,
  writeDraft,
} from "./drafts";

describe("drafts", () => {
  beforeEach(() => {
    vi.useRealTimers();
    __resetDraftsForTests();
  });

  it("round-trips a draft", () => {
    writeDraft("c1", "привет");
    expect(readDraft("c1")).toBe("привет");
  });

  it("keeps a draft per conversation", () => {
    writeDraft("c1", "для alice");
    writeDraft("c2", "для bob");

    expect(readDraft("c1")).toBe("для alice");
    expect(readDraft("c2")).toBe("для bob");
  });

  it("debounces the storage write but never the value", () => {
    vi.useFakeTimers();
    writeDraft("c1", "черновик");

    // Readable at once…
    expect(readDraft("c1")).toBe("черновик");
    // …while storage is untouched: the write is debounced, not per keystroke.
    expect(localStorage.getItem("gomo6:draft:c1")).toBeNull();

    flushDrafts();
    expect(localStorage.getItem("gomo6:draft:c1")).toBe("черновик");

    // And a reload still has it.
    __forgetDraftsInMemoryForTests();
    expect(readDraft("c1")).toBe("черновик");
  });

  it("survives a reload", () => {
    writeDraft("c1", "переживший перезагрузку");
    flushDrafts();
    __forgetDraftsInMemoryForTests();

    expect(readDraft("c1")).toBe("переживший перезагрузку");
  });

  it("clears the entry when the draft becomes empty (a sent message)", () => {
    writeDraft("c1", "отправлено");
    flushDrafts();
    clearDraft("c1");
    flushDrafts();
    __forgetDraftsInMemoryForTests();

    expect(readDraft("c1")).toBe("");
  });

  it("flushes a pending draft when the page is put away", () => {
    writeDraft("c1", "не потерять при закрытии");
    expect(localStorage.getItem("gomo6:draft:c1")).toBeNull();

    // iOS Safari fires `pagehide` when a tab is put away or a PWA is closed.
    window.dispatchEvent(new Event("pagehide"));

    expect(localStorage.getItem("gomo6:draft:c1")).toBe("не потерять при закрытии");
  });

  it("flushes a pending draft when the tab is hidden", () => {
    writeDraft("c1", "свёрнутая вкладка");
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");

    document.dispatchEvent(new Event("visibilitychange"));

    expect(localStorage.getItem("gomo6:draft:c1")).toBe("свёрнутая вкладка");
    visibility.mockRestore();
  });

  it("caps the stored text at the composer's limit", () => {
    writeDraft("c1", "x".repeat(5000));
    expect(readDraft("c1")).toHaveLength(4000);
  });

  it("does not throw when storage is unavailable", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    writeDraft("c1", "текст");
    expect(() => flushDrafts()).not.toThrow();
    expect(readDraft("c1")).toBe("текст");
    setItem.mockRestore();
  });
});
