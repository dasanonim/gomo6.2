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
import { hasScrollAnchoring } from "@/lib/scrollAnchoring";
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
  RESET_WINDOW,
  WINDOW_STEP,
  buildKeyIndex,
  resolveKeyWindow,
  sameKeyWindow,
  tailKeyWindow,
  tailSlice,
  type KeyWindow,
  type MessageSlice,
} from "./core/slicing";
import { animateScroll, isAnimatingScroll } from "./core/animateScroll";
import { requestForcedReflow } from "./core/fasterdom";
import {
  AT_BOTTOM_THRESHOLD,
  BOTTOM_SNAP_CLASS,
  getOffsetToContainer,
  pinToBottom,
  readContainerScrollTop,
  setScrollTop,
} from "./core/scrollGeometry";

// ── Behaviour constants ────────────────────────────────────────────────────

/**
 * Distance from the newest message that still counts as "the reader is following
 * the conversation": arrivals keep gliding in, the unread badge stays hidden.
 */
const FOLLOW_SLACK = 100;
/**
 * The band around the bottom trigger in which native scroll snapping is armed
 * (Telegram's `BOTTOM_SNAP_THRESHOLD`). Outside it the reader is exploring
 * history and snapping must not pull them back.
 */
const BOTTOM_SNAP_THRESHOLD = 7;
/** How close to the mounted top/bottom a new page is mounted (Telegram: 750). */
const HISTORY_TRIGGER_MARGIN = 750;
/**
 * Where the *request* for the next page starts. Much earlier than the mount
 * trigger: a request touches no DOM, so it is safe mid-fling and it takes the
 * network out of the wait when the reader reaches the mounted top.
 */
const PREFETCH_PX = 6000;
/** Minimum gap between two older-history requests (burst guard). */
const LOAD_COOLDOWN_MS = 400;
/**
 * How long the scroller must be quiet before the work that needs a verified
 * rest: reading the read line, and — on an engine without native scroll
 * anchoring — mounting rows above the viewport. A quiet event stream is not
 * proof of a rest on iOS, so the rest is verified from the position itself.
 */
const REST_MS = 150;
/** Redisplays a jumped-to message for this long. */
const FLASH_MS = 1400;
/** How many pages `scrollToMessage` may fetch while looking for its target. */
const MAX_JUMP_PAGES = 20;

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
// A plain, normal-flow row: no position, no transform, no spacer, and no
// `content-visibility`. Every mounted row IS laid out — a row whose height the
// engine does not know is a row that moves everything below it the moment it is
// rendered, which is the stutter this list used to have on WebKit.

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

/** Every mounted row, in document order (row offsets are monotonic). */
function collectRows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(".message-item[data-message-key]"));
}

function findRowByKey(rows: HTMLElement[], key: string): HTMLElement | null {
  for (const row of rows) {
    if (row.dataset.messageKey === key) return row;
  }
  return null;
}

function findRowById(rows: HTMLElement[], id: string): HTMLElement | null {
  for (const row of rows) {
    if (row.dataset.messageId === id) return row;
  }
  return null;
}

/** The last row that is FULLY above the fold, or -1. */
function findLastVisibleRowIndex(rows: HTMLElement[], fold: number): number {
  let low = 0;
  let high = rows.length - 1;
  let visible = -1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    if (rows[mid].offsetTop + rows[mid].offsetHeight <= fold + 1) {
      visible = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return visible;
}

// ── Window math ────────────────────────────────────────────────────────────

/** A key window for an explicit `[start, end)` slice. */
function windowFromSlice(
  messages: readonly MessageView[],
  start: number,
  end: number,
  followTail: boolean,
): KeyWindow {
  const first = messages[start];
  const last = messages[end - 1];
  return {
    first: first ? messageKey(first) : null,
    last: followTail ? null : last ? messageKey(last) : null,
  };
}

/**
 * The mounted message window for the open conversation.
 *
 * ## The model (ported from Telegram Web)
 *
 * The DOM is **never virtualized** within the mounted slice: no spacers, no
 * absolute rows, no `content-visibility`. What is bounded is the *slice of
 * history that is mounted* ({@link MAX_DOM_MESSAGES} rows), and it slides like a
 * page of a book: rows are added on the side the reader is moving toward and
 * dropped on the opposite side, which is off screen by construction. Dropping
 * rows off the far end and adding rows above it therefore never move what the
 * reader is looking at — and where the engine has scroll anchoring, adding rows
 * above does not either.
 *
 * ## One writer
 *
 * Exactly one `useLayoutEffect` decides the scroll position and writes it in a
 * single DOM mutation pass (`core/fasterdom`). Its decision tree, in order:
 *
 *  1. **First placement** — the restored session anchor, else the newest row.
 *  2. **A pending jump** — glide to the target and flash it.
 *  3. **A new tail while following** — glide the arrival in (the "message rises"
 *     feel of a send).
 *  4. **The reader was at the bottom** — pin with the sentinel. This single
 *     write keeps a growing list glued: it clamps to the new maximum whatever
 *     grew, above or below.
 *  5. **Otherwise** — compensate the layout change above the reader's anchor,
 *     plus any movement of the scroller's own top edge (the pinned banner
 *     appearing above the messages pushes the content down).
 *
 * There is no other `scrollTop` writer here. Nothing is written on scroll: every
 * position change happens in a commit, which is the only moment the DOM changes.
 *
 * ## Arrivals while the reader is up in history
 *
 * The window freezes (`last` materializes), the arrival is not mounted, nothing
 * moves, and the badge counts it. Telegram's contract.
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
    const bottomTriggerRef = useRef<HTMLDivElement | null>(null);

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
    const rowsRef = useRef<HTMLElement[]>([]);

    /**
     * What the last commit left behind. A commit is the only moment the DOM
     * changes, so this is the reader's position as the DOM knew it — including
     * the anchor's *scroll coordinate*, which survives the reader scrolling and
     * only moves when the layout above the anchor changes.
     */
    const prevCommitRef = useRef<{
      anchorKey: string | null;
      anchorCoord: number;
      containerTop: number;
      clientHeight: number;
      tailKey: string | null;
    } | null>(null);

    const didInitialPositionRef = useRef(false);
    const pendingJumpRef = useRef<{ id: string; attempts: number } | null>(null);
    const pendingBottomPinRef = useRef(false);
    const pendingTopMountRef = useRef(false);
    const pinnedTailRef = useRef<string | null>(null);
    const lastReadKeyRef = useRef<string | null>(null);
    const lastRequestAtRef = useRef(0);
    const olderBusyRef = useRef(false);
    /** A pointer is on the list: nothing may move content under it (WebKit). */
    const pointerDownRef = useRef(false);
    /** The position moved and has not been verified at rest yet. */
    const coastingRef = useRef(false);
    const bestPositionRef = useRef(0);
    const restTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const scrollRafRef = useRef<number | null>(null);

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

    /**
     * Is it safe to add rows ABOVE the viewport right now? With native scroll
     * anchoring the engine moves the position for us, so it always is. Without
     * it (WebKit) the added rows would shift the reader's content, and the write
     * that compensates is dropped while a gesture or a coast is live — which is
     * exactly the observed "it teleports me twice". So there: a verified rest.
     */
    const canMountAboveNow = useCallback(
      () => hasScrollAnchoring() || (!coastingRef.current && !pointerDownRef.current),
      [],
    );

    // ── Mounted window: slide it like a page ───────────────────────────
    /**
     * Extend the mounted window toward one side, dropping the far side when it
     * goes over the ceiling. The reader is moving *away* from the far side, so
     * the dropped rows are off screen.
     */
    const enlargeWindow = useCallback((side: "top" | "bottom") => {
      const { start, end } = derivedRef.current;
      const messages = messagesRef.current;
      const current = windowRef.current;
      let nextStart = start;
      let nextEnd = end;

      if (side === "top") nextStart = Math.max(0, start - WINDOW_STEP);
      else nextEnd = Math.min(messages.length, end + WINDOW_STEP);

      if (nextStart === start && nextEnd === end) return false;

      // A window that still follows the tail owns the newest rows and must never
      // lose them; a frozen one (the reader is in history) may drop the bottom.
      const overflow = nextEnd - nextStart - MAX_DOM_MESSAGES;
      if (overflow > 0) {
        if (side === "top" && current.last !== null) nextEnd -= overflow;
        else if (side === "bottom" && current.first !== null) nextStart += overflow;
      }

      // A frozen window stays frozen: "the window ends at the array end" is not
      // the same as "the window follows the tail" (the reader may have scrolled
      // up to the newest mounted row, which is the array end).
      const next = windowFromSlice(messages, nextStart, nextEnd, current.last === null);
      setWindow((prev) => (sameKeyWindow(prev, next) ? prev : next));
      return true;
    }, []);

    // ── Older history ──────────────────────────────────────────────────
    /** Mount the page the store buffered, if there is one. */
    const flushBufferedPage = useCallback(() => {
      const id = conversationIdRef.current;
      if (!id) return false;
      pendingTopMountRef.current = false;
      if (!flushPendingOlderMessages(id)) return false;
      const next = useMessengerStore.getState().messages;
      if (next.length === 0) return true;
      setWindow((current) => {
        const index = buildKeyIndex(next);
        const resolvedLast =
          current.last === null ? next.length : (index.get(current.last) ?? next.length - 1) + 1;
        const end = Math.max(1, Math.min(next.length, resolvedLast));
        const start = Math.max(0, end - MAX_DOM_MESSAGES);
        return windowFromSlice(next, start, end, current.last === null);
      });
      return true;
    }, [flushPendingOlderMessages]);

    /**
     * Fetch the previous page into the store's buffer. `postpone` keeps the
     * *request* away from the DOM: it runs mid-fling, so the network round trip
     * is not part of the wait when the reader reaches the mounted top.
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
      if (canMountAboveNow()) flushBufferedPage();
      else pendingTopMountRef.current = true;
      return true;    }, [loadMoreMessages, flushBufferedPage, canMountAboveNow]);

    /** One older step: already-mounted rows first, then a page, then a request. */
    const expandOlderNow = useCallback(() => {
      if (followingRef.current) return;
      if (!canMountAboveNow()) {
        pendingTopMountRef.current = true;
        return;
      }
      if (enlargeWindow("top")) return;
      if (flushBufferedPage()) return;
      void requestOlderPage();
    }, [canMountAboveNow, enlargeWindow, flushBufferedPage, requestOlderPage]);

    /** Keep the next page buffered while the reader is anywhere near the top. */
    const prefetchOlder = useCallback(() => {
      if (followingRef.current) return;
      const scroller = scrollerRef.current;
      if (!scroller || readContainerScrollTop(scroller) > PREFETCH_PX) return;
      void requestOlderPage();
    }, [requestOlderPage]);

    // ── Read line: the read receipts the reader generates ──────────────
    /**
     * Reports exactly ONE message per pass: the newest message that is fully
     * visible and was not sent by the reader. Everything above it was read.
     * Runs only at a verified rest, and only when the answer changed.
     */
    const reportVisibleReads = useCallback(() => {
      const id = conversationIdRef.current;
      const ownId = ownIdRef.current;
      const scroller = scrollerRef.current;
      if (!id || !scroller) return;

      const rows = rowsRef.current;
      const fold = readContainerScrollTop(scroller) + scroller.clientHeight;
      let at = findLastVisibleRowIndex(rows, fold);

      while (at >= 0) {
        const key = rows[at].dataset.messageKey;
        const index = key === undefined ? undefined : indexByKeyRef.current.get(key);
        const message = index === undefined ? undefined : messagesRef.current[index];
        if (message && message.sender_user_id !== ownId && !message.is_deleted) {
          if (key !== null && key !== lastReadKeyRef.current) {
            lastReadKeyRef.current = key ?? null;
            queueMarkRead(id, message.id, message.sent_at);
          }
          return;
        }
        at -= 1;
      }
    }, []);

    // ── The verified rest ──────────────────────────────────────────────
    /**
     * Everything that must not run under a live gesture or a coast. A quiet
     * event stream is not proof of a rest (iOS), so the rest is verified from
     * the position itself: if it moved since the last observation, re-arm
     * instead of touching the DOM.
     */
    const handleRest = useCallback(
      function handleRest() {
        if (pointerDownRef.current) return;
        const scroller = scrollerRef.current;
        if (!scroller) return;

        const scrollTop = readContainerScrollTop(scroller);
        if (Math.abs(scrollTop - bestPositionRef.current) > 1) {
          bestPositionRef.current = scrollTop;
          if (restTimerRef.current !== null) clearTimeout(restTimerRef.current);
          restTimerRef.current = setTimeout(() => {
            restTimerRef.current = null;
            handleRest();
          }, REST_MS);
          return;
        }

        coastingRef.current = false;
        restTimerRef.current = null;

        // Work the gate deferred: a page that was fetched mid-coast is mounted
        // now — otherwise the window slides into rows that are already loaded.
        if (pendingTopMountRef.current) {
          pendingTopMountRef.current = false;
          if (!flushBufferedPage()) expandOlderNow();
        }
        reportVisibleReads();
      },
      [flushBufferedPage, expandOlderNow, reportVisibleReads],
    );
    const restRef = useRef(handleRest);
    restRef.current = handleRest;

    const armRest = useCallback(() => {
      if (restTimerRef.current !== null) clearTimeout(restTimerRef.current);
      restTimerRef.current = setTimeout(() => {
        restTimerRef.current = null;
        restRef.current();
      }, REST_MS);
    }, []);

    // ── Bottom stickiness ──────────────────────────────────────────────
    /**
     * Arms native scroll snapping while the reader is within the band around the
     * bottom trigger, and disarms it the moment they leave. Snapping is what
     * makes "at the bottom" survive a growing list without a single `scrollTop`
     * write; disarming it is what lets the reader leave.
     */
    const syncBottomSnap = useCallback(() => {
      const scroller = scrollerRef.current;
      const trigger = bottomTriggerRef.current;
      if (!scroller || !trigger) return;

      const isArmed = scroller.classList.contains(BOTTOM_SNAP_CLASS);
      if (isAnimatingScroll(scroller)) {
        if (isArmed) scroller.classList.remove(BOTTOM_SNAP_CLASS);
        return;
      }

      const viewportBottom = readContainerScrollTop(scroller) + scroller.clientHeight;
      const triggerBottom = getOffsetToContainer(trigger, scroller) + trigger.offsetHeight;
      const shouldArm =
        triggerBottom - BOTTOM_SNAP_THRESHOLD <= viewportBottom &&
        viewportBottom <= triggerBottom + BOTTOM_SNAP_THRESHOLD * 2;

      if (shouldArm === isArmed) return;
      scroller.classList.toggle(BOTTOM_SNAP_CLASS, shouldArm);
    }, []);

    /**
     * Re-evaluates "the reader is following the conversation" from the element's
     * own geometry. Only the transition is applied, so an ordinary scroll pass
     * costs one read pair and no React work.
     */
    const updateFollowing = useCallback(() => {
      const scroller = scrollerRef.current;
      if (!scroller) return;
      const isFollowing =
        scroller.scrollHeight - readContainerScrollTop(scroller) - scroller.clientHeight <= FOLLOW_SLACK;
      if (isFollowing === followingRef.current) return;

      if (isFollowing) {
        followingRef.current = true;
        setFollowing(true);
        setUnread(0);
        // Back at the newest message: re-seed the window to the tail. Every row
        // that leaves is above the viewport, so nothing the reader sees moves.
        const next = tailKeyWindow(messagesRef.current);
        setWindow((current) => (sameKeyWindow(current, next) ? current : next));
      } else {
        followingRef.current = false;
        setFollowing(false);
        // Freeze the window on the mounted rows: an arrival must not pull the
        // reader down, it only raises the badge.
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
    const handleScroll = useCallback(() => {
      coastingRef.current = true;
      armRest();
      if (scrollRafRef.current !== null) return;
      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRafRef.current = null;
        const scroller = scrollerRef.current;
        if (scroller) bestPositionRef.current = readContainerScrollTop(scroller);
        updateFollowing();
        syncBottomSnap();
        prefetchOlder();
      });
    }, [armRest, updateFollowing, syncBottomSnap, prefetchOlder]);

    // ── Pointer/touch gate ─────────────────────────────────────────────
    // A release can happen outside the list (a flick that ends off-screen), so
    // the clearing listeners live on the window. Lifting the finger also arms
    // the rest, so the work the gate deferred happens right away.
    const markPointerDown = useCallback(() => {
      pointerDownRef.current = true;
    }, []);
    const clearPointerDown = useCallback(() => {
      if (!pointerDownRef.current) return;
      pointerDownRef.current = false;
      armRest();
    }, [armRest]);

    useEffect(() => {
      // `window` is the mounted-window state in this component, so the global is
      // addressed explicitly.
      const target = globalThis;
      target.addEventListener("pointerup", clearPointerDown, true);
      target.addEventListener("pointercancel", clearPointerDown, true);
      target.addEventListener("touchend", clearPointerDown, true);
      target.addEventListener("touchcancel", clearPointerDown, true);
      return () => {
        target.removeEventListener("pointerup", clearPointerDown, true);
        target.removeEventListener("pointercancel", clearPointerDown, true);
        target.removeEventListener("touchend", clearPointerDown, true);
        target.removeEventListener("touchcancel", clearPointerDown, true);
      };
    }, [clearPointerDown]);

    // ── History triggers ───────────────────────────────────────────────
    // Two 1px sentinels arm the slide into a new page. They only *request*: the
    // mount happens in a commit (or at a verified rest), so a trigger firing
    // mid-coast can never move the reader.
    const hasMessages = messages.length > 0;
    useEffect(() => {
      const scroller = scrollerRef.current;
      const top = topSentinelRef.current;
      const bottom = bottomSentinelRef.current;
      if (!scroller || typeof IntersectionObserver === "undefined" || (!top && !bottom)) return;

      const topObserver = top
        ? new IntersectionObserver(
            (entries) => {
              if (!entries.some((entry) => entry.isIntersecting)) return;
              expandOlderNow();
            },
            { root: scroller, rootMargin: `${HISTORY_TRIGGER_MARGIN}px 0px 0px 0px` },
          )
        : null;
      const bottomObserver = bottom
        ? new IntersectionObserver(
            (entries) => {
              if (!entries.some((entry) => entry.isIntersecting)) return;
              if (followingRef.current) return;
              enlargeWindow("bottom");
            },
            { root: scroller, rootMargin: `0px 0px ${HISTORY_TRIGGER_MARGIN}px 0px` },
          )
        : null;

      if (topObserver && top) topObserver.observe(top);
      if (bottomObserver && bottom) bottomObserver.observe(bottom);
      return () => {
        topObserver?.disconnect();
        bottomObserver?.disconnect();
      };
    }, [expandOlderNow, enlargeWindow, hasMessages]);

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

    // ── The single writer ──────────────────────────────────────────────
    // One commit, one decision, one `scrollTop` write — inside one forced reflow
    // so the read and the write never interleave with anything else.
    useLayoutEffect(() => {
      const scroller = scrollerRef.current;
      if (!scroller) return;

      const rows = collectRows(scroller);
      rowsRef.current = rows;
      const previous = prevCommitRef.current;
      const isFirstCommit = !didInitialPositionRef.current;
      const pendingJump = pendingJumpRef.current;
      const restore = initial.restore;
      // Consumed unconditionally: a FAB press that found the tail unchanged has
      // already had its pin applied by the branch below.
      const pendingBottomPin = pendingBottomPinRef.current;
      pendingBottomPinRef.current = false;

      requestForcedReflow(() => {
        const scrollTop = readContainerScrollTop(scroller);
        const scrollHeight = scroller.scrollHeight;
        const clientHeight = scroller.clientHeight;
        const containerTop = scroller.getBoundingClientRect().top;
        const bottomOffset = scrollHeight - scrollTop;

        // `scrollHeight - scrollTop` grew by exactly what was added below while
        // the reader did not move, so comparing it against the PREVIOUS viewport
        // height judges the reader's position as it was before this commit —
        // with no stored `scrollTop`, and therefore never stale after the reader
        // scrolled in between.
        const wasAtBottom = previous !== null
          && bottomOffset - previous.clientHeight <= AT_BOTTOM_THRESHOLD;
        const isAtBottomNow = bottomOffset - clientHeight <= AT_BOTTOM_THRESHOLD;
        const tailMoved = previous !== null && tailKey !== previous.tailKey;

        // The reader's anchor: a row whose scroll coordinate (content offset of
        // its top) is invariant under scrolling, so the delta it moved by IS the
        // layout change above the reader's place.
        //
        // Deliberately NOT the very first visible row: that one may change
        // height when older messages are mounted (a date separator moves to an
        // older message, a grouped bubble loses its header). Anchoring one row
        // lower keeps the reader immune to that — the same reason Telegram Web
        // anchors on `preservedItemElements[1]`.
        let firstVisible = -1;
        for (let at = 0; at < rows.length; at += 1) {
          if (rows[at].offsetTop + rows[at].offsetHeight > scrollTop + 1) {
            firstVisible = at;
            break;
          }
        }
        const anchorRow = firstVisible >= 0 ? rows[Math.min(firstVisible + 1, rows.length - 1)] : null;
        const anchorKey = anchorRow?.dataset.messageKey ?? null;
        const anchor = anchorKey
          ? { key: anchorKey, coord: anchorRow.getBoundingClientRect().top - containerTop + scrollTop }
          : null;

        const nextCommit = {
          anchorKey: anchor?.key ?? null,
          anchorCoord: anchor?.coord ?? 0,
          containerTop,
          clientHeight,
          tailKey,
        };

        let nextScrollTop: number | null = null;
        let pin = false;
        let glideTarget: HTMLElement | null = null;

        if (isFirstCommit) {
          didInitialPositionRef.current = true;
          const row = restore ? findRowByKey(rows, restore.key) : null;
          if (row && restore) {
            nextScrollTop = Math.max(0, row.offsetTop - restore.offset);
            followingRef.current = false;
          } else {
            pin = true;
          }
        } else if (pendingJump) {
          const row = findRowById(rows, pendingJump.id);
          if (row) {
            pendingJumpRef.current = null;
            if (isAtBottomNow && row === rows[rows.length - 1]) pin = true;
            else glideTarget = row;
            flashMessage(pendingJump.id);
          }
        } else if (tailMoved && followingRef.current) {
          // The reader is following the tail and it moved: glide the arrival in.
          // The trigger after the content is the target, so the glide lands on
          // the real bottom (the row's own end leaves the sentinels below it).
          if (pinnedTailRef.current !== tailKey) {
            pinnedTailRef.current = tailKey;
            glideTarget = bottomTriggerRef.current ?? (rows.length > 0 ? rows[rows.length - 1] : null);
          }
        } else if (pendingBottomPin) {
          pin = true;
        } else if (wasAtBottom) {
          if (!isAtBottomNow || tailMoved) pin = true;
        } else if (previous?.anchorKey && anchor) {
          const previousRow = findRowByKey(rows, previous.anchorKey);
          if (previousRow) {
            const coord = previousRow.getBoundingClientRect().top - containerTop + scrollTop;
            const growth = coord - previous.anchorCoord;
            const topDelta = containerTop - previous.containerTop;
            const target = scrollTop + growth - topDelta;
            if (Math.abs(target - scrollTop) > 0.5) nextScrollTop = target;
          }
        }

        const mutation = glideTarget
          ? animateScroll({
              container: scroller,
              element: glideTarget,
              position: "end",
              maxDistance: Number.MAX_SAFE_INTEGER,
              shouldReturnMutationFn: true,
            }) ?? null
          : null;

        return () => {
          prevCommitRef.current = nextCommit;
          if (mutation) {
            mutation();
          } else if (pin) {
            pinToBottom(scroller);
          } else if (nextScrollTop !== null) {
            setScrollTop(scroller, nextScrollTop);
          }
          // After the write: "is the reader at the bottom" is a property of the
          // new position, and snapping is armed from it.
          syncBottomSnap();
          bestPositionRef.current = readContainerScrollTop(scroller);
        };
      });

      // Read receipts and the mounts a gesture deferred land at the verified
      // rest, never during the commit itself.
      armRest();
    }, [
      messages,
      derived.start,
      derived.end,
      tailKey,
      following,
      initial.restore,
      flashMessage,
      syncBottomSnap,
      armRest,
    ]);

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

      // Mount the target before the glide: the writer above can only glide to a
      // row that is in the DOM. A window that already covers it is left alone.
      if (at >= derived.start && at < derived.end) return;
      const next: KeyWindow = {
        first: messageKey(list[Math.max(0, at - ANCHOR_BEFORE)]),
        last: messageKey(list[Math.min(list.length - 1, at + ANCHOR_AFTER)]),
      };
      setWindow((current) => (sameKeyWindow(current, next) ? current : next));
      setJumpNonce((nonce) => nonce + 1);
    }, [jumpNonce, messages, derived.start, derived.end, loadMoreMessages]);

    // ── Session anchor: persist the reader's place on unmount ──────────
    useEffect(() => {
      // Captured at mount: by the time the cleanup runs React may have already
      // detached the refs it owns.
      const scroller = scrollerRef.current;
      return () => {
        if (!conversationId || !scroller) return;
        if (followingRef.current) {
          clearMessageScrollAnchor(conversationId);
          return;
        }
        const scrollTop = readContainerScrollTop(scroller);
        for (const row of rowsRef.current) {
          if (row.offsetTop + row.offsetHeight <= scrollTop + 1) continue;
          const key = row.dataset.messageKey;
          if (!key) continue;
          writeMessageScrollAnchor(conversationId, { key, offset: Math.max(0, row.offsetTop - scrollTop) });
          return;
        }
      };
    }, [conversationId]);

    // ── Timer/listener cleanup ─────────────────────────────────────────
    useEffect(() => {
      return () => {
        if (restTimerRef.current !== null) clearTimeout(restTimerRef.current);
        if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current);
        if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current);
      };
    }, []);

    // ── Imperative API (ChatView) ──────────────────────────────────────
    const jumpToLatest = useCallback(() => {
      const list = messagesRef.current;
      if (list.length === 0) return;
      followingRef.current = true;
      setFollowing(true);
      setUnread(0);
      pendingJumpRef.current = null;
      pinnedTailRef.current = null;
      pendingBottomPinRef.current = true;
      // A glide across thousands of pixels reads as a hang: the window is
      // re-seeded to the newest rows and the position lands in one frame.
      setWindow(tailKeyWindow(list, RESET_WINDOW));
    }, []);

    const jumpToMessage = useCallback((messageId: string) => {
      const list = messagesRef.current;
      followingRef.current = false;
      setFollowing(false);
      pinnedTailRef.current = null;
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
    }, [loadMoreMessages]);

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
      // The pointer handlers are passive observers that open/close the "a
      // finger is on the list" gate — they never take over the gesture and the
      // wrapper is not an interactive control.
      // eslint-disable-next-line jsx-a11y/no-static-element-interactions
      <div
        className="message-scroll-wrap"
        onPointerDown={markPointerDown}
        onTouchStart={markPointerDown}
        onMouseDown={markPointerDown}
      >
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
            {/* The sentinels arm the slide into a new page; the bottom trigger
                is the scroll-snap target "at the bottom" clings to. None of them
                may ever be picked as a scroll anchor. */}
            <div ref={topSentinelRef} className="chat-scroll-sentinel scroll-sentinel-top" aria-hidden="true" />
            {rows}
            <div ref={bottomSentinelRef} className="chat-scroll-sentinel scroll-sentinel-bottom" aria-hidden="true" />
            <div ref={bottomTriggerRef} className="fab-trigger" aria-hidden="true" />
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
