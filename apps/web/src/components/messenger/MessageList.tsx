import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ChevronDown } from "lucide-react";
import { queueMarkRead, useMessengerStore } from "@/stores/messengerStore";
import type { MessageView, ReceiptRow } from "./types";
import { getDateSeparator, isConsecutive } from "./messageListUtils";
import { indexById, messageKey } from "./core/messageModel";
import {
  clearMessageScrollAnchor,
  readMessageScrollAnchor,
  writeMessageScrollAnchor,
  type MessageScrollAnchor,
} from "./core/messageScrollAnchors";
import {
  ANCHOR_AFTER,
  ANCHOR_BEFORE,
  MAX_DOM_MESSAGES,
  PREFETCH_PX,
  PRUNE_BATCH,
  RESET_WINDOW,
  RUNWAY_PX,
  WINDOW_STEP,
  buildKeyIndex,
  resolveKeyWindow,
  sameKeyWindow,
  tailKeyWindow,
  tailSlice,
  trimBottom,
  type KeyWindow,
  type MessageSlice,
} from "./core/slicing";

// ── Behaviour constants ────────────────────────────────────────────────────

/** Distance from the end that still counts as "at the bottom". */
const BOTTOM_SLACK = 100;
/** How long the scroller must be quiet before a heavy pass (GC, read line).
 *  Deliberately short: the real gate is the verified rest (the position must
 *  be unchanged), so this only has to outlast a normal inter-event gap. */
const SCROLL_SETTLE_MS = 100;
/** Debounce of the read-line report (it reads row offsets from the DOM). */
const READ_DEBOUNCE_MS = 180;
/** Minimum gap between two older-history requests (burst guard). */
const LOAD_COOLDOWN_MS = 400;
/** How many pages `scrollToMessage` may fetch while looking for its target. */
const MAX_JUMP_PAGES = 20;
/** Redisplays a jumped-to message for this long. */
const FLASH_MS = 1400;

// ── Public API ─────────────────────────────────────────────────────────────

export interface MessageRenderExtras {
  dateLabel: string | null;
  isConsecutive: boolean;
  /**
   * The reply target, resolved against the FULL loaded history (a reply can
   * quote a message that is outside the mounted window). Passed through the
   * renderer so a message item's memo comparator can see a changed quote.
   */
  quoted: MessageView | null;
  /** The other side's receipt row for this message, or null. */
  peerReceipt: ReceiptRow | null;
}

export interface MessageListHandle {
  /** Jump to the newest message (send / FAB). */
  scrollToBottom: () => void;
  /** Centre a message, paging older history until it is loaded. */
  scrollToMessage: (messageId: string) => void;
}

interface MessageListProps {
  renderMessage: (message: MessageView, prev: MessageView | null, extras: MessageRenderExtras) => ReactNode;
  /**
   * Identity of the *ambient* render inputs (receipts map, pinned id, group /
   * notes flags). The list compares it to decide whether mounted rows must be
   * re-rendered even though their own message did not change.
   */
  renderVersion?: unknown;
  /** Notes self-chat: a filtered view of the store messages (folder filter).
   *  When omitted the full store list is used. */
  messagesOverride?: MessageView[];
}

type RenderMessage = MessageListProps["renderMessage"];

// ── Message item ───────────────────────────────────────────────────────────
// A plain, normal-flow row. There is no position, no transform and no spacer:
// `content-visibility` lets the browser skip painting/laying out the rows that
// are far outside the viewport, and `overflow-anchor: auto` lets its own scroll
// anchoring keep the reader's message in place when older rows are added above.

interface MessageItemProps {
  message: MessageView;
  prev: MessageView | null;
  extras: MessageRenderExtras;
  flash: boolean;
  renderVersion: unknown;
  render: RenderMessage;
}

const MessageItem = memo(
  function MessageItem({ message, prev, extras, flash, render }: MessageItemProps) {
    return (
      <div
        // `.message-row` is kept for the existing long-press/menu host hooks.
        className={`message-item message-row chat-native-row${flash ? " is-flash" : ""}`}
        data-message-id={message.id}
        data-message-key={messageKey(message)}
      >
        {render(message, prev, extras)}
      </div>
    );
  },
  (a, b) =>
    a.message === b.message &&
    a.prev === b.prev &&
    a.flash === b.flash &&
    a.extras.dateLabel === b.extras.dateLabel &&
    a.extras.isConsecutive === b.extras.isConsecutive &&
    a.extras.quoted === b.extras.quoted &&
    a.extras.peerReceipt === b.extras.peerReceipt &&
    Object.is(a.renderVersion, b.renderVersion),
);

// ── DOM helpers ────────────────────────────────────────────────────────────

function findItemByKey(scroller: HTMLElement, key: string): HTMLElement | null {
  for (const node of scroller.querySelectorAll<HTMLElement>(".message-item[data-message-key]")) {
    if (node.dataset.messageKey === key) return node;
  }
  return null;
}

function findItemById(scroller: HTMLElement, id: string): HTMLElement | null {
  for (const node of scroller.querySelectorAll<HTMLElement>(".message-item[data-message-id]")) {
    if (node.dataset.messageId === id) return node;
  }
  return null;
}

/**
 * The mounted message window for the open conversation.
 *
 * Architecture (see ./core/slicing for the math):
 *
 *  - **Normal flow, native scrolling.** Rows are plain block children of a
 *    `overflow-y: auto` viewport. The compositor owns the scroll; this
 *    component never writes a position while a gesture or a momentum scroll is
 *    live.
 *  - **Scroll anchoring, not compensation.** A prepended page is inserted in
 *    normal flow with `overflow-anchor: auto` on the viewport and on every row,
 *    so the engine holds the reader's message in place (Chrome/Firefox). On a
 *    browser without anchoring (Safari) a single `useLayoutEffect` measures the
 *    height delta before paint and applies it — once, at rest, never under a
 *    finger.
 *  - **DOM slicing.** At most {@link MAX_DOM_MESSAGES} rows are mounted. The
 *    window slides bi-directionally from the two `IntersectionObserver`
 *    sentinels; rows are garbage-collected *below* the viewport immediately and
 *    *above* it only when the scroller is at rest (a top prune moves content,
 *    and moving content mid-coast is what a reader feels as a jump).
 *  - **`content-visibility`.** Off-screen rows are skipped by the browser's own
 *    renderer and contribute their remembered height (`contain-intrinsic-size:
 *    auto 64px`) to the layout, so a deep window stays cheap.
 */
export const MessageList = memo(
  forwardRef<MessageListHandle, MessageListProps>(function MessageList(
    { renderMessage, renderVersion, messagesOverride },
    ref,
  ) {
    const conversationId = useMessengerStore((s) => s.selectedConversationId);
    const meId = useMessengerStore((s) => s.me?.id);
    const storeMessages = useMessengerStore((s) => s.messages);
    // Notes self-chat passes a folder-filtered view; regular chats use the full list.
    const messages = messagesOverride ?? storeMessages;
    const receipts = useMessengerStore((s) => s.receipts);
    const hasMoreMessages = useMessengerStore((s) => s.hasMoreMessages);
    const isLoadingMore = useMessengerStore((s) => s.isLoadingMore);
    const loadMoreMessages = useMessengerStore((s) => s.loadMoreMessages);
    const flushPendingOlderMessages = useMessengerStore((s) => s.flushPendingOlderMessages);

    const scrollerRef = useRef<HTMLDivElement | null>(null);
    const topSentinelRef = useRef<HTMLDivElement | null>(null);
    const bottomSentinelRef = useRef<HTMLDivElement | null>(null);

    // ── Window state ───────────────────────────────────────────────────
    // Seeded once per mount (the list is keyed by conversation in ChatView):
    // the saved session anchor when its message is still loaded, the tail
    // otherwise.
    const [initial] = useState(() => {
      const saved = conversationId ? readMessageScrollAnchor(conversationId) : undefined;
      if (saved) {
        const at = messages.findIndex((message) => messageKey(message) === saved.key);
        if (at >= 0) {
          return {
            window: {
              first: messageKey(messages[Math.max(0, at - ANCHOR_BEFORE)]),
              last: messageKey(messages[Math.min(messages.length - 1, at + ANCHOR_AFTER)]),
            } satisfies KeyWindow,
            restore: saved as MessageScrollAnchor | null,
          };
        }
      }
      return { window: tailKeyWindow(messages), restore: null as MessageScrollAnchor | null };
    });

    const [window, setWindow] = useState<KeyWindow>(initial.window);
    const windowRef = useRef(window);
    windowRef.current = window;

    const followingRef = useRef(initial.restore === null);
    const [following, setFollowing] = useState(initial.restore === null);
    const [unread, setUnread] = useState(0);
    const [flashId, setFlashId] = useState<string | null>(null);
    const [jumpNonce, setJumpNonce] = useState(0);

    // ── Derived slice ──────────────────────────────────────────────────
    const indexByKey = useMemo(() => buildKeyIndex(messages), [messages]);
    const indexByKeyRef = useRef(indexByKey);
    indexByKeyRef.current = indexByKey;

    const messagesRef = useRef(messages);
    messagesRef.current = messages;

    const resolved = resolveKeyWindow(window, indexByKey, messages.length);
    const windowResolvable = resolved !== null;
    const derived = resolved ?? tailSlice(messages.length);
    const derivedRef = useRef<MessageSlice>(derived);
    derivedRef.current = derived;

    // A full reload (or a notes folder change) invalidates the keys: re-seed to
    // the tail window.
    useLayoutEffect(() => {
      if (windowResolvable) return;
      const next = tailKeyWindow(messagesRef.current);
      setWindow((current) => (sameKeyWindow(current, next) ? current : next));
    }, [windowResolvable, messages]);

    // ── Latest store values, readable from event handlers ──────────────
    const hasMoreRef = useRef(hasMoreMessages);
    hasMoreRef.current = hasMoreMessages;
    const loadingMoreRef = useRef(isLoadingMore);
    loadingMoreRef.current = isLoadingMore;
    const conversationIdRef = useRef(conversationId);
    conversationIdRef.current = conversationId;
    const ownIdRef = useRef(meId);
    ownIdRef.current = meId;

    // ── Scroll bookkeeping ─────────────────────────────────────────────
    const isScrollingRef = useRef(false);
    const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const scrollRafRef = useRef<number | null>(null);
    const readTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastRequestAtRef = useRef(0);
    const olderBusyRef = useRef(false);
    /**
     * The row the reader is looking at, plus its layout position when it was
     * captured. Any layout change above that row moves it on screen; the
     * compensation is derived from ITS displacement, not from a difference of
     * window indices — so it does not depend on the order React happens to
     * flush a store update and a window update in, and it also covers a row
     * above the reader growing (a late image, a resolved share card).
     */
    const layoutAnchorRef = useRef<{ key: string; offsetTop: number } | null>(null);
    const lastTopRef = useRef(0);
    /** Which way the reader is heading: -1 up (history), +1 down, 0 unknown. */
    const scrollDirectionRef = useRef<-1 | 0 | 1>(0);
    /** The verified-rest pass, reachable from the fetch continuation. */
    const settleRef = useRef<(() => void) | null>(null);
    /** A `scrollToMessage` target that has not been reached yet. */
    const pendingJumpRef = useRef<{ id: string; attempts: number } | null>(null);
    const didInitialPositionRef = useRef(false);
    const pinnedTailRef = useRef<string | null>(null);

    // ── Rendering inputs ───────────────────────────────────────────────
    const messageById = useMemo(() => indexById(messages), [messages]);
    const peerReceiptByMessage = useMemo(() => {
      const map = new Map<string, ReceiptRow>();
      for (const receipt of receipts.get(conversationId ?? "") ?? []) {
        if (receipt.user_id === meId) continue;
        map.set(receipt.message_id, receipt);
      }
      return map;
    }, [receipts, conversationId, meId]);

    // ── Flash a jumped-to message ──────────────────────────────────────
    const flashMessage = useCallback((id: string) => {
      setFlashId(id);
      if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current);
      flashTimerRef.current = setTimeout(() => {
        flashTimerRef.current = null;
        setFlashId(null);
      }, FLASH_MS);
    }, []);

    // ── Older history ──────────────────────────────────────────────────
    /**
     * Slide the mounted window up into already-loaded rows: `rows` rows at
     * once, so one rest is enough to restore a whole runway.
     */
    const expandOlderLocal = useCallback((rows: number = WINDOW_STEP) => {
      const { start } = derivedRef.current;
      if (start <= 0) return false;
      const list = messagesRef.current;
      const nextStart = Math.max(0, start - Math.max(1, rows));
      const older = list[nextStart];
      if (!older) return false;
      setWindow((current) => ({ ...current, first: messageKey(older) }));
      return true;
    }, []);

    /**
     * Mount a page the store just prepended. Only ever called at rest: a
     * prepend adds content above the viewport, which is the one mutation that
     * has to be immediately compensated to keep the reader's place.
     */
    const includeLoadedOlderPage = useCallback((next: MessageView[]) => {
      if (next.length === 0) return;
      const index = buildKeyIndex(next);
      const headKey = messageKey(next[0]);
      setWindow((current) => {
        const resolvedLast =
          current.last === null ? next.length : (index.get(current.last) ?? next.length - 1) + 1;
        const end = Math.max(1, Math.min(next.length, resolvedLast));
        const trimmed = trimBottom(next, 0, end, messageKey);
        return { first: headKey, last: trimmed ? trimmed.last : current.last };
      });
    }, []);

    /** Insert whatever page the store buffered, if any. */
    const flushBufferedPage = useCallback(() => {
      const id = conversationIdRef.current;
      if (!id) return false;
      if (!flushPendingOlderMessages(id)) return false;
      includeLoadedOlderPage(useMessengerStore.getState().messages);
      return true;
    }, [flushPendingOlderMessages, includeLoadedOlderPage]);

    /**
     * Fetch the previous page into the store's buffer. The buffer is what makes
     * the *request* early and the *insert* late — a burst guard and a coast-safe
     * land.
     */
    const requestOlderPage = useCallback(async () => {
      const id = conversationIdRef.current;
      if (!id || !hasMoreRef.current || loadingMoreRef.current || olderBusyRef.current) return false;
      const now = Date.now();
      if (now - lastRequestAtRef.current < LOAD_COOLDOWN_MS) return false;
      lastRequestAtRef.current = now;
      olderBusyRef.current = true;
      try {
        await loadMoreMessages(id, { postpone: true });
      } finally {
        olderBusyRef.current = false;
      }
      // The insert itself goes through the verified-rest pass: a fetch can
      // resolve while the reader is coasting, and inserting then is what
      // WebKit drops.
      if (!isScrollingRef.current) settleRef.current?.();
      return true;
    }, [loadMoreMessages]);

    /** One older step: local rows first, then a buffered page, then a request. */
    const prefetchOlder = useCallback(() => {
      if (followingRef.current) return;
      const scroller = scrollerRef.current;
      if (!scroller || scroller.scrollTop > PREFETCH_PX) return;
      void requestOlderPage();
    }, [requestOlderPage]);

    /**
     * Restore the runway above the reader: mount enough already-loaded rows to
     * put {@link RUNWAY_PX} of content back above the viewport, or bring in a
     * buffered page when the mounted window already reaches the oldest loaded
     * message. Only ever called from a verified rest — mounting rows above the
     * viewport moves the content and is compensated by a single `scrollTop`
     * write, which WebKit drops under a live coast.
     */
    const topUpRunway = useCallback(() => {
      if (followingRef.current) return;
      const scroller = scrollerRef.current;
      if (!scroller) return;
      const { start, end } = derivedRef.current;
      const rows = end - start;
      if (rows <= 0) return;
      const deficit = RUNWAY_PX - scroller.scrollTop;
      if (deficit <= 0) return;
      if (start > 0) {
        // Measured average of the mounted window — self-correcting, no table of
        // per-message height estimates.
        const average = Math.max(24, (scroller.scrollHeight - 2) / rows);
        const needed = Math.ceil(deficit / average);
        expandOlderLocal(Math.min(Math.max(WINDOW_STEP, needed), 4 * WINDOW_STEP));
        return;
      }
      if (flushBufferedPage()) return;
      void requestOlderPage();
    }, [expandOlderLocal, flushBufferedPage, requestOlderPage]);

    /** Mount already-loaded rows below the window (the reader scrolled down). */
    const expandNewer = useCallback(() => {
      if (followingRef.current) return;
      const { end } = derivedRef.current;
      const list = messagesRef.current;
      if (end >= list.length) return;
      const nextEnd = Math.min(list.length, end + WINDOW_STEP);
      const newest = list[nextEnd - 1];
      if (!newest) return;
      setWindow((current) => ({ ...current, last: messageKey(newest) }));
    }, []);

    const captureLayoutAnchor = useCallback(() => {
      const scroller = scrollerRef.current;
      if (!scroller) return;
      const top = scroller.scrollTop;
      for (const node of scroller.querySelectorAll<HTMLElement>(".message-item[data-message-key]")) {
        if (node.offsetTop + node.offsetHeight > top + 1) {
          const key = node.dataset.messageKey;
          if (key) layoutAnchorRef.current = { key, offsetTop: node.offsetTop };
          return;
        }
      }
      layoutAnchorRef.current = null;
    }, []);

    // ── Garbage collection ─────────────────────────────────────────────
    /**
     * Drop rows above the ceiling. Rows that leave the viewport from the TOP
     * move the content, so this waits for a rest (a scroll-settle pass) and the
     * layout anchor corrects the position afterwards. Never removes the row the
     * reader is looking at: the prune is clamped to the rows above the anchor.
     */
    const pruneTopIfNeeded = useCallback(() => {
      const scroller = scrollerRef.current;
      if (!scroller || isScrollingRef.current) return;
      const { start, end } = derivedRef.current;
      const over = end - start - MAX_DOM_MESSAGES;
      if (over <= 0) return;
      const list = messagesRef.current;
      // The prune must not touch the row the reader is looking at, and its
      // compensation needs the pre-prune position of that row — captured here
      // when the settle pass did not already do it.
      if (!layoutAnchorRef.current) captureLayoutAnchor();
      const nodes = scroller.querySelectorAll<HTMLElement>(".message-item");
      const anchorKey = layoutAnchorRef.current?.key;
      let anchorIndex = 0;
      if (anchorKey) {
        for (let i = 0; i < nodes.length; i += 1) {
          if (nodes[i].dataset.messageKey === anchorKey) {
            anchorIndex = i;
            break;
          }
        }
      }
      const remove = Math.min(over + PRUNE_BATCH, end - start - 1, anchorIndex);
      if (remove <= 0) return;
      const keepFrom = start + remove;
      const kept = list[keepFrom];
      if (!kept || keepFrom >= end) return;
      setWindow((current) => ({ ...current, first: messageKey(kept) }));
    }, [captureLayoutAnchor]);

    /**
     * Ceiling enforcement, applied from the side that is FAR from the reader.
     * Rows below the viewport cost nothing to remove; rows above it move the
     * content and are only dropped at a rest (see {@link pruneTopIfNeeded}).
     * Trimming the wrong side would shorten the runway the reader is heading
     * into.
     */
    const gcIfOverCap = useCallback(() => {
      const scroller = scrollerRef.current;
      if (!scroller || isScrollingRef.current) return;
      const { start, end } = derivedRef.current;
      if (end - start <= MAX_DOM_MESSAGES) return;
      const midpoint = Math.max(0, (scroller.scrollHeight - scroller.clientHeight) / 2);
      // Trim the side the reader is NOT heading into. Heading up (history):
      // the newest rows are behind them. Heading down or pinned to the bottom:
      // the oldest rows are. With no direction yet, fall back to geometry.
      const direction = scrollDirectionRef.current;
      const trimBottomFirst =
        direction < 0 || (direction === 0 && !followingRef.current && scroller.scrollTop < midpoint);
      if (trimBottomFirst) {
        const trimmed = trimBottom(messagesRef.current, start, end, messageKey);
        if (trimmed) setWindow((current) => ({ ...current, last: trimmed.last }));
        return;
      }
      pruneTopIfNeeded();
    }, [pruneTopIfNeeded]);

    // ── Read receipts: the "read line" (Telegram-style) ────────────────
    /**
     * Reports exactly ONE message per pass: the newest message that is FULLY
     * visible and was not sent by the reader. Everything above it was read;
     * nothing below the fold is. The store debounces and the backend marks the
     * whole prefix, so a scroll burst costs a single request.
     */
    const reportVisibleReads = useCallback(() => {
      const id = conversationIdRef.current;
      const mine = ownIdRef.current;
      const scroller = scrollerRef.current;
      if (!id || !mine || !scroller) return;
      const fold = scroller.scrollTop + scroller.clientHeight;
      const nodes = scroller.querySelectorAll<HTMLElement>(".message-item[data-message-key]");
      const index = indexByKeyRef.current;
      const list = messagesRef.current;
      // Newest first: the first row that fits and is not mine is the read line.
      for (let i = nodes.length - 1; i >= 0; i -= 1) {
        const node = nodes[i];
        if (node.offsetTop + node.offsetHeight > fold + 1) continue;
        const key = node.dataset.messageKey;
        const at = key === undefined ? undefined : index.get(key);
        const message = at === undefined ? undefined : list[at];
        if (!message) continue;
        if (message.sender_user_id === mine || message.is_deleted) continue;
        queueMarkRead(id, message.id, message.sent_at);
        return;
      }
    }, []);

    const scheduleReadReport = useCallback(() => {
      if (readTimerRef.current !== null) clearTimeout(readTimerRef.current);
      readTimerRef.current = setTimeout(() => {
        readTimerRef.current = null;
        reportVisibleReads();
      }, READ_DEBOUNCE_MS);
    }, [reportVisibleReads]);

    // ── Bottom stickiness ──────────────────────────────────────────────
    /**
     * Re-evaluates "the reader is at the newest message" once per frame from
     * the element's own geometry (one `scrollTop`/`scrollHeight` read pair, no
     * state-setting loop). Only the transition is applied.
     */
    const updateBottomState = useCallback(() => {
      const scroller = scrollerRef.current;
      if (!scroller) return;
      const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      const atBottom = distance <= BOTTOM_SLACK;
      if (atBottom === followingRef.current) return;
      if (atBottom) {
        followingRef.current = true;
        setFollowing(true);
        setUnread(0);
        // Back at the newest message: re-seed the window to the tail. Every row
        // that leaves is above the viewport, so nothing the reader can see
        // moves, and `last: null` mounts arrivals again.
        const next = tailKeyWindow(messagesRef.current);
        setWindow((current) => (sameKeyWindow(current, next) ? current : next));
      } else {
        followingRef.current = false;
        setFollowing(false);
        // Freeze the window on the mounted rows: arrivals must not pull the
        // reader down, they only raise the unread badge. The first key is
        // materialized here too — the window stops being "the tail".
        const { start, end } = derivedRef.current;
        const list = messagesRef.current;
        const first = list[start];
        const newest = list[end - 1];
        setWindow((current) => ({
          first: current.first ?? (first ? messageKey(first) : null),
          last: newest ? messageKey(newest) : current.last,
        }));
      }
    }, []);

    // ── Scroll pass ────────────────────────────────────────────────────
    /** The heavy pass, run once the scroller has been quiet for a moment. */
    const handleSettle = useCallback(
      // Named so the re-arm below can call the same function without a ref.
      function handleSettle() {
        const scroller = scrollerRef.current;
        // `scroll` events can go quiet before the momentum has visually ended
        // (iOS), so the rest is verified from the position itself: if it moved
        // since the last observation, re-arm instead of mutating the list.
        // Everything below (a pin, an insert above the viewport, a top prune)
        // writes `scrollTop`, and a write under a live coast is dropped by
        // WebKit — which is exactly the visible jump.
        if (scroller && Math.abs(scroller.scrollTop - lastTopRef.current) > 1) {
          lastTopRef.current = scroller.scrollTop;
          isScrollingRef.current = true;
          if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current);
          settleTimerRef.current = setTimeout(() => {
            settleTimerRef.current = null;
            handleSettle();
          }, SCROLL_SETTLE_MS);
          return;
        }
        isScrollingRef.current = false;
        if (!scroller) return;
        // A message that arrived while the coast was live is pinned now (writing
        // `scrollTop` mid-momentum is what makes iOS stutter).
        if (followingRef.current) {
          // A page buffered while the reader was up in history must not sit in
          // the store forever; inserting it here is safe because the pin below
          // restores the bottom in the same frame.
          flushBufferedPage();
          scroller.scrollTop = scroller.scrollHeight;
          gcIfOverCap();
          reportVisibleReads();
          return;
        }
        // Everything below this line may move the content. The reader's row is
        // recorded FIRST, so the layout effect can hold it in place whatever
        // the mutations do (and whatever order React commits them in).
        captureLayoutAnchor();
        // Give the next fling its runway back before touching the ceiling
        // enforcement, so a single rest is enough to restore it.
        topUpRunway();
        gcIfOverCap();
        reportVisibleReads();
      },
      [topUpRunway, gcIfOverCap, reportVisibleReads, captureLayoutAnchor, flushBufferedPage],
    );
    settleRef.current = handleSettle;

    const handleScroll = useCallback(() => {
      isScrollingRef.current = true;
      if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current);
      settleTimerRef.current = setTimeout(() => {
        settleTimerRef.current = null;
        handleSettle();
      }, SCROLL_SETTLE_MS);
      if (scrollRafRef.current !== null) return;
      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRafRef.current = null;
        const scroller = scrollerRef.current;
        if (scroller) {
          const top = scroller.scrollTop;
          if (top < lastTopRef.current - 1) scrollDirectionRef.current = -1;
          else if (top > lastTopRef.current + 1) scrollDirectionRef.current = 1;
          lastTopRef.current = top;
        }
        updateBottomState();
        // The next page is requested from here, mid-fling: a request touches no
        // DOM, so the buffer is already full when the reader hits the top.
        prefetchOlder();
      });
    }, [updateBottomState, handleSettle, prefetchOlder]);

    // ── Sentinels: bi-directional sliding-window triggers ──────────────
    // `hasMessages` is a dependency so the observers are (re)attached when the
    // scroller itself appears — the list renders nothing without messages.
    const hasMessages = messages.length > 0;
    useEffect(() => {
      const scroller = scrollerRef.current;
      const top = topSentinelRef.current;
      const bottom = bottomSentinelRef.current;
      if (!scroller || typeof IntersectionObserver === "undefined" || (!top && !bottom)) return;

      // The top sentinel only *fetches* (no DOM): the insert stays in the
      // settle pass, which is the only place allowed to move content.
      const topObserver = top
        ? new IntersectionObserver(
            (entries) => {
              if (entries.some((entry) => entry.isIntersecting)) prefetchOlder();
            },
            { root: scroller, rootMargin: "600px 0px 0px 0px" },
          )
        : null;
      const bottomObserver = bottom
        ? new IntersectionObserver(
            (entries) => {
              if (entries.some((entry) => entry.isIntersecting)) expandNewer();
            },
            { root: scroller, rootMargin: "0px 0px 600px 0px" },
          )
        : null;
      if (topObserver && top) topObserver.observe(top);
      if (bottomObserver && bottom) bottomObserver.observe(bottom);
      return () => {
        topObserver?.disconnect();
        bottomObserver?.disconnect();
      };
    }, [prefetchOlder, expandNewer, hasMessages]);

    // ── Unread counter for arrivals below a frozen window ──────────────
    const tail = messages.length > 0 ? messages[messages.length - 1] : null;
    const tailKey = tail ? messageKey(tail) : null;
    const prevLenRef = useRef(messages.length);
    const prevTailKeyRef = useRef<string | null>(tailKey);
    useEffect(() => {
      const prevLen = prevLenRef.current;
      const prevTail = prevTailKeyRef.current;
      prevLenRef.current = messages.length;
      prevTailKeyRef.current = tailKey;
      // Only a NEW TAIL counts: a prepended page also grows the array but the
      // tail key is untouched. The delta is captured eagerly — a lazy updater
      // would read the ref after it has already been advanced.
      if (prevTail !== null && tailKey !== prevTail && messages.length > prevLen && !followingRef.current) {
        setUnread((count) => count + (messages.length - prevLen));
      }
    }, [messages, tailKey]);

    // ── Initial placement: restored anchor, else the newest message ────
    useLayoutEffect(() => {
      if (didInitialPositionRef.current) return;
      const scroller = scrollerRef.current;
      if (!scroller || messages.length === 0) return;
      didInitialPositionRef.current = true;
      const restore = initial.restore;
      if (restore) {
        const node = findItemByKey(scroller, restore.key);
        if (node) {
          scroller.scrollTop = Math.max(0, node.offsetTop - restore.offset);
          return;
        }
      }
      followingRef.current = true;
      setFollowing(true);
      scroller.scrollTop = scroller.scrollHeight;
    }, [messages, initial.restore]);

    // ── Follow the newest message ──────────────────────────────────────
    // Only ever fires while the reader is at the bottom; the write is skipped
    // mid-coast (the settle pass pins instead).
    useLayoutEffect(() => {
      if (!followingRef.current || isScrollingRef.current) return;
      if (pinnedTailRef.current === tailKey) return;
      pinnedTailRef.current = tailKey;
      const scroller = scrollerRef.current;
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    }, [tailKey, derived.start, derived.end]);

    // ── Anchoring: keep the reader's row where it is ───────────────────
    // A layout change above the reader (a prepended page, a top prune, a row
    // above growing) moves everything below it. Chromium/Firefox absorb that
    // with native scroll anchoring; this is the pre-paint fallback (and the only
    // path in Safari), derived from the committed DOM: the displacement of the
    // row the reader is looking at, measured against the position it had when
    // the mutation was requested.
    useLayoutEffect(() => {
      const scroller = scrollerRef.current;
      if (!scroller) return;

      const anchor = layoutAnchorRef.current;
      if (followingRef.current) {
        // The pin owns the position while the reader is at the newest message;
        // a stale anchor from before would be meaningless.
        layoutAnchorRef.current = null;
      } else if (anchor) {
        const node = findItemByKey(scroller, anchor.key);
        if (!node) {
          layoutAnchorRef.current = null;
        } else {
          const delta = node.offsetTop - anchor.offsetTop;
          if (Math.abs(delta) > 1) {
            // Where `scrollTop` must be for the anchor row to stay put. Native
            // anchoring has already moved it there in Chromium/Firefox, so the
            // write only happens where there is none (Safari) — and only ever
            // at a verified rest.
            const expected = lastTopRef.current + delta;
            if (Math.abs(scroller.scrollTop - expected) > 1) scroller.scrollTop = expected;
            anchor.offsetTop = node.offsetTop;
          }
        }
      }

      // Ceiling enforcement also runs here (never mid-coast): a commit that
      // grew the window past it must not wait for the next scroll event.
      if (!isScrollingRef.current) gcIfOverCap();
      lastTopRef.current = scroller.scrollTop;
    }, [derived.start, derived.end, messages, tailKey, gcIfOverCap, windowResolvable]);

    // ── Jump to a message (pinned banner, quoted reply) ────────────────
    useLayoutEffect(() => {
      const pending = pendingJumpRef.current;
      if (!pending) return;
      const list = messagesRef.current;
      const at = list.findIndex((message) => message.id === pending.id);
      if (at < 0) {
        if (
          hasMoreRef.current &&
          !loadingMoreRef.current &&
          pending.attempts < MAX_JUMP_PAGES &&
          conversationIdRef.current
        ) {
          pending.attempts += 1;
          void loadMoreMessages(conversationIdRef.current);
          return;
        }
        pendingJumpRef.current = null;
        return;
      }
      if (at < derived.start || at >= derived.end) {
        // Mount a window around the target; the next commit scrolls to it.
        const next: KeyWindow = {
          first: messageKey(list[Math.max(0, at - ANCHOR_BEFORE)]),
          last: messageKey(list[Math.min(list.length - 1, at + ANCHOR_AFTER)]),
        };
        setWindow((current) => (sameKeyWindow(current, next) ? current : next));
        return;
      }
      pendingJumpRef.current = null;
      const scroller = scrollerRef.current;
      if (scroller) {
        const node = findItemById(scroller, pending.id);
        if (node) {
          scroller.scrollTop = Math.max(
            0,
            node.offsetTop - Math.max(0, (scroller.clientHeight - node.offsetHeight) / 2),
          );
        }
      }
      flashMessage(pending.id);
    }, [jumpNonce, messages, derived.start, derived.end, loadMoreMessages, flashMessage]);

    // ── Read line on data changes (open, prepend, restored placement) ──
    useLayoutEffect(() => {
      scheduleReadReport();
    }, [derived.start, derived.end, messages.length, scheduleReadReport]);

    // ── Session anchor: persist the reader's place on unmount ──────────
    const captureAnchor = useCallback((): MessageScrollAnchor | null => {
      const scroller = scrollerRef.current;
      if (!scroller) return null;
      for (const node of scroller.querySelectorAll<HTMLElement>(".message-item[data-message-key]")) {
        if (node.offsetTop + node.offsetHeight > scroller.scrollTop + 1) {
          const key = node.dataset.messageKey;
          if (!key) continue;
          return { key, offset: node.offsetTop - scroller.scrollTop };
        }
      }
      return null;
    }, []);

    useEffect(() => {
      return () => {
        if (!conversationId) return;
        if (followingRef.current) clearMessageScrollAnchor(conversationId);
        else {
          const anchor = captureAnchor();
          if (anchor) writeMessageScrollAnchor(conversationId, anchor);
        }
      };
    }, [conversationId, captureAnchor]);

    // ── Timer/listener cleanup ─────────────────────────────────────────
    useEffect(() => {
      return () => {
        if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current);
        if (readTimerRef.current !== null) clearTimeout(readTimerRef.current);
        if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current);
        if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current);
      };
    }, []);

    // ── Imperative API (ChatView) ──────────────────────────────────────
    const jumpToLatest = useCallback(() => {
      const list = messagesRef.current;
      if (list.length === 0) return;
      followingRef.current = true;
      // An explicit "take me to the newest message" overrides the coast
      // tracking: the pin must land in this frame, not at the next settle.
      isScrollingRef.current = false;
      setFollowing(true);
      setUnread(0);
      pendingJumpRef.current = null;
      pinnedTailRef.current = null;
      // A long smooth scroll across thousands of pixels reads as a hang; the
      // window is re-seeded to the newest rows and the position snaps in one
      // frame instead.
      setWindow(tailKeyWindow(list, RESET_WINDOW));
    }, []);

    const jumpToMessage = useCallback(
      (messageId: string) => {
        const list = messagesRef.current;
        followingRef.current = false;
        setFollowing(false);
        const at = list.findIndex((message) => message.id === messageId);
        if (at >= 0) {
          const next: KeyWindow = {
            first: messageKey(list[Math.max(0, at - ANCHOR_BEFORE)]),
            last: messageKey(list[Math.min(list.length - 1, at + ANCHOR_AFTER)]),
          };
          setWindow((current) => (sameKeyWindow(current, next) ? current : next));
          pendingJumpRef.current = { id: messageId, attempts: 0 };
        } else if (conversationIdRef.current) {
          pendingJumpRef.current = { id: messageId, attempts: 1 };
          void loadMoreMessages(conversationIdRef.current);
        }
        setJumpNonce((nonce) => nonce + 1);
      },
      [loadMoreMessages],
    );

    useImperativeHandle(
      ref,
      () => ({ scrollToBottom: jumpToLatest, scrollToMessage: jumpToMessage }),
      [jumpToLatest, jumpToMessage],
    );

    // ── Render ─────────────────────────────────────────────────────────
    const rows: ReactNode[] = [];
    for (let at = derived.start; at < derived.end; at += 1) {
      const message = messages[at];
      if (!message) continue;
      const prev = at > 0 ? messages[at - 1] : null;
      rows.push(
        <MessageItem
          key={messageKey(message)}
          message={message}
          prev={prev}
          flash={flashId === message.id}
          renderVersion={renderVersion}
          render={renderMessage}
          extras={{
            dateLabel: getDateSeparator(prev, message),
            isConsecutive: isConsecutive(prev, message),
            quoted:
              message.parent_message_id != null
                ? messageById.get(message.parent_message_id) ?? null
                : null,
            peerReceipt: peerReceiptByMessage.get(message.id) ?? null,
          }}
        />,
      );
    }

    if (messages.length === 0) return null;

    return (
      <div className="message-scroll-wrap">
        {/* Loader floats over the list — it must not take part in the scroll
            math, and it is explicitly excluded from scroll anchoring. */}
        {isLoadingMore && hasMoreMessages && (
          <div className="msg-history-loader" aria-hidden="true">
            <span className="msg-history-loader-spinner" />
            <span>Загружаем историю…</span>
          </div>
        )}

        <div
          ref={scrollerRef}
          className="message-scroll"
          role="log"
          aria-label="Сообщения"
          // role="log" implies a polite live region. Rows mount/unmount as the
          // window slides, which would make a screen reader re-read the whole
          // history; new messages are announced through the status region below.
          aria-live="off"
          onScroll={handleScroll}
        >
          <div className="message-list">
            {/* Sentinels arm the bi-directional window slide. They must never
                be picked as a scroll anchor. */}
            <div ref={topSentinelRef} className="chat-scroll-sentinel scroll-sentinel-top" aria-hidden="true" />
            {rows}
            <div ref={bottomSentinelRef} className="chat-scroll-sentinel scroll-sentinel-bottom" aria-hidden="true" />
          </div>
        </div>

        {!following && (
          <button
            type="button"
            className={`scroll-to-bottom-btn${unread > 0 ? " has-new" : ""}`}
            onClick={jumpToLatest}
            aria-label={
              unread > 0
                ? `Новые сообщения: ${unread}. Перейти к последним`
                : "Перейти к последним сообщениям"
            }
          >
            {unread > 0 && (
              <span className="scroll-to-bottom-badge" aria-hidden="true">{unread}</span>
            )}
            <ChevronDown size={16} aria-hidden="true" />
          </button>
        )}

        {/* Announcements are throttled to the pill's own state so scrolling
            never replays the history. */}
        <div className="sr-only" role="status" aria-live="polite">
          {!following && unread > 0
            ? `${unread} ${unread === 1 ? "новое сообщение" : "новых сообщений"}`
            : ""}
        </div>
      </div>
    );
  }),
);
