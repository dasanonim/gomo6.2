import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { MessageList, type MessageListHandle, type MessageRenderExtras } from "./MessageList";
import {
  __resetMessageScrollAnchorsForTests,
  writeMessageScrollAnchor,
} from "./core/messageScrollAnchors";
import { INITIAL_WINDOW, MAX_DOM_MESSAGES, RESET_WINDOW, WINDOW_STEP } from "./core/slicing";
import { __resetFasterdomForTests } from "./core/fasterdom";
import { __setScrollDiagnosticsEnabled, readScrollDiagnostics } from "./core/scrollDiagnostics";
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
    getConversationReadThrough: () => null,
    useMessengerStore,
    queueMarkRead: (...args: unknown[]) => h.queueMarkRead(...args),
  };
});

// ── IntersectionObserver stand-in ──────────────────────────────────────────
// jsdom has no layout and never intersects anything, so the two sentinels are
// driven explicitly. The contract under test is "a sentinel that becomes visible
// slides the window", not the browser's geometry.
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
// A fixed row height and viewport make every scroll decision observable. The
// scroller CLAMPS `scrollTop` the way a browser does, so the bottom sentinel
// contract ("write 1e7, land on the newest row") is testable.
const ROW = 60;
const VIEWPORT = 600;
let viewportHeight = VIEWPORT;
/** Viewport coordinate of the scroller's top edge (a pinned banner moves it). */
let scrollerTop = 0;
let scrollTopValue = 0;

const itemsIn = (node: HTMLElement) => node.querySelectorAll(".message-item").length;
const contentHeight = (node: HTMLElement) => itemsIn(node) * ROW + 2; // + the two 1px sentinels

const itemOffsetTop = (node: HTMLElement) => {
  let top = 0;
  let sibling = node.previousElementSibling;
  while (sibling) {
    if (sibling.classList.contains("message-item")) top += ROW;
    sibling = sibling.previousElementSibling;
  }
  return top;
};

// ── ResizeObserver stand-in ────────────────────────────────────────────────
// The scroller's box changing (a pinned banner, a taller composer, the mobile
// keyboard) is the one geometry change no React commit covers.
const resizeObservers: Array<{ callback: () => void; targets: Element[] }> = [];

class MockResizeObserver {
  callback: () => void;
  targets: Element[] = [];
  constructor(callback: () => void) {
    this.callback = callback;
    resizeObservers.push(this);
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
}

const fireResize = () => {
  act(() => {
    for (const observer of resizeObservers) {
      if (observer.targets.length > 0) observer.callback();
    }
  });
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
      return this.classList.contains("message-scroll") ? viewportHeight : 0;
    },
  });
  Object.defineProperty(proto, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("message-scroll") ? contentHeight(this) : 0;
    },
  });
  Object.defineProperty(proto, "scrollTop", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("message-scroll") ? scrollTopValue : 0;
    },
    set(this: HTMLElement, value: number) {
      if (!this.classList.contains("message-scroll")) return;
      const max = Math.max(0, contentHeight(this) - viewportHeight);
      scrollTopValue = Number.isFinite(value) ? Math.min(Math.max(0, value), max) : 0;
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
      if (this.classList.contains("message-item")) return itemOffsetTop(this);
      if (this.classList.contains("chat-unread-divider")) {
        // Zero-height in jsdom: it sits where the rows above it end.
        let top = 0;
        let sibling = this.previousElementSibling;
        while (sibling) {
          if (sibling.classList.contains("message-item")) top += ROW;
          sibling = sibling.previousElementSibling;
        }
        return top;
      }
      if (this.classList.contains("fab-trigger")) return itemsIn(this.closest(".message-scroll")!) * ROW + 2;
      return 0;
    },
  });
  Object.defineProperty(proto, "getBoundingClientRect", {
    configurable: true,
    value(this: HTMLElement) {
      // Viewport coordinates: a row above the fold has a negative top, and the
      // scroller itself starts at the top of the viewport.
      const isScroller = this.classList.contains("message-scroll");
      const scroller = isScroller ? this : this.closest<HTMLElement>(".message-scroll");
      const contentTop = this.classList.contains("message-item")
        ? itemOffsetTop(this)
        : this.classList.contains("chat-unread-divider")
          ? (() => {
              let top = 0;
              let sibling = this.previousElementSibling;
              while (sibling) {
                if (sibling.classList.contains("message-item")) top += ROW;
                sibling = sibling.previousElementSibling;
              }
              return top;
            })()
          : this.classList.contains("fab-trigger") && scroller
            ? itemsIn(scroller) * ROW + 2
            : 0;
      const height = isScroller ? viewportHeight : this.classList.contains("message-item") ? ROW : 0;
      const top = isScroller ? scrollerTop : contentTop - (scroller ? scrollTopValue : 0);
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

const setStore = (patch: Record<string, unknown>) => {
  act(() => {
    h.store.setState(patch);
  });
};

const rows = (container: HTMLElement) => Array.from(container.querySelectorAll<HTMLElement>(".message-item"));
const rowIds = (container: HTMLElement) => rows(container).map((row) => row.dataset.messageId);
const scrollerOf = (container: HTMLElement) => container.querySelector<HTMLElement>(".message-scroll")!;
const bottomOf = (container: HTMLElement) =>
  Math.max(0, contentHeight(scrollerOf(container)) - viewportHeight);

/**
 * Runs the batched DOM passes the engine defers to frames: rAF for the
 * measurements, a microtask for the mutation it returns, and any pass the
 * mutation itself scheduled (a settled frame, not an arbitrary one — the guard
 * against our own write's scroll echo is cleared on the next pass, exactly as in
 * a browser, where the echo arrives in the following frame's scroll step).
 */
const flushCommit = async () => {
  await act(async () => {
    for (let frame = 0; frame < 3; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await Promise.resolve();
      await Promise.resolve();
    }
  });
};

/** One frame only: the pass the engine runs, no further frames. */
const flushFrame = async () => {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await Promise.resolve();
    await Promise.resolve();
  });
};

/** Fire the scroll event our own write produces, in the same frame as the write. */
const echoOwnWrite = async (scroller: HTMLElement) => {
  await act(async () => {
    fireEvent.scroll(scroller);
  });
};

const mountList = async (
  props: Partial<Parameters<typeof MessageList>[0]> = {},
  ref?: React.RefObject<MessageListHandle | null>,
) => {
  const view = render(<MessageList ref={ref} renderMessage={renderMessage} {...props} />);
  await flushCommit();
  return view;
};

/** Scrolls the viewport, driving the same frame pass the browser would. */
const scrollTo = async (container: HTMLElement, top: number) => {
  const scroller = scrollerOf(container);
  scrollTopValue = top;
  await act(async () => {
    fireEvent.scroll(scroller);
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
};

/** Waits out the verified-rest window (reads and deferred mounts land there). */
const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
  await flushCommit();
};

beforeEach(() => {
  cleanup();
  captured.length = 0;
  observers.length = 0;
  scrollTopValue = 0;
  viewportHeight = VIEWPORT;
  scrollerTop = 0;
  resizeObservers.length = 0;
  h.loadMoreMessages.mockClear();
  h.loadMoreMessages.mockImplementation(async () => {});
  h.flushPendingOlderMessages.mockClear();
  h.flushPendingOlderMessages.mockImplementation(() => false);
  h.queueMarkRead.mockClear();
  __resetMessageScrollAnchorsForTests();
  __resetFasterdomForTests();
  __setScrollDiagnosticsEnabled(false);
  document.documentElement.classList.remove("has-scroll-anchoring");
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver =
    MockIntersectionObserver;
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = MockResizeObserver;
  // The glide is a real animation; tests run it instantly through the
  // reduced-motion path (the same one the app uses when the user asks for it).
  window.matchMedia = ((query: string) => ({
    matches: query.includes("prefers-reduced-motion"),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
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

describe("MessageList — window", () => {  it("mounts a bounded window that ends at the newest message", async () => {
    setStore({ messages: longList(500) });

    const { container } = await mountList();

    expect(rows(container)).toHaveLength(INITIAL_WINDOW);
    expect(rowIds(container)[0]).toBe(`m${500 - INITIAL_WINDOW}`);
    expect(rowIds(container).at(-1)).toBe("m499");
  });

  it("opens pinned to the newest message", async () => {
    setStore({ messages: longList(200) });

    const { container } = await mountList();

    expect(scrollerOf(container).scrollTop).toBe(bottomOf(container));
  });

  it("keeps the rows in normal flow — no spacer, no absolute placement", async () => {
    setStore({ messages: longList(40) });

    const { container } = await mountList();
    const [row] = rows(container);

    expect(row.style.position).toBe("");
    expect(row.style.top).toBe("");
    expect(row.style.transform).toBe("");
    expect(row.classList.contains("chat-native-row")).toBe(true);
    expect(container.querySelector(".message-spacer")).toBeNull();
  });

  it("renders nothing for an empty conversation", async () => {
    const { container } = await mountList();
    expect(container.querySelector(".message-scroll")).toBeNull();
  });

  it("is not a live region: the window slides, so rows must not be announced", async () => {
    setStore({ messages: longList(10) });

    const { container } = await mountList();
    const scroller = scrollerOf(container);

    expect(scroller.getAttribute("role")).toBe("log");
    expect(scroller.getAttribute("aria-live")).toBe("off");
  });
});

describe("MessageList — rendering contract", () => {
  it("passes grouping, date separators, quotes and receipts to the renderer", async () => {
    const base = longList(3);
    const quoted = makeMessage("q1", { content: "quoted" });
    setStore({
      messages: [
        quoted,
        ...base,
        makeMessage("m3", { parent_message_id: quoted.id, sent_at: "2026-08-08T12:00:10.000Z" }),
      ],
      receipts: new Map([
        ["c1", [{ message_id: "m2", user_id: "u1", read_at: "2026-08-08T12:00:20.000Z", delivered_at: null }]],
      ]),
    });

    await mountList();

    const last = captured.at(-1)!;
    expect(last.extras.quoted?.id).toBe("q1");
    expect(captured.length).toBeGreaterThan(0);
    const withReceipt = captured.find((entry) => entry.id === "m2");
    expect(withReceipt?.extras.peerReceipt?.read_at).toBe("2026-08-08T12:00:20.000Z");
  });

  it("renders the filtered notes view when one is supplied", async () => {
    const messages = longList(20);
    setStore({ messages });

    const { container } = await mountList({ messagesOverride: messages.slice(15) });

    expect(rowIds(container)).toEqual(["m15", "m16", "m17", "m18", "m19"]);
  });

  it("re-renders mounted rows when the ambient render version changes", async () => {
    setStore({ messages: longList(5) });
    const { container, rerender } = await mountList({ renderVersion: { pinned: null } });
    captured.length = 0;

    rerender(
      <MessageList renderMessage={renderMessage} renderVersion={{ pinned: "m2" }} />,
    );

    expect(captured.map((entry) => entry.id)).toEqual(["m0", "m1", "m2", "m3", "m4"]);
    expect(container).toBeTruthy();
  });
});

describe("MessageList — bottom stickiness", () => {
  it("arms native scroll snapping at the bottom and disarms it in history", async () => {
    setStore({ messages: longList(200) });

    const { container } = await mountList();
    const scroller = scrollerOf(container);
    expect(scroller.classList.contains("with-bottom-snap")).toBe(true);

    await scrollTo(container, 0);
    expect(scroller.classList.contains("with-bottom-snap")).toBe(false);

    await scrollTo(container, bottomOf(container));
    expect(scroller.classList.contains("with-bottom-snap")).toBe(true);
  });

  it("shows the badge and the FAB once the reader leaves the bottom", async () => {
    setStore({ messages: longList(200) });
    const { container } = await mountList();
    expect(container.querySelector(".scroll-to-bottom-btn")).toBeNull();

    await scrollTo(container, 0);

    expect(container.querySelector(".scroll-to-bottom-btn")).not.toBeNull();
  });

  it("pins to the new bottom when a message arrives while following", async () => {
    setStore({ messages: longList(200) });
    const { container } = await mountList();

    setStore({ messages: [...longList(200), makeMessage("new1", { sent_at: "2026-08-08T12:01:00.000Z" })] });
    await flushCommit();

    expect(rowIds(container).at(-1)).toBe("new1");
    expect(scrollerOf(container).scrollTop).toBe(bottomOf(container));
  });

  it("freezes the window and counts arrivals while the reader is in history", async () => {
    setStore({ messages: longList(200) });
    const { container } = await mountList();
    await scrollTo(container, 0);
    const frozenTail = rowIds(container).at(-1);

    setStore({
      messages: [
        ...longList(200),
        makeMessage("new1", { sent_at: "2026-08-08T12:01:00.000Z" }),
        makeMessage("new2", { sent_at: "2026-08-08T12:02:00.000Z" }),
      ],
    });
    await flushCommit();

    expect(rowIds(container).at(-1)).toBe(frozenTail);
    expect(container.querySelector(".scroll-to-bottom-badge")?.textContent).toBe("2");
    expect(scrollerOf(container).scrollTop).toBe(0);
  });

  it("does not count a prepended page as unread", async () => {
    setStore({ messages: longList(200) });
    const { container } = await mountList();
    await scrollTo(container, 0);

    setStore({ messages: [...longList(40, "old"), ...longList(200)] });
    await flushCommit();

    expect(container.querySelector(".scroll-to-bottom-badge")).toBeNull();
  });

  it("returns to the newest rows when the FAB is pressed", async () => {
    const ref = createRef<MessageListHandle>();
    setStore({ messages: longList(200) });
    const { container } = await mountList({}, ref);
    await scrollTo(container, 0);
    setStore({ messages: [...longList(200), makeMessage("new1", { sent_at: "2026-08-08T12:01:00.000Z" })] });
    await flushCommit();

    act(() => ref.current?.scrollToBottom());
    await flushCommit();

    expect(rows(container)).toHaveLength(RESET_WINDOW);
    expect(rowIds(container).at(-1)).toBe("new1");
    expect(scrollerOf(container).scrollTop).toBe(bottomOf(container));
    expect(container.querySelector(".scroll-to-bottom-btn")).toBeNull();
  });
});

describe("MessageList — history", () => {
  it("slides into already-loaded rows above and keeps the reader in place", async () => {
    setStore({ messages: longList(500) });
    const { container } = await mountList();
    const scroller = scrollerOf(container);
    await scrollTo(container, 0);
    await settle();

    triggerSentinel(".scroll-sentinel-top");
    await flushCommit();

    expect(rows(container)).toHaveLength(INITIAL_WINDOW + WINDOW_STEP);
    expect(rowIds(container)[0]).toBe(`m${500 - INITIAL_WINDOW - WINDOW_STEP}`);
    // The 3000px that were mounted above the reader are compensated exactly: the
    // message they were looking at has not moved a pixel.
    expect(scroller.scrollTop).toBe(WINDOW_STEP * ROW);
  });

  it("mounts above only at a verified rest on an engine without anchoring", async () => {
    setStore({ messages: longList(500) });
    const { container } = await mountList();
    await scrollTo(container, 0);
    // A finger is on the list: the mount must wait for the release.
    act(() => {
      fireEvent.pointerDown(scrollerOf(container));
    });
    const before = rows(container).length;

    triggerSentinel(".scroll-sentinel-top");
    await flushCommit();
    expect(rows(container)).toHaveLength(before);

    act(() => {
      fireEvent.pointerUp(window);
    });
    await settle();

    expect(rows(container)).toHaveLength(before + WINDOW_STEP);
  });

  it("leaves the compensation for content above to an anchoring engine", async () => {
    document.documentElement.classList.add("has-scroll-anchoring");
    setStore({ messages: longList(500) });
    const { container } = await mountList();
    const scroller = scrollerOf(container);
    await scrollTo(container, 300);
    const topBefore = scroller.scrollTop;

    triggerSentinel(".scroll-sentinel-top");
    await flushCommit();

    expect(rowIds(container)[0]).toBe(`m${500 - INITIAL_WINDOW - WINDOW_STEP}`);
    // The engine moves `scrollTop` for the rows mounted above (the fake layout
    // cannot model that), so the list must write nothing at all: the assertion
    // is that the position is exactly where the reader left it.
    expect(scroller.scrollTop).toBe(topBefore);
  });

  it("mounts above immediately when the engine anchors for us", async () => {
    document.documentElement.classList.add("has-scroll-anchoring");
    setStore({ messages: longList(500) });
    const { container } = await mountList();
    await scrollTo(container, 0);
    act(() => {
      fireEvent.pointerDown(scrollerOf(container));
    });

    triggerSentinel(".scroll-sentinel-top");
    await flushCommit();

    expect(rows(container)).toHaveLength(INITIAL_WINDOW + WINDOW_STEP);
  });

  it("does not let its own write's scroll echo defer the next mount", async () => {
    // History fully loaded on purpose: nothing is fetched or auto-mounted in the
    // background, so the only slides are the two triggered here.
    setStore({ messages: longList(600) });
    const { container } = await mountList();
    const scroller = scrollerOf(container);
    await scrollTo(container, 0);
    await settle();

    // A slide writes the compensation; the browser delivers the scroll event that
    // write produced in the following frame, before that frame's measurements.
    triggerSentinel(".scroll-sentinel-top");
    await flushFrame();
    const before = rows(container).length;
    expect(before).toBe(INITIAL_WINDOW + WINDOW_STEP);
    await echoOwnWrite(scroller);

    // Treating that echo as the reader scrolling would arm a rest pass and defer
    // the next page by another rest window — the wall the reader feels on WebKit.
    triggerSentinel(".scroll-sentinel-top");
    await flushCommit();

    expect(rows(container)).toHaveLength(before + WINDOW_STEP);
    expect(rows(container).length).toBeLessThanOrEqual(MAX_DOM_MESSAGES);
    expect(scroller.scrollTop).toBeGreaterThan(0);
  });

  it("mounts a buffered page above the reader", async () => {
    setStore({ messages: longList(100), hasMoreMessages: true });
    const { container } = await mountList();
    const scroller = scrollerOf(container);
    await scrollTo(container, 0);
    await settle();

    // The reader sits at the top of the mounted window; the row just below the
    // fold is the anchor the compensation must hold.
    const anchor = rows(container)[1];
    const offsetBefore = anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top;

    h.flushPendingOlderMessages.mockImplementation(() => true);
    setStore({ messages: [...longList(50, "old"), ...longList(100)] });
    triggerSentinel(".scroll-sentinel-top");
    await flushCommit();

    expect(rowIds(container)[0]).toBe("old0");
    expect(rows(container)).toHaveLength(150);
    // The page was inserted above the reader: their message has not moved.
    const offsetAfter = anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    expect(offsetAfter).toBeCloseTo(offsetBefore, 0);
    expect(scroller.scrollTop).toBeGreaterThan(0);
  });

  it("requests the previous page when no loaded rows are left above", async () => {
    setStore({ messages: longList(100), hasMoreMessages: true });
    const { container } = await mountList();
    await scrollTo(container, 0);
    await settle();

    triggerSentinel(".scroll-sentinel-top");
    await flushCommit();

    expect(h.loadMoreMessages).toHaveBeenCalledWith("c1", { postpone: true });
  });

  it("never mounts more than the ceiling", async () => {
    setStore({ messages: longList(600), hasMoreMessages: true });
    const { container } = await mountList();
    await scrollTo(container, 0);
    await settle();

    for (let step = 0; step < 6; step += 1) {
      triggerSentinel(".scroll-sentinel-top");
      await flushCommit();
      await settle();
    }

    expect(rows(container).length).toBeLessThanOrEqual(MAX_DOM_MESSAGES);
  });
});

describe("MessageList — jump", () => {
  it("restores the saved session anchor instead of the newest message", async () => {
    setStore({ messages: longList(500) });
    writeMessageScrollAnchor("c1", { key: "m450", offset: 5 });

    const { container } = await mountList();

    const row = container.querySelector<HTMLElement>('.message-item[data-message-id="m450"]')!;
    expect(row).not.toBeNull();
    expect(scrollerOf(container).scrollTop).toBe(row.offsetTop - 5);
  });

  it("glides to a loaded message and flashes it", async () => {
    const ref = createRef<MessageListHandle>();
    setStore({ messages: longList(500) });
    const { container } = await mountList({}, ref);

    act(() => ref.current?.scrollToMessage("m100"));
    await flushCommit();

    const row = container.querySelector<HTMLElement>('.message-item[data-message-id="m100"]')!;
    expect(row).not.toBeNull();
    expect(row.classList.contains("is-flash")).toBe(true);
    // `centerOrTop`: the message fits the viewport, so it is centred in it.
    expect(scrollerOf(container).scrollTop).toBe(row.offsetTop + ROW / 2 - VIEWPORT / 2);
  });

  it("pages older history when the target is not loaded", async () => {
    const ref = createRef<MessageListHandle>();
    setStore({ messages: longList(50), hasMoreMessages: true });
    await mountList({}, ref);

    act(() => ref.current?.scrollToMessage("not-loaded"));
    await flushCommit();

    expect(h.loadMoreMessages).toHaveBeenCalled();
  });
});

describe("MessageList — unread marker", () => {
  // Enough unread messages below the marker for it to be placed at the top: a
  // browser cannot scroll past the real end of the content, and the marker sits
  // in the middle of the chat, not near the newest message.
  const unreadChat = () => [
    ...longList(6, "old"),
    ...longList(10, "new").map((message) => ({ ...message, sent_at: "2026-08-09T09:00:00.000Z" })),
    makeMessage("mine-new", { sender_user_id: "me", sent_at: "2026-08-09T09:02:00.000Z" }),
  ];

  it("marks where the unread messages begin and opens there", async () => {
    setStore({ messages: unreadChat() });

    const { container } = await mountList({ unreadBoundaryAt: "2026-08-08T12:00:00.000Z" });

    const divider = container.querySelector<HTMLElement>(".chat-unread-divider");
    expect(divider).not.toBeNull();
    expect(divider?.textContent).toContain("Непрочитанные");

    // The mounted window starts at the marker, so the unread messages are the
    // first thing on screen — and the marker sits right before them.
    const firstUnread = container.querySelector<HTMLElement>('.message-item[data-message-id="new0"]');
    expect(rowIds(container)[0]).toBe("new0");
    expect(firstUnread?.previousElementSibling).toBe(divider);
    expect(scrollerOf(container).scrollTop).toBe(0);

    // Away from the bottom: the "to the newest" button is offered.
    expect(container.querySelector(".scroll-to-bottom-btn")).not.toBeNull();
  });

  it("does not render (or open on) a marker when everything is read", async () => {
    setStore({ messages: unreadChat() });

    const { container } = await mountList({ unreadBoundaryAt: "2026-08-09T23:00:00.000Z" });

    expect(container.querySelector(".chat-unread-divider")).toBeNull();
    expect(scrollerOf(container).scrollTop).toBe(bottomOf(container));
  });

  it("ignores the reader's own messages when placing the marker", async () => {
    setStore({
      messages: [
        ...longList(4, "old").map((message) => ({ ...message, sender_user_id: "me" })),
        makeMessage("mine-1", { sender_user_id: "me", sent_at: "2026-08-09T09:00:00.000Z" }),
        makeMessage("theirs-1", { sent_at: "2026-08-09T09:01:00.000Z" }),
      ],
    });

    const { container } = await mountList({ unreadBoundaryAt: null });

    const divider = container.querySelector<HTMLElement>(".chat-unread-divider");
    const firstUnread = container.querySelector<HTMLElement>('.message-item[data-message-id="theirs-1"]');
    expect(firstUnread?.previousElementSibling).toBe(divider);
  });

  it("shows no marker when the caller says nothing about the boundary", async () => {
    setStore({ messages: unreadChat() });

    const { container } = await mountList();

    expect(container.querySelector(".chat-unread-divider")).toBeNull();
  });
});

describe("MessageList — dev counters", () => {
  it("renders the overlay only when the flag is on, and stays at zero writes per gesture", async () => {
    setStore({ messages: longList(200) });
    const { container, unmount } = await mountList();
    expect(container.querySelector(".scroll-debug")).toBeNull();
    unmount();

    __setScrollDiagnosticsEnabled(true);
    const overlay = await mountList();
    // The overlay is loaded on demand (dev-only chunk), so it arrives a tick later.
    await waitFor(() => expect(overlay.container.querySelector(".scroll-debug")).not.toBeNull());

    // The headline claim: the reader's own scrolling writes no position at all.
    await scrollTo(overlay.container, 0);
    await settle();
    await scrollTo(overlay.container, 400);
    await waitFor(() => expect(overlay.container.querySelector(".scroll-debug-row")).not.toBeNull());

    const writesRow = overlay.container.querySelector<HTMLElement>(".scroll-debug-row");
    expect(writesRow?.textContent).toContain("0");
    expect(writesRow?.classList.contains("is-bad")).toBe(false);
    __setScrollDiagnosticsEnabled(false);
  });

  it("does not count a deliberate jump to the newest message as a scroll write", async () => {
    const ref = createRef<MessageListHandle>();
    setStore({ messages: longList(200) });
    __setScrollDiagnosticsEnabled(true);
    const { container } = await mountList({}, ref);
    await scrollTo(container, 0);
    await settle();

    const before = readScrollDiagnostics();
    // A tap on the "to the newest message" button: a pointer down, then a click.
    act(() => {
      fireEvent.pointerDown(scrollerOf(container));
    });
    act(() => ref.current?.scrollToBottom());
    await flushCommit();
    await settle();

    const after = readScrollDiagnostics();
    // It did move the position (that is the button's job)…
    expect(after.writesTotal).toBeGreaterThan(before.writesTotal);
    // …but a deliberate jump is not the reader scrolling, so the number that
    // must stay at zero does.
    expect(after.writesDuringGesture).toBe(0);
    __setScrollDiagnosticsEnabled(false);
  });
});

describe("MessageList — chrome changes", () => {
  it("stays glued to the bottom when the list shrinks under the reader", async () => {
    setStore({ messages: longList(200) });
    const { container } = await mountList();
    const scroller = scrollerOf(container);
    expect(scroller.scrollTop).toBe(bottomOf(container));

    // The composer grew a line, or the mobile keyboard opened: the viewport is
    // shorter, and no message changed.
    viewportHeight = 400;
    fireResize();

    expect(scroller.scrollTop).toBe(contentHeight(scroller) - 400);
  });

  it("keeps the reader in place when the scroller's top edge moves down", async () => {
    setStore({ messages: longList(200) });
    const { container } = await mountList();
    const scroller = scrollerOf(container);
    await scrollTo(container, 800);
    const row = rows(container)[12];
    const offsetBefore = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;

    // The pinned banner appears above the messages: the top edge moves down and
    // the height shrinks by the same amount.
    scrollerTop += 60;
    viewportHeight -= 60;
    fireResize();

    const offsetAfter = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    expect(offsetAfter).toBeCloseTo(offsetBefore, 0);
    expect(scroller.scrollTop).toBe(800 - 60);
  });
});

describe("MessageList — read line", () => {
  it("reports the newest fully visible message that is not the reader's own", async () => {
    setStore({
      messages: [
        ...longList(30, "a"),
        makeMessage("deleted", { sender_user_id: "u2", is_deleted: true }),
        makeMessage("mine", { sender_user_id: "me" }),
      ],
    });

    await mountList();
    await settle();

    expect(h.queueMarkRead).toHaveBeenCalledTimes(1);
    const [, messageId] = h.queueMarkRead.mock.calls[0] as [string, string];
    // The last two rows are not eligible: one is deleted, one is the reader's.
    expect(messageId).toBe("a29");
  });

  it("stops at the fold: a message that is not fully visible is not read", async () => {
    setStore({ messages: longList(60) });

    const { container } = await mountList();
    await scrollTo(container, bottomOf(container) - 300);
    await settle();

    expect(h.queueMarkRead).toHaveBeenCalled();
    const [, messageId] = h.queueMarkRead.mock.calls.at(-1) as [string, string];
    // 300px above the bottom, the last fully visible row is m54 — m55..m59 are
    // partly or fully below the fold.
    expect(messageId).toBe("m54");
  });

  it("does not repeat the same report when nothing changed", async () => {
    setStore({ messages: longList(30) });

    await mountList();
    await settle();
    expect(h.queueMarkRead).toHaveBeenCalledTimes(1);

    h.queueMarkRead.mockClear();
    await settle();

    expect(h.queueMarkRead).not.toHaveBeenCalled();
  });

  it("reports further down when the reader scrolls to the bottom", async () => {
    setStore({
      messages: [
        ...longList(30, "a"),
        makeMessage("first", { sender_user_id: "u2" }),
        ...longList(10, "below"),
        makeMessage("last", { sender_user_id: "u2" }),
      ],
    });

    const { container } = await mountList();
    await scrollTo(container, 0);
    await settle();
    h.queueMarkRead.mockClear();

    await scrollTo(container, bottomOf(container));
    await settle();

    expect(h.queueMarkRead).toHaveBeenCalledTimes(1);
    const [, messageId] = h.queueMarkRead.mock.calls[0] as [string, string];
    expect(messageId).toBe("last");
  });
});
