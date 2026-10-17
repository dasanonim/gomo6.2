import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { MessageList, type MessageListHandle, type MessageRenderExtras } from "./MessageList";
import {
  __resetMessageScrollAnchorsForTests,
  writeMessageScrollAnchor,
} from "./core/messageScrollAnchors";
import { INITIAL_WINDOW, MAX_DOM_MESSAGES, RESET_WINDOW } from "./core/slicing";
import type { MessageView } from "./types";

// ── Store mock ─────────────────────────────────────────────────────────────
// A real zustand store, so the component re-renders through the same
// subscription path it uses in the app.
const h = vi.hoisted(() => ({
  loadMoreMessages: vi.fn(async () => {}),
  flushPendingOlderMessages: vi.fn(() => false),
  queueMarkRead: vi.fn(),
  store: null as unknown as {
    getState: () => { messages: MessageView[] };
    setState: (patch: Record<string, unknown>) => void;
  },
}));

vi.mock("@/stores/messengerStore", async () => {
  const { create } = await import("zustand");
  const useMessengerStore = create(() => ({
    messages: [] as MessageView[],
    selectedConversationId: "c1" as string | null,
    me: { id: "me" } as { id: string } | null,
    receipts: new Map<string, Array<{ message_id: string; user_id: string; read_at: string | null; delivered_at: string | null }>>(),
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

// ── IntersectionObserver stand-in ──────────────────────────────────────────
// jsdom has no layout and never intersects anything, so the two window
// sentinels are driven explicitly. The contract under test is "a sentinel that
// becomes visible slides the window", not the browser's geometry.
type IOEntry = { isIntersecting: boolean; target: Element };
type IOCallback = (entries: IOEntry[]) => void;

const observers: Array<{ callback: IOCallback; targets: Element[]; rootMargin: string }> = [];

class MockIntersectionObserver {
  callback: IOCallback;
  targets: Element[] = [];
  rootMargin: string;
  constructor(callback: IOCallback, options?: { rootMargin?: string }) {
    this.callback = callback;
    this.rootMargin = options?.rootMargin ?? "";
    observers.push(this);
  }
  observe(target: Element) {
    this.targets.push(target);
  }
  unobserve(target: Element) {
    this.targets = this.targets.filter((candidate) => candidate !== target);
  }
  disconnect() {
    this.targets = [];
  }
  takeRecords() {
    return [];
  }
}

const triggerSentinel = (selector: string) => {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`sentinel not found: ${selector}`);
  const observer = observers.find((candidate) => candidate.targets.includes(element));
  if (!observer) throw new Error(`no observer is watching ${selector}`);
  act(() => {
    observer.callback([{ isIntersecting: true, target: element }]);
  });
};

// ── Layout stand-in ────────────────────────────────────────────────────────
// A fixed row height and viewport make every scroll decision observable:
// `scrollHeight` is derived from the mounted rows, so a prepend genuinely grows
// the scrollable content and the compensation can be asserted.
const ROW = 60;
const VIEWPORT = 600;
let scrollTopValue = 0;

const messageItemsIn = (node: HTMLElement) =>
  Array.from(node.querySelectorAll<HTMLElement>(".message-item"));

const itemOffsetTop = (node: HTMLElement) => {
  let top = 0;
  let sibling = node.previousElementSibling;
  while (sibling) {
    if (sibling.classList.contains("message-item")) top += ROW;
    sibling = sibling.previousElementSibling;
  }
  return top;
};

const savedDescriptors: Array<[string, PropertyDescriptor | undefined]> = [];

function installLayout() {
  const proto = HTMLElement.prototype;
  for (const key of ["clientHeight", "scrollHeight", "scrollTop", "offsetTop", "offsetHeight", "getBoundingClientRect"]) {
    savedDescriptors.push([key, Object.getOwnPropertyDescriptor(proto, key)]);
  }
  Object.defineProperty(proto, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("message-scroll") ? VIEWPORT : 0;
    },
  });
  Object.defineProperty(proto, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      if (!this.classList.contains("message-scroll")) return 0;
      return messageItemsIn(this).length * ROW + 2; // + the two 1px sentinels
    },
  });
  Object.defineProperty(proto, "scrollTop", {
    configurable: true,
    get() {
      return scrollTopValue;
    },
    set(value: number) {
      scrollTopValue = Number.isFinite(value) ? Math.max(0, value) : 0;
    },
  });
  Object.defineProperty(proto, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("message-item") ? ROW : 0;
    },
  });
  Object.defineProperty(proto, "offsetTop", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("message-item") ? itemOffsetTop(this) : 0;
    },
  });
  Object.defineProperty(proto, "getBoundingClientRect", {
    configurable: true,
    value(this: HTMLElement) {
      const top = this.classList.contains("message-item") ? itemOffsetTop(this) : 0;
      const height = this.classList.contains("message-item") ? ROW : 0;
      return { top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) };
    },
  });
}

function restoreLayout() {
  for (const [key, descriptor] of savedDescriptors.splice(0)) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
  }
}

// ── Fixtures ───────────────────────────────────────────────────────────────

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

const longList = (count: number, prefix = "m") =>
  Array.from({ length: count }, (_, index) => makeMessage(`${prefix}${index}`));

/** Captures every (message, prev, extras) tuple the list hands to the renderer. */
const captured: Array<{ id: string; prevId: string | null; extras: MessageRenderExtras }> = [];

const renderMessage = (message: MessageView, prev: MessageView | null, extras: MessageRenderExtras) => {
  captured.push({ id: message.id, prevId: prev?.id ?? null, extras });
  return <div data-testid={`msg-${message.id}`}>{message.content}</div>;
};

const mountList = (props: Partial<Parameters<typeof MessageList>[0]> = {}) =>
  render(<MessageList renderMessage={renderMessage} {...props} />);

const setStore = (patch: Record<string, unknown>) => {
  act(() => {
    h.store.setState(patch);
  });
};

const rows = (container: HTMLElement) => Array.from(container.querySelectorAll<HTMLElement>(".message-item"));
const rowIds = (container: HTMLElement) => rows(container).map((row) => row.dataset.messageId);
const scrollerOf = (container: HTMLElement) => container.querySelector<HTMLElement>(".message-scroll")!;

/** Scrolls the viewport, driving the same rAF pass the browser would. */
const scrollTo = async (container: HTMLElement, top: number) => {
  const scroller = scrollerOf(container);
  scrollTopValue = top;
  await act(async () => {
    fireEvent.scroll(scroller);
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
};

/** Waits out the scroll-settle window (the heavy pass runs after it). */
const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 220));
  });
};

beforeEach(() => {
  cleanup();
  captured.length = 0;
  observers.length = 0;
  scrollTopValue = 0;
  h.loadMoreMessages.mockClear();
  h.loadMoreMessages.mockImplementation(async () => {});
  h.flushPendingOlderMessages.mockClear();
  h.flushPendingOlderMessages.mockImplementation(() => false);
  h.queueMarkRead.mockClear();
  __resetMessageScrollAnchorsForTests();
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver =
    MockIntersectionObserver;
  installLayout();
  setStore({
    messages: [],
    selectedConversationId: "c1",
    me: { id: "me" },
    receipts: new Map(),
    hasMoreMessages: false,
    isLoadingMore: false,
  });
});

afterEach(() => {
  restoreLayout();
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("MessageList (native DOM slicing)", () => {
  it("mounts only the windowed slice, in source order", () => {
    setStore({ messages: longList(500) });

    const { container } = mountList();

    expect(rows(container)).toHaveLength(INITIAL_WINDOW);
    expect(rowIds(container)[0]).toBe(`m${500 - INITIAL_WINDOW}`);
    expect(rowIds(container).at(-1)).toBe("m499");
    // The renderer still sees the real neighbours from the full list, so
    // grouping and date separators stay correct at a window boundary.
    expect(captured[0].prevId).toBe(`m${500 - INITIAL_WINDOW - 1}`);
  });

  it("renders a normal-flow list: no spacer, no absolute rows, no transforms", () => {
    setStore({ messages: longList(30) });

    const { container } = mountList();

    expect(container.querySelector(".message-virtual-list")).toBeNull();
    const scroller = scrollerOf(container);
    expect(scroller.children).toHaveLength(1);
    expect(scroller.firstElementChild?.className).toContain("message-list");
    for (const row of rows(container)) {
      expect(row.style.position).toBe("");
      expect(row.style.transform).toBe("");
      expect(row.style.top).toBe("");
    }
  });

  it("brackets the slice with the two window sentinels", () => {
    setStore({ messages: longList(30) });

    const { container } = mountList();

    const list = container.querySelector(".message-list") as HTMLElement;
    expect(list.firstElementChild?.className).toContain("scroll-sentinel-top");
    expect(list.lastElementChild?.className).toContain("scroll-sentinel-bottom");
    expect(rows(container)[0].previousElementSibling).toBe(list.firstElementChild);
  });

  it("hands the renderer the grouping and date extras", () => {
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

  it("resolves the quoted message and the peer receipt into the extras", () => {
    setStore({
      messages: [
        makeMessage("a"),
        makeMessage("reply", { parent_message_id: "a" }),
      ],
      receipts: new Map([
        ["c1", [{ message_id: "reply", user_id: "peer", read_at: "2026-08-08T12:05:00.000Z", delivered_at: null }]],
      ]),
    });

    mountList();

    const reply = captured.find((entry) => entry.id === "reply");
    expect(reply?.extras.quoted?.id).toBe("a");
    expect(reply?.extras.peerReceipt?.message_id).toBe("reply");
    // The reader's own receipt never becomes the peer's.
    expect(captured.find((entry) => entry.id === "a")?.extras.quoted).toBeNull();
  });

  it("prefers messagesOverride over the store list (notes folder filter)", () => {
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

    const scroller = scrollerOf(container);
    expect(scroller.getAttribute("role")).toBe("log");
    expect(scroller.getAttribute("aria-live")).toBe("off");
    expect(container.querySelector('[role="status"]')).not.toBeNull();
  });

  it("opens at the newest message", () => {
    setStore({ messages: longList(200) });

    const { container } = mountList();

    const scroller = scrollerOf(container);
    expect(scroller.scrollTop).toBe(scroller.scrollHeight);
    expect(rowIds(container).at(-1)).toBe("m199");
  });

  it("restores the reader's place instead of jumping to the newest message", () => {
    writeMessageScrollAnchor("c1", { key: "m300", offset: 5 });
    setStore({ messages: longList(500) });

    const { container } = mountList();

    // The anchored row is mounted with runway above it and scrolled to its
    // exact offset (5px of it hidden above the fold).
    expect(rowIds(container)).toContain("m300");
    const scroller = scrollerOf(container);
    // 20 rows above it inside the restored window.
    expect(scroller.scrollTop).toBe(20 * ROW - 5);
  });

  it("falls back to the newest message when the anchored message is gone", () => {
    writeMessageScrollAnchor("c1", { key: "deleted-long-ago", offset: 5 });
    setStore({ messages: longList(200) });

    const { container } = mountList();

    const scroller = scrollerOf(container);
    expect(scroller.scrollTop).toBe(scroller.scrollHeight);
    expect(rowIds(container).at(-1)).toBe("m199");
  });

  it("offers a jump-to-latest button only while the reader is away from the end", async () => {
    setStore({ messages: longList(400) });
    const { container } = mountList();

    expect(container.querySelector(".scroll-to-bottom-btn")).toBeNull();

    await scrollTo(container, 0);
    await waitFor(() => {
      expect(container.querySelector(".scroll-to-bottom-btn")).not.toBeNull();
    });

    const scroller = scrollerOf(container);
    await scrollTo(container, scroller.scrollHeight - VIEWPORT);
    await waitFor(() => {
      expect(container.querySelector(".scroll-to-bottom-btn")).toBeNull();
    });
  });

  it("freezes the mounted window while reading history", async () => {
    setStore({ messages: longList(400) });
    const { container } = mountList();
    await scrollTo(container, 0);

    // The window stops following the tail...
    expect(rowIds(container).at(-1)).toBe("m399");

    // ...so an arrival is NOT mounted and does not move the reader.
    setStore({ messages: [...longList(400), ...longList(50, "new")] });
    expect(rowIds(container)).not.toContain("new0");
    expect(rowIds(container)).toHaveLength(INITIAL_WINDOW);
    await waitFor(() => {
      expect(container.querySelector(".scroll-to-bottom-badge")?.textContent).toBe("50");
    });
  });

  it("counts appended arrivals while reading history, but not prepended pages", async () => {
    const base = longList(400);
    setStore({ messages: base });
    const { container } = mountList();
    await scrollTo(container, 0);

    setStore({ messages: [...base, makeMessage("tail-1")] });
    await waitFor(() => {
      expect(container.querySelector(".scroll-to-bottom-badge")?.textContent).toBe("1");
    });

    // An older page is prepended: the array grows, but the tail does not move.
    setStore({ messages: [makeMessage("older"), ...base, makeMessage("tail-1")] });
    expect(container.querySelector(".scroll-to-bottom-badge")?.textContent).toBe("1");
  });

  it("does not chase new messages while the reader is at the end", () => {
    const base = longList(20);
    setStore({ messages: base });
    const { container } = mountList();

    setStore({ messages: [...base, makeMessage("tail-1")] });

    expect(container.querySelector(".scroll-to-bottom-btn")).toBeNull();
    expect(rowIds(container)).toContain("tail-1");
  });

  it("jump-to-latest re-seeds the window to the newest rows and snaps", async () => {
    const base = longList(400);
    setStore({ messages: base });
    const ref = createRef<MessageListHandle>();
    const { container } = mountList({ ref });
    await scrollTo(container, 0);

    setStore({ messages: [...base, ...longList(60, "new")] });
    await waitFor(() => {
      expect(container.querySelector(".scroll-to-bottom-badge")).not.toBeNull();
    });

    act(() => {
      ref.current?.scrollToBottom();
    });

    expect(rows(container)).toHaveLength(RESET_WINDOW);
    expect(rowIds(container)[0]).toBe(`new${60 - RESET_WINDOW}`);
    const scroller = scrollerOf(container);
    expect(scroller.scrollTop).toBe(scroller.scrollHeight);
    expect(container.querySelector(".scroll-to-bottom-btn")).toBeNull();
  });

  it("jumps straight to a loaded message outside the mounted window", () => {
    setStore({ messages: longList(500) });
    const ref = createRef<MessageListHandle>();
    const { container } = mountList({ ref });

    act(() => {
      ref.current?.scrollToMessage("m100");
    });

    expect(rowIds(container)).toContain("m100");
    const scroller = scrollerOf(container);
    // Centred: 20 rows above the target inside the new window.
    expect(scroller.scrollTop).toBe(20 * ROW - (VIEWPORT - ROW) / 2);
    expect(h.loadMoreMessages).not.toHaveBeenCalled();
  });

  it("pages older history when asked to reveal a message that is not loaded", () => {
    setStore({ messages: longList(50), hasMoreMessages: true });
    const ref = createRef<MessageListHandle>();
    mountList({ ref });

    act(() => {
      ref.current?.scrollToMessage("ancient");
    });

    expect(h.loadMoreMessages).toHaveBeenCalledWith("c1");
  });

  it("reports a read line for the newest fully visible message from someone else", async () => {
    setStore({
      messages: [
        makeMessage("peer-1", { sender_user_id: "peer" }),
        makeMessage("mine-1", { sender_user_id: "me" }),
      ],
    });

    mountList();

    await waitFor(() => {
      expect(h.queueMarkRead).toHaveBeenCalledWith("c1", "peer-1", expect.any(String));
    });
  });

  it("does not report a message that is below the fold", async () => {
    setStore({
      messages: [
        makeMessage("peer-1", { sender_user_id: "peer" }),
        // Own messages fill the viewport, so the read line cannot advance past
        // peer-1 even though peer-2 is mounted further down.
        ...Array.from({ length: 11 }, (_, index) => makeMessage(`filler-${index}`, { sender_user_id: "me" })),
        makeMessage("peer-2", { sender_user_id: "peer" }),
      ],
    });

    const { container } = mountList();
    await scrollTo(container, 0);
    await settle();

    expect(h.queueMarkRead).toHaveBeenCalledWith("c1", "peer-1", expect.any(String));
    expect(h.queueMarkRead).not.toHaveBeenCalledWith("c1", "peer-2", expect.any(String));
  });

  it("slides the window up into already-loaded rows and compensates the scroll", async () => {
    setStore({ messages: longList(500) });
    const { container } = mountList();
    await scrollTo(container, 0);
    await settle();

    // 50 rows were added ABOVE the viewport; the reader's place must not move,
    // so `scrollTop` grew by exactly the inserted height.
    expect(rows(container)).toHaveLength(INITIAL_WINDOW + 50);
    expect(rowIds(container)[0]).toBe(`m${500 - INITIAL_WINDOW - 50}`);
    expect(scrollerOf(container).scrollTop).toBe(50 * ROW);
  });

  it("requests a buffered older page when the window already reaches the oldest loaded row", async () => {
    setStore({ messages: longList(50), hasMoreMessages: true });
    const { container } = mountList();
    await scrollTo(container, 0);

    triggerSentinel(".scroll-sentinel-top");

    await waitFor(() => {
      expect(h.loadMoreMessages).toHaveBeenCalledWith("c1", { postpone: true });
    });
    // Nothing was inserted yet — the buffered page lands at rest.
    expect(rows(container)).toHaveLength(50);
  });

  it("inserts the buffered page above the reader and keeps their place", async () => {
    const base = longList(50);
    const older = longList(50, "old");
    setStore({ messages: base, hasMoreMessages: true });
    h.flushPendingOlderMessages.mockImplementation(() => {
      h.store.setState({ messages: [...older, ...base] });
      return true;
    });
    const { container } = mountList();
    await scrollTo(container, 0);
    await settle();

    expect(h.flushPendingOlderMessages).toHaveBeenCalledWith("c1");
    expect(rowIds(container)).toHaveLength(100);
    expect(rowIds(container)[0]).toBe("old0");
    expect(scrollerOf(container).scrollTop).toBe(50 * ROW);
  });

  it("garbage-collects rows above the ceiling without waiting for a scroll", () => {
    const base = longList(200);
    setStore({ messages: base });
    const { container } = mountList();

    // 200 arrivals while pinned to the bottom: the window grows, then the GC
    // pass trims the top down to the ceiling.
    setStore({ messages: [...base, ...longList(200, "new")] });

    expect(rows(container).length).toBeLessThanOrEqual(MAX_DOM_MESSAGES);
    expect(rowIds(container).at(-1)).toBe("new199");
    const scroller = scrollerOf(container);
    expect(scroller.scrollTop).toBe(scroller.scrollHeight);
  });

  it("does not re-render existing rows when 50 messages arrive", () => {
    const base = longList(200);
    setStore({ messages: base });
    mountList();
    captured.length = 0;

    setStore({ messages: [...base, ...longList(50, "new")] });

    // Only the arrivals rendered: the mounted rows kept their identity, so
    // React.memo never re-ran their renderer.
    expect(captured).toHaveLength(50);
    expect(captured.every((entry) => entry.id.startsWith("new"))).toBe(true);
  });

  it("re-renders rows when the ambient render version changes", () => {
    setStore({ messages: [makeMessage("a"), makeMessage("b")] });
    const { rerender } = render(
      <MessageList renderMessage={renderMessage} renderVersion={{ pinned: null }} />,
    );
    expect(captured).toHaveLength(2);

    captured.length = 0;
    rerender(<MessageList renderMessage={renderMessage} renderVersion={{ pinned: "a" }} />);

    expect(captured.map((entry) => entry.id)).toEqual(["a", "b"]);
  });
});
