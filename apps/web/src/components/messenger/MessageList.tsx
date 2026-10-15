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
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown } from "lucide-react";
import { useMessengerStore, queueMarkRead } from "@/stores/messengerStore";
import type { MessageView } from "./types";
import { isConsecutive, getDateSeparator } from "./messageListUtils";
import { getAttachmentAspectRatio } from "./attachmentMedia";
import { messageKey } from "./core/messageModel";
import { BubbleMeasurer, rowHeightFromBubble } from "./core/offscreenMeasure";
import {
  clearMessageScrollAnchor,
  readMessageScrollAnchor,
  writeMessageScrollAnchor,
  type MessageScrollAnchor,
} from "./core/messageScrollAnchors";

// ── List-local constants ───────────────────────────────────────────────────
/** Items rendered beyond the viewport. Deliberately small: every mounted row
 *  outside the viewport is a row that will be measured, and each measurement
 *  is a scroll-position correction. The library's own chat example uses 6. */
const OVERSCAN = 6;
/**
 * How close to the end still counts as "at the bottom". Deliberately small:
 * a wide slack reads as the list tugging the user downwards on every arrival.
 * The virtualizer applies the same number to `followOnAppend` and `isAtEnd()`.
 */
const SCROLL_END_THRESHOLD = 8;
/** Gap under the last message so a bubble never touches the composer. It is a
 *  virtualizer `paddingEnd`, so it participates in the scroll math instead of
 *  hiding below the fold as scroller padding would. */
const BOTTOM_GAP = 12;
/** Minimum gap between two history page requests (burst guard). */
const LOAD_COOLDOWN_MS = 500;
/** How long the scroller must be quiet before a history page is requested.
 *  Longer than the library's `isScrollingResetDelay` (150ms) so the request
 *  never overlaps a live momentum scroll. */
const LOAD_SETTLE_MS = 220;
/** Start fetching the next older page this many rows before the top of the
 *  loaded history — a deliberately large runway, so the page is already here
 *  (and already inserted) long before the reader arrives, however fast they
 *  fling. The buffer on top of that holds up to two more pages. */
const HISTORY_PREFETCH_ROWS = 100;
/** How many extra pages `scrollToMessage` may fetch while looking for a target. */
const MAX_JUMP_PAGES = 20;
/** Redisplays a jumped-to message for this long. */
const FLASH_MS = 1400;

/** Extra heights (kept in sync with messenger.css) that sit INSIDE a virtual
 *  item but are invisible to a content-only estimate. Without them every
 *  message with a date separator / sender name / quote / link preview is
 *  underestimated and gets corrected while the user scrolls, which shifts the
 *  layout mid-gesture. */
const DATE_SEPARATOR_HEIGHT = 34; // .date-separator — margin 12/6 + line
const SENDER_NAME_HEIGHT = 18; // .msg-sender-name — group chats, first of author
const QUOTED_MESSAGE_HEIGHT = 34; // .quoted-message — padding 6/6 + line + mb
const LINK_PREVIEW_HEIGHT = 60; // .msg-link-panel — loading (40) to loaded (~90)
const ROW_GAP_HEIGHT = 8; // .bubble-row padding-bottom — gap between messages

// ── Text metrics ───────────────────────────────────────────────────────────
// The estimate decides the *pre-measurement* offsets of every row. It has to
// be right, and in particular it has to scale with the column width: at 520px
// a bubble wraps ~55 characters per line, at a phone's ~220px only ~22. A
// single hard-coded characters-per-line number is calibrated for one width and
// then wrong by a factor of two on the other — every row is underestimated by
// tens of pixels, the virtualizer applies one correction per measured row, and
// on iOS (where those writes are deferred while the finger and momentum are
// live) the accumulated corrections land in one batch the moment the scroll
// stops. That batch is the visible jump.
//
// The constants below are fitted against real rendered bubbles at two widths
// (a 330px column and a 780px one); per-row error is ~4-5px with no systematic
// bias, against ~36px and a ~1100px accumulated bias before.
/** Bubble max width, mirroring `messenger.css`. */
const BUBBLE_MAX_WIDTH = 520;
/** Share of the scroller's width a text bubble can occupy. The CSS says
 *  `max-width: 88%`, but the row gutter, the avatar column of incoming groups
 *  and the stable scrollbar gutter bring the *text* box to ~0.675 of it. */
const BUBBLE_WIDTH_FACTOR = 0.675;
/** Bubble padding + border: the wrap width is the bubble minus this. */
const BUBBLE_CHROME_X = 22;
/** Average advance of the 14px messenger font over real (Cyrillic) text. */
const AVG_CHAR_PX = 9;
/** Line box of `.message-content` (line-height 20.3px, rounded up). */
const LINE_HEIGHT = 21;
/** Vertical bubble chrome (padding + border) around the text lines. */
const BUBBLE_CHROME_Y = 18;

/** The wrap width a bubble gets in a scroller of this width. */
function bubbleTextWidth(scrollerWidth: number): number {
  const bubble = Math.min(scrollerWidth * BUBBLE_WIDTH_FACTOR, BUBBLE_MAX_WIDTH);
  return Math.max(60, bubble - BUBBLE_CHROME_X);
}

export interface MessageRenderExtras {
  dateLabel: string | null;
  isConsecutive: boolean;
}

export interface MessageListHandle {
  /** Jump to the newest message (send / FAB). */
  scrollToBottom: () => void;
  /** Centre a message, paging older history until it is loaded. */
  scrollToMessage: (messageId: string) => void;
}

interface MessageListProps {
  renderMessage: (message: MessageView, prev: MessageView | null, extras: MessageRenderExtras) => ReactNode;
  /** Notes self-chat: a filtered view of the store messages (folder filter).
   *  When omitted the full store list is used. */
  messagesOverride?: MessageView[];
}

/**
 * The scroll anchor of a conversation lives in ./core/messageScrollAnchors as a
 * message key plus the pixels of it hidden above the fold. `scrollTop` alone is
 * unusable — it points at a different message as soon as any height above it
 * changes.
 */
type ScrollAnchor = MessageScrollAnchor;

/** The absolutely-positioned row box the virtualizer places and measures. */
const VIRTUAL_ROW_STYLE = {
  position: "absolute",
  top: 0,
  left: 0,
  width: "100%",
} as const;

/**
 * Height of a message's text at a given wrap width. Explicit newlines are real
 * breaks (the content renders with `white-space: pre-wrap`), so every line of
 * the message is wrapped on its own.
 */
function estimateTextHeight(content: string, textWidth: number): number {
  const charsPerLine = Math.max(8, Math.floor(textWidth / AVG_CHAR_PX));
  let lines = 0;
  for (const paragraph of content.split("\n")) {
    lines += Math.max(1, Math.ceil(paragraph.length / charsPerLine));
  }
  return Math.max(1, lines) * LINE_HEIGHT;
}

/**
 * Estimate the rendered height of a message BEFORE it is measured, so virtual
 * offsets don't drift when items are prepended or scrolled into view.
 *  - Media bubbles: the reserved box size is derived from the attachment
 *    aspect ratio (same math as getAttachmentDisplayStyle) and capped by the
 *    bubble's own width, so images never reflow the list.
 *  - Text bubbles: the line count comes from the real wrap width (see the
 *    metrics above).
 */
function estimateMessageHeight(
  message: MessageView | undefined,
  prev: MessageView | null = null,
  isGroup = false,
  textWidth = bubbleTextWidth(520),
): number {
  if (!message) return 72 + ROW_GAP_HEIGHT;
  // Shared-post cards (__SHARE__ token) have a deterministic layout: clamped
  // text lines + a fixed 16:9 thumbnail block. Estimate the full-card height
  // upfront so the virtualizer never reflows when the entity resolves.
  if (message.content?.startsWith("__SHARE__")) return 430 + ROW_GAP_HEIGHT;
  // Gift cards render a fixed standalone card.
  if (message.content?.startsWith("__GIFT__")) return 190 + ROW_GAP_HEIGHT;

  // Elements above the bubble that the content estimate cannot see. Kept in
  // sync with renderMessage: the date separator shows on the first message of
  // a day, the group sender name on the first message of each author, the
  // quote strip whenever parent_message_id is set.
  let extra = 0;
  if (prev == null || new Date(prev.sent_at).toDateString() !== new Date(message.sent_at).toDateString()) {
    extra += DATE_SEPARATOR_HEIGHT;
  }
  if (isGroup && (prev == null || prev.sender_user_id !== message.sender_user_id)) {
    extra += SENDER_NAME_HEIGHT;
  }
  if (message.parent_message_id) extra += QUOTED_MESSAGE_HEIGHT;
  if (/https?:\/\//.test(message.content ?? "")) extra += LINK_PREVIEW_HEIGHT;

  const visual = message.attachments?.filter((a) => a.type === "image" || a.type === "video") ?? [];
  const onlyMedia = visual.length > 0 && (message.attachments?.length ?? 0) === visual.length;
  if (onlyMedia) {
    const ratio = getAttachmentAspectRatio(visual[0]);
    if (Number.isFinite(ratio) && ratio > 0) {
      // getAttachmentDisplayStyle: boxWidth = min(420, 480 * ratio), further
      // capped by the bubble's own text box on narrow columns.
      const boxWidth = Math.min(420, 480 * ratio, textWidth + BUBBLE_CHROME_X);
      const boxHeight = Math.round(boxWidth / ratio);
      const captionLines = message.content?.trim()
        ? Math.max(1, Math.ceil(message.content.length / Math.max(8, Math.floor(textWidth / AVG_CHAR_PX))))
        : 0;
      return extra + 14 + boxHeight + captionLines * LINE_HEIGHT + ROW_GAP_HEIGHT;
    }
  }
  return extra + BUBBLE_CHROME_Y + estimateTextHeight(message.content ?? "", textWidth) + ROW_GAP_HEIGHT;
}

/**
 * Owns the virtualized message list for the open conversation
 * (@tanstack/react-virtual, end-anchored chat mode).
 *
 * The list keeps the natural order — index 0 = oldest at the top, the newest
 * at the bottom — inside a plain `overflow-y: auto` scroller. There is no
 * inverted transform and no hand-written scroll physics: the virtualizer owns
 * the scroll contract.
 *
 *  - **End anchoring** (`anchorTo: 'end'` + stable `messageKey` keys) keeps the
 *    message the user is reading at the same place when an older page is
 *    prepended, and keeps the bottom pinned while late measurements arrive.
 *  - **Follow on append** (`followOnAppend`) pulls in new messages only when
 *    the viewport was already at the end; readers further up are left alone and
 *    get the "N new messages" affordance instead.
 *  - **Sticky open** — until the user takes over the scroller, every layout
 *    change re-issues `scrollToEnd()`. That covers the two-stage open (cached
 *    snapshot, then the network page) and the estimate → measured correction
 *    cascade, which is exactly where a one-shot "scroll to bottom on mount"
 *    leaves a short strip unpainted at the bottom.
 *  - **History loader** — approaching the top fetches the previous page.
 *  - **Read line** — only messages that are actually on screen are reported,
 *    so a scroll burst costs one debounced request instead of one per message.
 *
 * It is mounted per conversation (`key={conversation.id}` in ChatView), so all
 * refs/state below reset naturally when switching chats.
 */
export const MessageList = memo(
  forwardRef<MessageListHandle, MessageListProps>(function MessageList(
    { renderMessage, messagesOverride },
    ref,
  ) {
    const conversationId = useMessengerStore((s) => s.selectedConversationId);
    const meId = useMessengerStore((s) => s.me?.id);
    const storeMessages = useMessengerStore((s) => s.messages);
    // Notes self-chat passes a folder-filtered view; regular chats use the full list.
    const messages = messagesOverride ?? storeMessages;
    const isGroupConversation = useMessengerStore(
      (s) => s.conversations.find((c) => c.id === s.selectedConversationId)?.is_group ?? false,
    );
    const hasMoreMessages = useMessengerStore((s) => s.hasMoreMessages);
    const isLoadingMore = useMessengerStore((s) => s.isLoadingMore);
    const loadMoreMessages = useMessengerStore((s) => s.loadMoreMessages);
    const flushPendingOlderMessages = useMessengerStore((s) => s.flushPendingOlderMessages);

    const scrollerRef = useRef<HTMLDivElement | null>(null);

    const [isAtBottom, setIsAtBottom] = useState(true);
    const [newMessageCount, setNewMessageCount] = useState(0);
    const [flashId, setFlashId] = useState<string | null>(null);
    /** Bumped when the scroller comes to rest, to retry the height priming. */
    const [primeNonce, setPrimeNonce] = useState(0);

    // True while the list follows the newest message. Set when the viewport is
    // at the end, cleared only by a real scroll-away gesture (never by a timer
    // and never by a measurement correction).
    const followingRef = useRef(true);
    // Set by any input that can start scrolling, and only cleared when the
    // reader genuinely leaves the end. The scroll pass decides — a pointer-down
    // on a bubble (long press) or a wheel at the very bottom must not unstick.
    const gestureRef = useRef(false);
    // Latest rendered messages, readable from event handlers and cleanup.
    const messagesRef = useRef<MessageView[]>(messages);
    messagesRef.current = messages;
    // Anchor captured on scroll while the user is reading history.
    const anchorRef = useRef<ScrollAnchor | null>(null);
    // One history request at a time, plus the cooldown between two pages.
    const loadInFlightRef = useRef(false);
    const lastLoadAtRef = useRef(0);
    /** Pending settle timer for the history loader (see armHistorySettle). */
    const loadDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Entry counting for the "N new messages" affordance.
    const prevCountRef = useRef(0);
    const prevLastKeyRef = useRef<string | null>(null);
    // A `scrollToMessage` target that has not been rendered yet.
    const pendingJumpRef = useRef<{ id: string; attempts: number } | null>(null);
    const didInitialPositionRef = useRef(false);
    const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const scrollRafRef = useRef<number | null>(null);

    // Wrap width of the message column. The estimate has to know it (see the
    // text metrics above); it is refreshed from the scroller's *tracked* width
    // — no DOM read on the scroll path. Before the first measurement the
    // window width is a close enough stand-in for a chat column.
    const scrollerWidthRef = useRef(
      typeof window === "undefined" ? 1200 : window.innerWidth,
    );

    // Stable identities matter: the virtualizer keys its measurement memo on
    // these functions, so a fresh arrow each render would force an O(count)
    // measurement pass on every scroll frame. The width is read through a ref
    // so a resize does not change the identity either.
    const estimateSize = useCallback(
      (index: number) =>
        estimateMessageHeight(
          messages[index],
          messages[index - 1] ?? null,
          isGroupConversation,
          bubbleTextWidth(scrollerWidthRef.current),
        ),
      [messages, isGroupConversation],
    );
    const getItemKey = useCallback(
      (index: number) => {
        const message = messages[index];
        // The canonical identity (client_id || id) — an optimistic row keeps
        // its slot when the server twin replaces it, and prepends stay stable.
        return message ? messageKey(message) : `index-${index}`;
      },
      [messages],
    );

    const virtualizer = useVirtualizer({
      count: messages.length,
      getScrollElement: () => scrollerRef.current,
      estimateSize,
      getItemKey,
      overscan: OVERSCAN,
      anchorTo: "end",
      followOnAppend: true,
      scrollEndThreshold: SCROLL_END_THRESHOLD,
      paddingEnd: BOTTOM_GAP,
      // Skip React re-renders for scroll-only updates: the virtualizer writes
      // row positions and the spacer height straight to the DOM and only
      // re-renders when the visible range changes. On iOS the main thread is
      // the scarce resource during a momentum scroll, and a React commit per
      // scroll event is exactly what makes it stutter.
      // Contract: rows are `position: absolute` and carry no main-axis
      // position in their style, and the spacer receives `containerRef` and
      // sets no height — the virtualizer owns both.
      directDomUpdates: true,
    });

    const totalSize = virtualizer.getTotalSize();

    // Keep the wrap width the estimates use in sync with the real column. The
    // value comes from the scroller's tracked rect, so a phone rotation or a
    // keyboard-driven resize costs nothing on the scroll path.
    useLayoutEffect(() => {
      const width = virtualizer.scrollRect?.width;
      if (width && width > 0) scrollerWidthRef.current = width;
    }, [virtualizer.scrollRect?.width]);

    // ── Scroll metrics from the virtualizer's own tracking ───────────────
    // Everything below reads the *tracked* offset and viewport height instead
    // of `scrollTop`/`clientHeight`/`scrollHeight` on the element. Those reads
    // force a layout flush, and on iOS Safari the element's values are
    // deferred behind the compositor while a finger and the momentum are on
    // screen — measuring there is what makes momentum scroll stutter.
    const readScrollMetrics = useCallback(() => {
      const offset = virtualizer.scrollOffset ?? 0;
      const viewport = virtualizer.scrollRect?.height ?? 0;
      return { offset, viewport, distanceFromEnd: Math.max(virtualizer.getTotalSize() - viewport - offset, 0) };
    }, [virtualizer]);

    /** The message currently at the top of the viewport, and its offset. */
    const captureAnchor = useCallback((): ScrollAnchor | null => {
      const { offset } = readScrollMetrics();
      const items = virtualizer.getVirtualItems();
      for (const item of items) {
        const message = messagesRef.current[item.index];
        if (!message) continue;
        // The first item whose bottom edge is below the fold top is the one
        // straddling the viewport's upper boundary.
        if (item.end > offset + 1) {
          return { key: messageKey(message), offset: item.start - offset };
        }
      }
      return null;
    }, [virtualizer, readScrollMetrics]);

    // ── History paging ──────────────────────────────────────────────────
    // Two separate decisions, because they have different constraints:
    //  * the *request* may happen at any time — it touches no DOM, and it has
    //    to start early so the page is already here when the reader arrives.
    //    A request gated on "the scroller is at rest" never fires during a
    //    fling at all, which is why the history used to arrive too late.
    //  * the *insert* moves the scroll position, so it waits for a rest. A page
    //    inserted mid-momentum shifts the content under the reader (the
    //    compensation for it is deferred on iOS until the coast ends) — that is
    //    the "thrown thousands of pixels" behaviour.
    const requestHistoryPage = useCallback(() => {
      if (!conversationId) return;
      if (!hasMoreMessages || isLoadingMore || loadInFlightRef.current) return;
      const range = virtualizer.range;
      // A null range means the scroller has not been measured yet — never
      // treat "unknown" as "at the top".
      if (!range || range.startIndex > HISTORY_PREFETCH_ROWS) return;
      const now = Date.now();
      if (now - lastLoadAtRef.current < LOAD_COOLDOWN_MS) return;
      lastLoadAtRef.current = now;
      loadInFlightRef.current = true;
      void loadMoreMessages(conversationId, { postpone: true }).finally(() => {
        loadInFlightRef.current = false;
      });
    }, [conversationId, hasMoreMessages, isLoadingMore, loadMoreMessages, virtualizer]);

    const flushHistoryPage = useCallback(() => {
      if (!conversationId || virtualizer.isScrolling) return;
      flushPendingOlderMessages(conversationId);
    }, [conversationId, virtualizer, flushPendingOlderMessages]);

    /** Insert whatever is buffered once the scroller has come to rest, then
     *  top the runway back up. Never inserts while the coast is live. */
    const armHistorySettle = useCallback(() => {
      const schedule = () => {
        if (loadDebounceRef.current !== null) clearTimeout(loadDebounceRef.current);
        loadDebounceRef.current = setTimeout(() => {
          loadDebounceRef.current = null;
          // Still moving (the library's own isScrolling stays true for a moment
          // after the last scroll event): wait for the next quiet moment.
          if (virtualizer.isScrolling) {
            schedule();
            return;
          }
          flushHistoryPage();
          requestHistoryPage();
          // Retry the exact-height priming that was skipped while moving.
          setPrimeNonce((nonce) => nonce + 1);
        }, LOAD_SETTLE_MS);
      };
      schedule();
    }, [virtualizer, flushHistoryPage, requestHistoryPage]);

    // ── Read receipts: the "read line" (Telegram-style) ─────────────────
    // The UI reports exactly ONE message per pass: the newest message fully
    // visible on screen. Everything above it was read; everything below the
    // fold stays unread. The store debounces and the backend marks the whole
    // prefix up to that message, so a scroll burst costs a single request
    // instead of one per message.
    const reportVisibleReads = useCallback(() => {
      if (!conversationId || !meId) return;
      const { offset, viewport } = readScrollMetrics();
      const viewportBottom = offset + viewport;
      let readLine: MessageView | null = null;
      for (const item of virtualizer.getVirtualItems()) {
        const message = messagesRef.current[item.index];
        if (!message) continue;
        if (message.sender_user_id === meId || message.is_deleted) continue;
        if (item.end <= viewportBottom) {
          readLine = message;
        } else {
          // Everything newer sits even lower — stop scanning.
          break;
        }
      }
      if (readLine) queueMarkRead(conversationId, readLine.id, readLine.sent_at);
    }, [conversationId, meId, virtualizer, readScrollMetrics]);

    // ── Scroll handling ─────────────────────────────────────────────────
    // One pass per frame, all of it pure arithmetic on the virtualizer's own
    // numbers — no DOM measurement, no writes while a gesture is in flight.
    const runScrollWork = useCallback(() => {
      const atEnd = readScrollMetrics().distanceFromEnd <= SCROLL_END_THRESHOLD;
      if (atEnd) {
        // Back at the newest message: follow again and clear the affordance.
        // `gestureRef` is deliberately NOT cleared here: during an iOS momentum
        // scroll the tracked offset lags, so an "at the end" sample can still
        // arrive after the reader has genuinely left the bottom. Clearing the
        // gesture there used to leave `followingRef` stuck true, and the settle
        // pass below then re-pinned the list to the bottom mid-flick — the
        // "jitters while it coasts, teleports when it stops" behaviour.
        anchorRef.current = null;
        followingRef.current = true;
        setIsAtBottom(true);
        setNewMessageCount((count) => (count === 0 ? count : 0));
      } else if (gestureRef.current) {
        // The reader scrolled away from the end on purpose.
        gestureRef.current = false;
        followingRef.current = false;
        setIsAtBottom(false);
        anchorRef.current = captureAnchor();
      } else if (!followingRef.current) {
        // Keep the saved anchor fresh while reading history (measurements and
        // prepends move it, but the message under the reader must not).
        anchorRef.current = captureAnchor();
      }
      reportVisibleReads();
      // Ask for the next page right away (never gated on being at rest), and
      // arm the settle timer that will insert it once the coast ends.
      requestHistoryPage();
      armHistorySettle();
    }, [readScrollMetrics, captureAnchor, reportVisibleReads, requestHistoryPage, armHistorySettle]);

    const handleScroll = useCallback(() => {
      if (scrollRafRef.current !== null) return;
      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRafRef.current = null;
        runScrollWork();
      });
    }, [runScrollWork]);

    /** Any input that may start a scroll. The scroll handler decides whether
     *  the viewport actually left the end. */
    const markGestureIntent = useCallback(() => {
      gestureRef.current = true;
    }, []);

    const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
        gestureRef.current = true;
      }
    }, []);

    useEffect(() => {
      return () => {
        if (scrollRafRef.current !== null) {
          cancelAnimationFrame(scrollRafRef.current);
          scrollRafRef.current = null;
        }
        if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current);
        if (loadDebounceRef.current !== null) {
          clearTimeout(loadDebounceRef.current);
          loadDebounceRef.current = null;
        }
      };
    }, []);

    // ── Prime exact heights before a row is ever rendered ───────────────
    // WebKit drops `scrollTop` writes during a momentum scroll (WebKit bug
    // 187449), so every measurement correction the virtualizer makes while the
    // reader is coasting is deferred and replayed in ONE write when the scroll
    // settles — that batched write is the jump: the view moves by the sum of
    // (measured − estimated) over the rows that scrolled into view.
    //
    // The way out is to have the exact height *before* the row is ever
    // rendered; then there is no correction to defer. A rendered row already
    // has its exact height, so one clone of a real row is used as a template
    // and every not-yet-measured message is measured in it off-screen. This
    // runs when the data changes (a page arrives at a rest, or the chat opens),
    // never on the scroll path.
    const measurerRef = useRef<BubbleMeasurer | null>(null);
    useLayoutEffect(() => {
      const scroller = scrollerRef.current;
      if (!scroller || messages.length === 0) return;
      // Corrections produced while the reader is coasting are the ones WebKit
      // defers (and the flush is the jump), so prime only from a rest. The
      // settle timer bumps `primeNonce` to retry after the coast ends.
      if (virtualizer.isScrolling) return;
      const cache = virtualizer.itemSizeCache;
      const pending: number[] = [];
      for (let index = 0; index < messages.length; index += 1) {
        if (!cache.has(getItemKey(index))) pending.push(index);
      }
      if (pending.length === 0) return;
      if (measurerRef.current === null) {
        measurerRef.current = new BubbleMeasurer(
          () => scroller.closest(".chat-messages-area") ?? scroller.parentElement,
        );
      }
      const measurer = measurerRef.current;
      if (!measurer.canMeasure()) return;
      const heights = measurer.measure(
        pending.map((index) => messages[index]),
        scroller.clientWidth,
      );
      for (let slot = 0; slot < pending.length; slot += 1) {
        const bubbleHeight = heights[slot];
        if (bubbleHeight === null) continue;
        const index = pending[slot];
        const message = messages[index];
        const prev = index > 0 ? messages[index - 1] : null;
        const crossesDay =
          prev == null || new Date(prev.sent_at).toDateString() !== new Date(message.sent_at).toDateString();
        const startsSenderBlock =
          isGroupConversation && (prev == null || prev.sender_user_id !== message.sender_user_id);
        virtualizer.resizeItem(index, rowHeightFromBubble(bubbleHeight, crossesDay, startsSenderBlock));
      }
    }, [messages, isGroupConversation, virtualizer, getItemKey, primeNonce]);

    // ── Keep the cache honest for rows that render without a measurement ──
    // (media, share cards, rich text). Reading a mounted row's real height here
    // is cheap and only ever touches rows the cache has never seen.
    useLayoutEffect(() => {
      const scroller = scrollerRef.current;
      if (!scroller) return;
      const rows = scroller.querySelectorAll<HTMLElement>(".message-row[data-index]");
      if (rows.length === 0) return;
      const sizes: Array<{ index: number; size: number }> = [];
      for (const row of rows) {
        const index = Number(row.dataset.index);
        if (!Number.isInteger(index) || index < 0 || index >= messages.length) continue;
        if (virtualizer.itemSizeCache.has(getItemKey(index))) continue;
        // `offsetHeight` is the integer the library's own DOM fallback uses.
        const size = row.offsetHeight;
        if (size > 0) sizes.push({ index, size });
      }
      // Every read happens above, every write below: interleaving them would
      // thrash the layout once per row.
      for (const item of sizes) virtualizer.resizeItem(item.index, item.size);
    }, [messages, virtualizer, getItemKey]);

    // ── Initial position: restored anchor, else the newest message ───────
    useLayoutEffect(() => {
      if (didInitialPositionRef.current || messages.length === 0) return;
      didInitialPositionRef.current = true;
      const saved = conversationId ? readMessageScrollAnchor(conversationId) : undefined;
      if (saved) {
        const index = messages.findIndex((message) => messageKey(message) === saved.key);
        if (index >= 0) {
          const target = virtualizer.getOffsetForIndex(index, "start");
          if (target) {
            followingRef.current = false;
            anchorRef.current = saved;
            virtualizer.scrollToOffset(Math.max(0, target[0] - saved.offset), { align: "start" });
            return;
          }
        }
      }
      virtualizer.scrollToEnd();
    }, [conversationId, messages, virtualizer]);

    // Settle the open: until the reader touches the scroller, every layout
    // change re-pins the bottom (estimate → measured heights, cached page →
    // network page). The `gestureRef` gate is what keeps this from ever
    // writing a scroll position under a finger or a momentum scroll — that is
    // the whole reason it is allowed to exist. Declared AFTER the restore
    // effect so a restored anchor wins.
    useLayoutEffect(() => {
      if (!followingRef.current || gestureRef.current || messages.length === 0) return;
      virtualizer.scrollToEnd();
    }, [messages, totalSize, virtualizer]);

    // ── "N new messages" + unread affordance ────────────────────────────
    useEffect(() => {
      const last = messages[messages.length - 1];
      const lastKey = last ? messageKey(last) : null;
      // Only a NEW TAIL counts. A prepended history page also grows the array,
      // but leaves the last key untouched.
      const arrived = messages.length - prevCountRef.current;
      const grew = arrived > 0 && lastKey !== prevLastKeyRef.current;
      // The delta is captured eagerly: a lazy updater would read the ref after
      // it has already been advanced below and always add zero.
      if (grew && !followingRef.current) {
        setNewMessageCount((count) => count + arrived);
      }
      prevCountRef.current = messages.length;
      prevLastKeyRef.current = lastKey;
    }, [messages]);

    // The virtual window is up to date after every commit; report the read
    // line, insert a buffered page when the scroller is at rest, and keep the
    // history runway topped up — all from the rendered range, so they work even
    // when no scroll event fires (open, prepend, restored placement).
    useLayoutEffect(() => {
      reportVisibleReads();
      // Insert immediately when we are already at rest; otherwise the settle
      // timer below retries until the coast ends. Without arming it here, a
      // page that arrives while the reader is idle would wait for the next
      // scroll event before it is ever shown.
      flushHistoryPage();
      requestHistoryPage();
      armHistorySettle();
    }, [
      totalSize,
      messages,
      virtualizer.scrollRect?.height,
      reportVisibleReads,
      flushHistoryPage,
      requestHistoryPage,
      armHistorySettle,
    ]);

    // ── Jump to a message (pinned banner, quoted reply) ─────────────────
    const flashMessage = useCallback((id: string) => {
      setFlashId(id);
      if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current);
      flashTimerRef.current = setTimeout(() => {
        flashTimerRef.current = null;
        setFlashId(null);
      }, FLASH_MS);
    }, []);

    useLayoutEffect(() => {
      const pending = pendingJumpRef.current;
      if (!pending) return;
      const index = messages.findIndex((message) => message.id === pending.id);
      if (index >= 0) {
        pendingJumpRef.current = null;
        followingRef.current = false;
        virtualizer.scrollToIndex(index, { align: "center" });
        flashMessage(pending.id);
        return;
      }
      if (hasMoreMessages && !isLoadingMore && pending.attempts < MAX_JUMP_PAGES && conversationId) {
        pending.attempts += 1;
        void loadMoreMessages(conversationId);
        return;
      }
      // The target is not reachable (deleted, or beyond the loaded history).
      pendingJumpRef.current = null;
    }, [messages, hasMoreMessages, isLoadingMore, conversationId, loadMoreMessages, virtualizer, flashMessage]);

    // ── Session anchor: keep it fresh, persist it on unmount ────────────
    useEffect(() => {
      return () => {
        if (!conversationId) return;
        const anchor = followingRef.current ? null : anchorRef.current;
        if (anchor) writeMessageScrollAnchor(conversationId, anchor);
        else clearMessageScrollAnchor(conversationId);
      };
    }, [conversationId]);

    // ── Imperative API (ChatView) ───────────────────────────────────────
    const jumpToLatest = useCallback(() => {
      gestureRef.current = false;
      followingRef.current = true;
      anchorRef.current = null;
      setNewMessageCount(0);
      setIsAtBottom(true);
      // A long smooth scroll across thousands of pixels reads as a hang; only
      // animate when the target is genuinely close.
      const shortHop = virtualizer.getDistanceFromEnd() < 2 * (virtualizer.scrollRect?.height ?? 0);
      virtualizer.scrollToEnd({ behavior: shortHop ? "smooth" : "auto" });
    }, [virtualizer]);

    const jumpToMessage = useCallback(
      (messageId: string) => {
        pendingJumpRef.current = { id: messageId, attempts: 0 };
        followingRef.current = false;
        gestureRef.current = false;
        setIsAtBottom(false);
        // Kick the attempt immediately for the already-loaded case; otherwise
        // the layout effect continues it as history pages arrive.
        const index = messagesRef.current.findIndex((message) => message.id === messageId);
        if (index >= 0) {
          pendingJumpRef.current = null;
          virtualizer.scrollToIndex(index, { align: "center" });
          flashMessage(messageId);
        } else if (conversationId) {
          pendingJumpRef.current.attempts = 1;
          void loadMoreMessages(conversationId);
        }
      },
      [virtualizer, conversationId, loadMoreMessages, flashMessage],
    );

    useImperativeHandle(
      ref,
      () => ({ scrollToBottom: jumpToLatest, scrollToMessage: jumpToMessage }),
      [jumpToLatest, jumpToMessage],
    );

    const virtualItems = virtualizer.getVirtualItems();

    const renderedRows = useMemo(
      () =>
        virtualItems.map((item) => {
          const message = messages[item.index];
          if (!message) return null;
          const prev = item.index > 0 ? messages[item.index - 1] : null;
          return (
            <div
              key={item.key}
              data-index={item.index}
              data-message-id={message.id}
              ref={virtualizer.measureElement}
              className={`message-row${flashId === message.id ? " is-flash" : ""}`}
              // No transform here: with `directDomUpdates` the virtualizer owns
              // the main-axis position and writes it directly (see the
              // virtualizer options above).
              style={VIRTUAL_ROW_STYLE}
            >
              {renderMessage(message, prev, {
                dateLabel: getDateSeparator(prev, message),
                isConsecutive: isConsecutive(prev, message),
              })}
            </div>
          );
        }),
      [virtualItems, messages, renderMessage, flashId, virtualizer],
    );

    if (messages.length === 0) return null;

    return (
      // Gesture intent lives on the wrapper, not on the scroller: these events
      // bubble up from the scroll container, and the container's `role="log"`
      // must stay a plain content region. They are passive observers — nothing
      // consumes the gesture, so the wrapper needs no interactive role.
      // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- passive touch/wheel/key observers, they do not take over the gesture
      <div
        className="message-scroll-wrap"
        onPointerDown={markGestureIntent}
        onWheel={markGestureIntent}
        onTouchStart={markGestureIntent}
        onKeyDown={handleKeyDown}
      >
        {/* Loader floats over the list — it must not take part in the scroll
            math, or arming it would shift the content it is loading. */}
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
          // role="log" implies a polite live region. With virtualization every
          // scroll mounts and unmounts rows, which would make a screen reader
          // re-read the history on every window change. New messages are
          // announced through the dedicated status region below instead.
          aria-live="off"
          onScroll={handleScroll}
        >
          {/* The spacer height is written by the virtualizer through
              `containerRef` (see `directDomUpdates`); setting it here would be
              overwritten and would fight the end-anchored scroll sync. */}
          <div className="message-virtual-list" ref={virtualizer.containerRef}>
            {renderedRows}
          </div>
        </div>

        {!isAtBottom && (
          <button
            type="button"
            className={`scroll-to-bottom-btn${newMessageCount > 0 ? " has-new" : ""}`}
            onClick={jumpToLatest}
            aria-label={
              newMessageCount > 0
                ? `Новые сообщения: ${newMessageCount}. Перейти к последним`
                : "Перейти к последним сообщениям"
            }
          >
            {newMessageCount > 0 && (
              <span className="scroll-to-bottom-badge" aria-hidden="true">{newMessageCount}</span>
            )}
            <ChevronDown size={16} aria-hidden="true" />
          </button>
        )}

        {/* Announcements are throttled to the pill's own state so scrolling
            never replays the history. */}
        <div className="sr-only" role="status" aria-live="polite">
          {!isAtBottom && newMessageCount > 0
            ? `${newMessageCount} ${newMessageCount === 1 ? "новое сообщение" : "новых сообщений"}`
            : ""}
        </div>
      </div>
    );
  }),
);
