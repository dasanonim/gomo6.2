import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { MessageList, type MessageListHandle, type MessageRenderExtras } from "./MessageList";
import { writeMessageScrollAnchor, __resetMessageScrollAnchorsForTests } from "./core/messageScrollAnchors";
import type { MessageView } from "./types";

// ── Hoisted shared state (accessible from vi.mock factories) ──────────────
const h = vi.hoisted(() => ({
  loadMoreMessages: vi.fn(async () => {}),
  flushPendingOlderMessages: vi.fn(() => false),
  queueMarkRead: vi.fn(),
  // Assigned by the store mock; a real zustand store, so the component
  // re-renders through the same subscription path as in the app.
  store: null as unknown as { setState: (patch: Record<string, unknown>) => void },
  // Virtualizer stand-in controls.
  atBottom: true,
  scrollOffset: 0,
  rangeStart: 0,
  isScrolling: false,
  /** Tracked width of the stand-in scroller, i.e. the wrap width driver. */
  scrollRectWidth: 780,
  windowStart: 0,
  windowSize: 3,
  lastOptions: null as null | {
    count: number;
    anchorTo?: string;
    followOnAppend?: unknown;
    scrollEndThreshold?: number;
    overscan?: number;
    paddingEnd?: number;
    directDomUpdates?: boolean;
    getItemKey: (index: number) => unknown;
    estimateSize: (index: number) => number;
  },
  scrollToIndex: vi.fn(),
  scrollToEnd: vi.fn(),
  scrollToOffset: vi.fn(),
  resizeItem: vi.fn(),
  itemSizeCache: new Map<unknown, number>(),
}));

vi.mock("@/stores/messengerStore", async () => {
  const { create } = await import("zustand");
  const useMessengerStore = create(() => ({
    messages: [] as MessageView[],
    selectedConversationId: null as string | null,
    me: null as { id: string } | null,
    conversations: [] as Array<{ id: string; is_group: boolean }>,
    hasMoreMessages: false,
    isLoadingMore: false,
    loadMoreMessages: h.loadMoreMessages,
    flushPendingOlderMessages: h.flushPendingOlderMessages,
  }));
  h.store = useMessengerStore as unknown as typeof h.store;
  return {
    useMessengerStore,
    queueMarkRead: (...args: unknown[]) => h.queueMarkRead(...args),
  };
});

/**
 * jsdom has no layout: a real `useVirtualizer` measures a 0px-tall scroller and
 * renders nothing. This stand-in reproduces the *contract* the list depends on
 * — a window of virtual items with stable keys, a total size, and the chat
 * options it was configured with — without pretending to be scroll physics.
 * Real end-anchoring behaviour is verified in the browser, not here.
 */
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (opts: {
    count: number;
    estimateSize: (index: number) => number;
    getItemKey: (index: number) => unknown;
  }) => {
    h.lastOptions = opts as unknown as typeof h.lastOptions;
    const count = opts.count;
    const sizes = Array.from({ length: count }, (_, i) => opts.estimateSize(i));
    const starts: number[] = [];
    let running = 0;
    for (let i = 0; i < count; i += 1) {
      starts.push(running);
      running += sizes[i];
    }
    const total = running;
    const VIEWPORT = 600;
    const start = Math.max(0, Math.min(h.windowStart, Math.max(0, count - h.windowSize)));
    const end = Math.min(count, start + h.windowSize);
    return {
      getVirtualItems: () =>
        Array.from({ length: Math.max(0, end - start) }, (_, offset) => {
          const index = start + offset;
          return {
            index,
            key: opts.getItemKey(index),
            start: starts[index],
            size: sizes[index],
            end: starts[index] + sizes[index],
          };
        }),
      getTotalSize: () => total,
      // The component derives "at the end" from tracked values, so the stand-in
      // has to expose them the same way the real virtualizer does.
      get scrollRect() {
        return { height: VIEWPORT, width: h.scrollRectWidth };
      },
      get scrollOffset() {
        return h.atBottom ? Math.max(0, total - VIEWPORT) : h.scrollOffset;
      },
      get range() {
        return { startIndex: h.rangeStart, endIndex: Math.min(count - 1, h.rangeStart + 3) };
      },
      getOffsetForIndex: (index: number) => [starts[index] ?? 0, "start"] as const,
      measureElement: () => undefined,
      // The height cache the list primes before paint, and the API it primes
      // it through — modelled like the real virtualizer so the "already known"
      // check behaves the same.
      itemSizeCache: h.itemSizeCache,
      resizeItem: (index: number, size: number) => {
        h.itemSizeCache.set(h.lastOptions!.getItemKey(index), size);
        h.resizeItem(index, size);
      },
      // `directDomUpdates` contract: the virtualizer owns the spacer height.
      containerRef: (node: HTMLElement | null) => {
        if (node) node.style.height = `${total}px`;
      },
      scrollToIndex: (...args: unknown[]) => h.scrollToIndex(...args),
      scrollToEnd: (...args: unknown[]) => h.scrollToEnd(...args),
      scrollToOffset: (...args: unknown[]) => h.scrollToOffset(...args),
      getDistanceFromEnd: () => (h.atBottom ? 0 : 5000),
      get isScrolling() {
        return h.isScrolling;
      },
    };
  },
}));

const makeMessage = (id: string, overrides: Partial<MessageView> = {}): MessageView => ({
  id,
  conversation_id: "c1",
  sender_user_id: "u1",
  parent_message_id: null,
  content: `msg-${id}`,
  is_edited: false,
  is_deleted: false,
  edited_at: null,
  sent_at: "2026-08-08T12:00:00.000Z",
  client_id: id,
  ...overrides,
});

/** Captures every (message, prev, extras) tuple the list hands to the renderer. */
const captured: Array<{ id: string; prevId: string | null; extras: MessageRenderExtras }> = [];

const renderMessage = (message: MessageView, prev: MessageView | null, extras: MessageRenderExtras) => {
  captured.push({ id: message.id, prevId: prev?.id ?? null, extras });
  return <div data-testid={`msg-${message.id}`}>{message.content}</div>;
};

const mountList = (props: Partial<Parameters<typeof MessageList>[0]> = {}) =>
  render(<MessageList renderMessage={renderMessage} {...props} />);

/** Push a store patch through the real subscription path. */
const setStore = (patch: Record<string, unknown>) => {
  act(() => {
    h.store.setState(patch);
  });
};

/** A list long enough to overflow the stand-in viewport (600px). */
const longList = (count: number) => Array.from({ length: count }, (_, i) => makeMessage(`m${i}`));

const rows = (container: HTMLElement) => Array.from(container.querySelectorAll(".message-row"));

beforeEach(() => {
  cleanup();
  captured.length = 0;
  h.atBottom = true;
  h.scrollOffset = 0;
  h.rangeStart = 0;
  h.scrollRectWidth = 780;
  h.windowStart = 0;
  h.windowSize = 3;
  h.lastOptions = null;
  h.loadMoreMessages.mockClear();
  h.queueMarkRead.mockClear();
  h.scrollToIndex.mockClear();
  h.scrollToEnd.mockClear();
  h.scrollToOffset.mockClear();
  h.resizeItem.mockClear();
  h.flushPendingOlderMessages.mockClear();
  h.isScrolling = false;
  h.itemSizeCache.clear();
  __resetMessageScrollAnchorsForTests();
  setStore({
    messages: [],
    selectedConversationId: null,
    me: null,
    conversations: [],
    hasMoreMessages: false,
    isLoadingMore: false,
  });
});

describe("MessageList (virtualized)", () => {
  it("scales the height estimate with the column width, like the real wrap", () => {
    // The estimate drives every pre-measurement offset; a fixed
    // characters-per-line number is calibrated for one width and wrong by ~2x
    // on the other, which is what made iOS accumulate hundreds of pixels of
    // corrections and dump them in one batch when the scroll stopped.
    const long = { content: "я".repeat(220) };

    h.scrollRectWidth = 330; // phone-ish column
    setStore({ messages: [makeMessage("a", long)] });
    mountList();
    const narrow = h.lastOptions!.estimateSize(0);
    cleanup();

    h.scrollRectWidth = 780; // desktop column
    setStore({ messages: [makeMessage("a", long)] });
    mountList();
    const wide = h.lastOptions!.estimateSize(0);

    expect(narrow).toBeGreaterThan(wide);
    // ~22 chars/line narrow against ~55 wide: 220 chars is ~10 lines vs ~4.
    expect(narrow - wide).toBeGreaterThan(100);
  });

  it("treats explicit newlines as line breaks in the estimate", () => {
    h.scrollRectWidth = 330;

    setStore({ messages: [makeMessage("a", { content: "short" })] });
    mountList();
    const oneLine = h.lastOptions!.estimateSize(0);
    cleanup();

    // The content renders with `white-space: pre-wrap`, so "\n" is a real break.
    setStore({ messages: [makeMessage("a", { content: "short\nshort\nshort\nshort" })] });
    mountList();
    const fourLines = h.lastOptions!.estimateSize(0);

    expect(fourLines).toBeGreaterThan(oneLine + 40);
  });

  it("primes the height cache from the mounted rows before paint", () => {
    // jsdom has no layout, so the row height has to be faked — the point is the
    // contract: whatever a mounted row measures becomes the cached size in the
    // same commit, without waiting for the library's ResizeObserver.
    const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get: () => 77,
    });
    try {
      setStore({ messages: [makeMessage("a"), makeMessage("b")] });
      mountList();

      expect(h.resizeItem).toHaveBeenCalledWith(0, 77);
      expect(h.resizeItem).toHaveBeenCalledWith(1, 77);
    } finally {
      if (offsetHeight) Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetHeight);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight;
    }
  });

  it("stops reading the DOM once a row's height is known", () => {
    const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    let reads = 0;
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get: () => {
        reads += 1;
        return 77;
      },
    });
    try {
      setStore({ messages: [makeMessage("a"), makeMessage("b")] });
      mountList();
      const primed = h.resizeItem.mock.calls.length;
      expect(primed).toBeGreaterThan(0);

      // Any later commit (a new message, a prepend) reads only the genuinely
      // new rows: the ones already cached must not force another layout, since
      // that layout is what makes a scroll stutter.
      reads = 0;
      setStore({ messages: [makeMessage("a"), makeMessage("b"), makeMessage("c")] });
      expect(reads).toBe(1);
    } finally {
      if (offsetHeight) Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetHeight);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight;
    }
  });

  it("mounts only the virtual window, in source order, not the whole history", () => {
    h.windowStart = 40;
    setStore({ messages: Array.from({ length: 500 }, (_, i) => makeMessage(`m${i}`)) });

    const { container } = mountList();

    expect(rows(container)).toHaveLength(3);
    expect(rows(container).map((row) => row.getAttribute("data-message-id"))).toEqual([
      "m40",
      "m41",
      "m42",
    ]);
    // The renderer still sees the real neighbours from the full list, so
    // grouping and date separators stay correct at a window boundary.
    expect(captured.map((entry) => [entry.id, entry.prevId])).toEqual([
      ["m40", "m39"],
      ["m41", "m40"],
      ["m42", "m41"],
    ]);
  });

  it("positions rows absolutely inside a spacer owned by the virtualizer", () => {
    setStore({ messages: [makeMessage("a"), makeMessage("b")] });

    const { container } = mountList();

    const spacer = container.querySelector(".message-virtual-list") as HTMLElement;
    expect(spacer).not.toBeNull();
    // `directDomUpdates`: the spacer height comes from `containerRef`.
    expect(spacer.style.height).not.toBe("");
    for (const row of rows(container)) {
      expect((row as HTMLElement).style.position).toBe("absolute");
      expect((row as HTMLElement).style.top).toBe("0px");
      // The virtualizer owns the main-axis position — the row must not set it,
      // or React would overwrite the library's writes with stale offsets.
      expect((row as HTMLElement).style.transform).toBe("");
    }
  });

  it("configures the virtualizer for end-anchored chat", () => {
    setStore({ messages: [makeMessage("a")] });

    mountList();

    expect(h.lastOptions?.anchorTo).toBe("end");
    expect(h.lastOptions?.followOnAppend).toBe(true);
    // Deliberately narrow: a wide slack reads as the list tugging the reader down.
    expect(h.lastOptions?.scrollEndThreshold).toBeLessThanOrEqual(16);
    // Small on purpose: every mounted row outside the viewport is a row that
    // gets measured, and each measurement is a scroll-position correction.
    expect(h.lastOptions?.overscan).toBeLessThanOrEqual(8);
    expect(h.lastOptions?.overscan).toBeGreaterThanOrEqual(4);
    // Holds back React commits during a scroll — the main-thread cost that
    // makes an iOS momentum scroll stutter.
    expect(h.lastOptions?.directDomUpdates).toBe(true);
    // The bottom gap must take part in the scroll math, not hide below the fold.
    expect(h.lastOptions?.paddingEnd).toBeGreaterThan(0);
  });

  it("keys rows by the canonical identity, never by index", () => {
    setStore({
      messages: [
        makeMessage("server-1", { client_id: "local-1" }),
        makeMessage("server-2", { client_id: "local-2" }),
      ],
    });

    mountList();

    // client_id || id — an optimistic row keeps its slot when the server twin
    // replaces it, and prepended pages shift indexes without moving rows.
    expect(h.lastOptions?.getItemKey(0)).toBe("local-1");
    expect(h.lastOptions?.getItemKey(1)).toBe("local-2");
  });

  it("hands the renderer the grouping + date extras", () => {
    setStore({
      messages: [
        makeMessage("a", { sent_at: "2026-08-08T12:00:00.000Z" }),
        // Same sender within 2 minutes → consecutive, same day → no date label.
        makeMessage("b", { sent_at: "2026-08-08T12:01:00.000Z" }),
        // Next day → new date separator.
        makeMessage("c", { sent_at: "2026-08-09T09:00:00.000Z" }),
      ],
    });

    mountList();

    expect(captured[0].extras.isConsecutive).toBe(false);
    expect(captured[0].extras.dateLabel).toBeTruthy();
    expect(captured[1].extras.isConsecutive).toBe(true);
    expect(captured[1].extras.dateLabel).toBeNull();
    expect(captured[2].extras.isConsecutive).toBe(false);
    expect(captured[2].extras.dateLabel).toBeTruthy();
  });

  it("prefers messagesOverride over the store list (notes folder filter)", () => {
    h.windowSize = 30;
    setStore({ messages: [makeMessage("stored")] });

    mountList({ messagesOverride: [makeMessage("notes-1"), makeMessage("notes-2")] });

    expect(captured.map((entry) => entry.id)).toEqual(["notes-1", "notes-2"]);
  });

  it("renders nothing when there are no messages", () => {
    const { container } = mountList();

    expect(container.querySelector(".message-scroll")).toBeNull();
    expect(captured).toHaveLength(0);
  });

  it("exposes an accessible log that does not replay history on scroll", () => {
    setStore({ messages: [makeMessage("a")] });

    const { container } = mountList();

    const scroller = container.querySelector(".message-scroll") as HTMLElement;
    expect(scroller.getAttribute("role")).toBe("log");
    // Virtualization mounts/unmounts rows while scrolling; a live region would
    // make a screen reader re-read the history on every window change.
    expect(scroller.getAttribute("aria-live")).toBe("off");
    // New messages are announced through a dedicated throttled status region.
    expect(container.querySelector('[role="status"]')).not.toBeNull();
  });

  it("opens at the newest message", () => {
    setStore({ messages: [makeMessage("a"), makeMessage("b")] });

    mountList();

    expect(h.scrollToEnd).toHaveBeenCalled();
  });

  it("restores the reader's place instead of jumping to the newest message", () => {
    // `a` occupies the top of the viewport with 5px of it above the fold.
    writeMessageScrollAnchor("c1", { key: "b", offset: 5 });
    setStore({
      selectedConversationId: "c1",
      messages: [makeMessage("a"), makeMessage("b"), makeMessage("c")],
    });
    h.windowSize = 30;

    mountList();

    // Offsets are re-derived from the fresh measurements, not replayed blindly:
    // `b` starts after the (measured) height of `a`.
    const startOfB = h.lastOptions?.estimateSize(0) ?? 0;
    expect(h.scrollToOffset).toHaveBeenCalledWith(startOfB - 5, { align: "start" });
    expect(h.scrollToEnd).not.toHaveBeenCalled();
  });

  it("falls back to the newest message when the anchored message is gone", () => {
    writeMessageScrollAnchor("c1", { key: "deleted-long-ago", offset: 5 });
    setStore({ selectedConversationId: "c1", messages: [makeMessage("a"), makeMessage("b")] });

    mountList();

    expect(h.scrollToEnd).toHaveBeenCalled();
    expect(h.scrollToOffset).not.toHaveBeenCalled();
  });

  it("offers a jump-to-latest button only while the reader is away from the end", async () => {
    setStore({ messages: longList(40) });
    const { container } = mountList();
    const scroller = container.querySelector(".message-scroll") as HTMLElement;

    // Starts pinned: nothing to jump to.
    expect(container.querySelector(".scroll-to-bottom-btn")).toBeNull();

    // A gesture that leaves the end reveals the affordance...
    h.atBottom = false;
    h.scrollOffset = 0;
    fireEvent.pointerDown(scroller);
    fireEvent.scroll(scroller);
    await waitFor(() => {
      expect(container.querySelector(".scroll-to-bottom-btn")).not.toBeNull();
    });

    // ...and returning to the end puts it away again.
    h.atBottom = true;
    fireEvent.scroll(scroller);
    await waitFor(() => {
      expect(container.querySelector(".scroll-to-bottom-btn")).toBeNull();
    });
  });

  it("treats the reader's gesture as authoritative even if the coast starts at the end", async () => {
    setStore({ messages: longList(40) });
    const { container } = mountList();
    const scroller = container.querySelector(".message-scroll") as HTMLElement;

    fireEvent.pointerDown(scroller);
    // The first sample of a flick still reads "at the end": on iOS the tracked
    // offset lags the momentum, so this is the normal case, not an edge case.
    h.atBottom = true;
    fireEvent.scroll(scroller);
    await new Promise((resolve) => setTimeout(resolve, 30));

    // The coast genuinely leaves the end — the gesture must still win, and the
    // list must not be pinned back under the finger.
    h.atBottom = false;
    h.scrollOffset = 0;
    fireEvent.scroll(scroller);
    await waitFor(() => {
      expect(container.querySelector(".scroll-to-bottom-btn")).not.toBeNull();
    });
  });

  it("loads one history page per approach to the top, not a chain", async () => {
    setStore({
      selectedConversationId: "c1",
      messages: [makeMessage("a"), makeMessage("b")],
      hasMoreMessages: true,
    });
    h.windowSize = 10;
    // The reader is at the very top of the loaded history.
    h.rangeStart = 0;

    mountList();
    // The page is only *fetched* here — it is inserted at a rest, never under
    // a live coast.
    await waitFor(() => {
      expect(h.loadMoreMessages).toHaveBeenCalledTimes(1);
    });
    expect(h.loadMoreMessages).toHaveBeenCalledWith("c1", { postpone: true });

    // The page landed above the fold: the visible window no longer starts at
    // the oldest loaded message, so the loader stays disarmed until the reader
    // scrolls again. A chain here re-anchors and re-lays out under the finger.
    h.rangeStart = 40;
    setStore({
      messages: [makeMessage("older-1"), makeMessage("older-2"), makeMessage("a"), makeMessage("b")],
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(h.loadMoreMessages).toHaveBeenCalledTimes(1);
  });

  it("never inserts a buffered page while the coast is live", async () => {
    setStore({
      selectedConversationId: "c1",
      messages: [makeMessage("a"), makeMessage("b")],
      hasMoreMessages: true,
    });
    h.windowSize = 10;
    h.rangeStart = 0;
    h.isScrolling = true;

    mountList();
    await new Promise((resolve) => setTimeout(resolve, 350));
    // Inserting now would move the content under the reader — and on iOS the
    // compensation for it is deferred until the coast ends.
    expect(h.flushPendingOlderMessages).not.toHaveBeenCalled();

    // As soon as the scroller is at rest the buffered page goes in.
    h.isScrolling = false;
    await waitFor(() => {
      expect(h.flushPendingOlderMessages).toHaveBeenCalledWith("c1");
    });
  });

  it("counts appended arrivals while reading history, but not prepended pages", async () => {
    const base = longList(40);
    setStore({ messages: base });
    h.windowSize = 40;
    const { container } = mountList();
    const scroller = container.querySelector(".message-scroll") as HTMLElement;

    // The reader scrolls up: the list is no longer pinned to the newest message.
    h.atBottom = false;
    h.scrollOffset = 0;
    fireEvent.pointerDown(scroller);
    fireEvent.scroll(scroller);
    await waitFor(() => {
      expect(container.querySelector(".scroll-to-bottom-btn")).not.toBeNull();
    });

    // A new message lands at the tail.
    setStore({ messages: [...base, makeMessage("d")] });
    await waitFor(() => {
      expect(container.querySelector(".scroll-to-bottom-badge")?.textContent).toBe("1");
    });

    // An older page is prepended: the array grows, but the tail does not move.
    setStore({ messages: [makeMessage("older"), ...base, makeMessage("d")] });
    expect(container.querySelector(".scroll-to-bottom-badge")?.textContent).toBe("1");
  });

  it("does not chase new messages while the reader is at the end", async () => {
    const base = [makeMessage("a"), makeMessage("b")];
    setStore({ messages: base });
    const { container } = mountList();

    // No pill, no counter: the viewport is already following the newest message.
    setStore({ messages: [...base, makeMessage("c")] });

    expect(container.querySelector(".scroll-to-bottom-btn")).toBeNull();
  });

  it("pages older history when asked to reveal a message that is not loaded", () => {
    const ref = createRef<MessageListHandle>();
    setStore({
      selectedConversationId: "c1",
      messages: [makeMessage("a"), makeMessage("b")],
      hasMoreMessages: true,
    });

    mountList({ ref });

    act(() => {
      ref.current?.scrollToMessage("ancient");
    });

    expect(h.loadMoreMessages).toHaveBeenCalledWith("c1");
    expect(h.scrollToIndex).not.toHaveBeenCalled();
  });

  it("jumps straight to a message that is already loaded", () => {
    const ref = createRef<MessageListHandle>();
    setStore({ selectedConversationId: "c1", messages: [makeMessage("a"), makeMessage("b")] });
    h.windowSize = 10;

    mountList({ ref });

    act(() => {
      ref.current?.scrollToMessage("a");
    });

    expect(h.scrollToIndex).toHaveBeenCalledWith(0, { align: "center" });
    expect(h.loadMoreMessages).not.toHaveBeenCalled();
  });

  it("reports a read line for the newest fully visible message from someone else", async () => {
    const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get: () => 600,
    });
    try {
      setStore({
        selectedConversationId: "c1",
        me: { id: "me" },
        messages: [
          makeMessage("peer-1", { sender_user_id: "peer" }),
          makeMessage("mine-1", { sender_user_id: "me" }),
        ],
      });
      h.windowSize = 10;

      mountList();

      await waitFor(() => {
        expect(h.queueMarkRead).toHaveBeenCalled();
      });
      // Own messages never become the read line, and nothing below the fold is
      // reported — this is what keeps a scroll burst to one request.
      expect(h.queueMarkRead).toHaveBeenCalledWith("c1", "peer-1", expect.any(String));
    } finally {
      if (clientHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeight);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
    }
  });
});
