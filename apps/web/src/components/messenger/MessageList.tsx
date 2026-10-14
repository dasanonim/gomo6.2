import {
  memo,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
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
import { HISTORY_HEADER_HEIGHT, virtualContentHeight } from "./core/scrollEngine";
import { useStickToBottom } from "./core/useStickToBottom";

// ── List-local constants ──────────────────────────────────────────────────
// Layout geometry (header/footer/slack/realign) lives in ./core/scrollEngine;
// the scroll position engine lives in ./core/useStickToBottom.
const TOP_LOAD_ZONE = 300;        // px from the top that arms the history loader
const OVERSCAN = 12;              // items rendered beyond the viewport (ТЗ: 8–15)
const NEW_MESSAGE_ANIMATION_MS = 1200; // how long an incoming message may play its entrance

// Extra heights (kept in sync with messenger.css) that sit INSIDE a virtual
// item but are invisible to a content-only estimate. Without them every
// message with a date separator / sender name / quote / link preview is
// underestimated and gets corrected by measureElement while the user scrolls,
// which shifts the layout mid-gesture.
const DATE_SEPARATOR_HEIGHT = 34;  // .date-separator — margin 12/6 + line
const SENDER_NAME_HEIGHT = 18;     // .msg-sender-name — group chats, first of author
const QUOTED_MESSAGE_HEIGHT = 34;  // .quoted-message — padding 6/6 + line + mb
const LINK_PREVIEW_HEIGHT = 60;    // .msg-link-panel — loading (40) to loaded (~90)
const ROW_GAP_HEIGHT = 8;          // .bubble-row padding-bottom — gap between messages

export interface MessageRenderExtras {
  dateLabel: string | null;
  isConsecutive: boolean;
  isNew: boolean;
}

export interface MessageListHandle {
  scrollToBottom: () => void;
  scrollToMessage: (messageId: string) => void;
}

interface MessageListProps {
  renderMessage: (message: MessageView, prev: MessageView | null, extras: MessageRenderExtras) => ReactNode;
  /** Notes self-chat: a filtered view of the store messages (folder filter).
   *  When omitted the full store list is used. */
  messagesOverride?: MessageView[];
}

/** The scroll anchor shape (top-most visible message + its offset above the
 *  viewport top) lives in ./core/scrollEngine and is re-used here. */

/**
 * Estimate the rendered height of a message BEFORE it is measured, so virtual
 * offsets don't drift when items are prepended or scrolled into view.
 *  - Media bubbles: the reserved box size is derived from the attachment
 *    aspect ratio (same math as getAttachmentDisplayStyle), so the estimate
 *    matches the real height almost exactly — images never reflow the list.
 *  - Text bubbles: one line ≈ 21px + bubble chrome; a rough char-per-line
 *    count keeps the estimate within a line or two of the measured height.
 */
function estimateMessageHeight(
  message: MessageView | undefined,
  prev: MessageView | null = null,
  isGroup = false,
): number {
  if (!message) return 72 + ROW_GAP_HEIGHT;
  // Shared-post cards (__SHARE__ token) have a deterministic layout: clamped
  // text lines + a fixed 16:9 thumbnail block. Estimate the full-card height
  // upfront so the virtualizer never reflows when the entity resolves; the
  // measured height matches within a few px (or the anchor correction absorbs
  // the difference when the post has no image).
  if (message.content?.startsWith("__SHARE__")) return 430 + ROW_GAP_HEIGHT;
  // Gift cards render a fixed standalone card.
  if (message.content?.startsWith("__GIFT__")) return 190 + ROW_GAP_HEIGHT;

  // Elements above the bubble that the content estimate cannot see. Kept in
  // sync with renderMessage: the date separator shows on the first message of
  // a day (and the very first of the list), the group sender name on the first
  // message of each author, the quote strip whenever parent_message_id is set.
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
      // getAttachmentDisplayStyle: boxWidth = min(420, 480 * ratio).
      const boxWidth = Math.min(420, 480 * ratio);
      const boxHeight = Math.round(boxWidth / ratio);
      const captionLines = message.content?.trim()
        ? Math.max(1, Math.ceil(message.content.length / 55))
        : 0;
      return extra + 14 + boxHeight + captionLines * 21 + ROW_GAP_HEIGHT;
    }
  }
  const chars = message.content?.length ?? 0;
  const lines = chars === 0 ? 1 : Math.max(1, Math.ceil(chars / 55));
  return extra + 18 + lines * 21 + ROW_GAP_HEIGHT;
}

/**
 * Owns the virtualized message list for the open conversation (@tanstack/react-virtual).
 *
 * The list is plain top-anchored content: index 0 = oldest message at the top,
 * the newest message at the bottom. All chat behavior is explicit and
 * deterministic — nothing fights the scroller:
 *
 *  - **Bottom pin** — while the user is at the bottom, every layout change
 *    (append, image load, measurement correction, keyboard open/close)
 *    re-clamps scrollTop to the real bottom in the same frame.
 *
 *  - **Anchor stabilization** — the instant the user scrolls up, the message
 *    at the top of the viewport (plus its pixel offset) is captured as the
 *    "anchor". From then on every layout change re-derives the scrollTop that
 *    keeps that exact message at that exact offset. Prepending older history,
 *    estimate→measured corrections, image loads — none of them move the
 *    visible content, because the anchor is restored in the same frame before
 *    paint. This is what makes history loading feel native: you keep reading,
 *    messages appear *above* the fold, nothing twitches.
 *
 *  - **History loader** — a scroll zone near the top + an in-flight guard +
 *    a cooldown fire `loadMoreMessages`.
 *
 *  - **Session restore** — returning to a chat restores the saved anchor
 *    (message id + viewport offset), auto-loading history until the anchor is
 *    present; the anchor releases as soon as the user scrolls away from it.
 *
 *  - **Live arrivals** — animate only while the user is at the bottom; scrolled
 *    up they count toward the "N new messages" pill instead.
 *
 * It is mounted per conversation (`key={conversation.id}` in ChatView), so all
 * refs/state below reset naturally when switching chats — the scroll anchor is
 * the only thing that survives (the session-scoped scrollPosition module).
 */
export const MessageList = memo(
  forwardRef<MessageListHandle, MessageListProps>(function MessageList({ renderMessage, messagesOverride }, ref) {
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
    // Keeping the composer visible over the soft keyboard is the shell's job
    // (messenger.css): two platforms, two mechanisms —
    //  • iOS (Safari)     — the layout never resizes; the message area +
    //    composer are lifted by a compositor-only `translate` (--kb-inset), so
    //    clientHeight stays put and the bottom pin below is a no-op.
    //  • Layout-resizing (Chrome/Firefox Android with interactive-widget=
    //    resizes-content, Firefox on iOS) — the layout viewport really shrinks
    //    with the keyboard: the fixed panel rises natively (composer clears
    //    the keyboard without any translate), but the scroller's clientHeight
    //    drops while scrollTop is left untouched (the scroll range grew, so
    //    there is no browser clamp) — the newest messages fall below the
    //    composer. The bottom pin re-runs on the SCROLLER'S real resize:
    //    the virtualizer's ResizeObserver updates `scrollRect` (reactive,
    //    `maybeNotify()` → re-render), so `scrollRect.height` is the dep that
    //    re-pins the list to the new bottom. It fires from the layout itself —
    //    no visual-viewport heuristics, no platform sniffing.
    const scrollerRef = useRef<HTMLDivElement | null>(null);

    const [newMessageCount, setNewMessageCount] = useState(0);
    const [newMessageIds, setNewMessageIds] = useState<Set<string>>(() => new Set());

    const loadingMoreRef = useRef(false);
    const lastLoadAtRef = useRef(0);
    const prevLastIdRef = useRef<string | null>(null);
    // Handles for the pending entrance-animation clear timers, so unmount
    // cancels them (a late setState after React is gone would throw).
    const entranceTimersRef = useRef<Set<number>>(new Set());

    // Identity key matches the store's dedup key (client_id || id), so a temp
    // message later replaced by its server twin keeps its virtual slot.
    const messageKey = useCallback((m: MessageView) => m.client_id ?? m.id, []);

    const virtualizer = useVirtualizer({
      count: messages.length,
      getScrollElement: () => scrollerRef.current,
      estimateSize: (index) =>
        estimateMessageHeight(messages[index], messages[index - 1] ?? null, isGroupConversation),
      overscan: OVERSCAN,
      getItemKey: (index) => messageKey(messages[index]),
    });

    // Scroll position engine — the bottom pin, the live anchor, session restore
    // and the issue-#508 settle loop all live in ./core/useStickToBottom.
    const stick = useStickToBottom({
      scrollerRef,
      messages,
      virtualizer,
      conversationId,
      // A return to the bottom clears the "N new messages" pill.
      onAtBottomChange: () => setNewMessageCount(0),
    });
    const {
      isAtBottom,
      isAtBottomRef,
      restoreAnchorRef,
      handleScroll: handleStickScroll,
      handlePointerDown,
      handlePointerUp,
      scrollToBottom,
    } = stick;

    // ── Read receipts: the "read line" (Telegram-style) ────────────────
    // The UI reports exactly ONE message per pass: the newest message fully
    // visible on screen. Everything above it was read; everything below the
    // fold stays unread. The store debounces and the backend marks the whole
    // prefix up to that message, so a scroll burst costs a single request
    // instead of one per message (per-message marking exhausted the
    // rate-limit budget and 429'd the whole app).
    const reportVisibleReads = useCallback(() => {
      const el = scrollerRef.current;
      if (!el || !conversationId || !meId) return;
      const viewportBottom = el.scrollTop + el.clientHeight;
      // Virtual items are ordered oldest → newest; the last one whose bottom
      // edge is at or above the viewport bottom is the read line.
      let readLine: MessageView | null = null;
      for (const item of virtualizer.getVirtualItems()) {
        const message = messages[item.index];
        if (!message) continue;
        if (message.sender_user_id === meId || message.is_deleted) continue;
        const itemBottom = HISTORY_HEADER_HEIGHT + item.end;
        if (itemBottom <= viewportBottom) {
          readLine = message;
        } else {
          // Everything newer is even lower — stop scanning.
          break;
        }
      }
      if (readLine) queueMarkRead(conversationId, readLine.id, readLine.sent_at);
    }, [conversationId, meId, messages, virtualizer]);

    // ── Scroll: the stick engine + the two list concerns that ride on it ──
    // useStickToBottom owns the at-bottom tracking, the anchor and the settle
    // loop; here we add the read line and the history loader.
    const handleScroll = useCallback(() => {
      handleStickScroll();
      reportVisibleReads();

      const el = scrollerRef.current;
      if (!el) return;
      const now = Date.now();
      if (
        el.scrollTop <= TOP_LOAD_ZONE &&
        hasMoreMessages &&
        !isLoadingMore &&
        !loadingMoreRef.current &&
        conversationId &&
        now - lastLoadAtRef.current > 500
      ) {
        lastLoadAtRef.current = now;
        loadingMoreRef.current = true;
        loadMoreMessages(conversationId).finally(() => {
          loadingMoreRef.current = false;
        });
      }
    }, [
      handleStickScroll,
      reportVisibleReads,
      scrollerRef,
      hasMoreMessages,
      isLoadingMore,
      conversationId,
      loadMoreMessages,
    ]);

    const totalSize = virtualizer.getTotalSize();

    // ── Report read receipts after the scroll position has settled ───────
    // Runs after the pin/anchor effect above so the viewport is final when the
    // visible items are computed. handleScroll also reports on scroll events.
    useLayoutEffect(() => {
      reportVisibleReads();
    }, [totalSize, messages, virtualizer.scrollRect?.height, reportVisibleReads]);

    // ── Auto-load history until the saved anchor message is present ──────
    // Returning to a chat deep in history: keep prepending older pages until
    // the anchor arrives, then the layout effect above jumps to it. Capped to
    // avoid hammering.
    useEffect(() => {
      const anchor = restoreAnchorRef.current;
      if (!anchor || !conversationId) return;
      if (messages.some((m) => m.id === anchor.messageId)) return;
      if (!hasMoreMessages || loadingMoreRef.current) {
        // The anchor is unreachable (deleted / too deep) — fall back to the
        // default bottom-open behavior.
        restoreAnchorRef.current = null;
        return;
      }
      loadingMoreRef.current = true;
      loadMoreMessages(conversationId).finally(() => {
        loadingMoreRef.current = false;
      });
    }, [messages, hasMoreMessages, conversationId, loadMoreMessages, restoreAnchorRef]);

    // ── Realtime appends → "N new messages" pill + entrance animation ───
    // Messages that arrive while the user is at the bottom are visible, so
    // they play a one-shot entrance animation; the flag is cleared shortly
    // after so scrolling away and back never replays it. While scrolled up
    // they only count toward the pill and appear without animation when the
    // user scrolls down to them (like Telegram).
    useEffect(() => {
      if (messages.length === 0) {
        prevLastIdRef.current = null;
        return;
      }
      const lastId = messages[messages.length - 1].id;
      const previousLast = prevLastIdRef.current;
      if (previousLast !== null && lastId !== previousLast) {
        const previousLastIndex = messages.findIndex((m) => m.id === previousLast);
        if (previousLastIndex >= 0) {
          const appended = messages.slice(previousLastIndex + 1);
          if (appended.length > 0) {
            if (isAtBottomRef.current) {
              const ids = appended.map((m) => m.id);
              setNewMessageIds((previous) => {
                const next = new Set(previous);
                for (const id of ids) next.add(id);
                return next;
              });
              const timerId = window.setTimeout(() => {
                entranceTimersRef.current.delete(timerId);
                setNewMessageIds((previous) => {
                  const next = new Set(previous);
                  for (const id of ids) next.delete(id);
                  return next;
                });
              }, NEW_MESSAGE_ANIMATION_MS);
              entranceTimersRef.current.add(timerId);
            } else {
              // Own optimistic messages are not counted in the pill.
              const incoming = appended.filter((m) => m.localStatus !== "sending").length;
              if (incoming > 0) setNewMessageCount((count) => count + incoming);
            }
          }
        }
      }
      prevLastIdRef.current = lastId;
    }, [messages, isAtBottomRef]);

    // Cancel any still-pending animation timers on unmount. Without this a
    // message arriving right before teardown leaves a timer that fires into a
    // torn-down environment (jsdom: window is gone) — an unhandled error that
    // fails the test run.
    useEffect(() => {
      const timers = entranceTimersRef.current;
      return () => {
        for (const id of timers) window.clearTimeout(id);
        timers.clear();
      };
    }, []);

    // ── Imperative API (send-scroll, pinned-message jump) ───────────────
    // `scrollToBottom` comes from useStickToBottom (it owns the anchor state).
    const scrollToMessage = useCallback(
      (messageId: string) => {
        const index = messages.findIndex((m) => m.id === messageId);
        if (index < 0) return;
        virtualizer.scrollToIndex(index, { align: "center" });
      },
      [messages, virtualizer],
    );

    useImperativeHandle(ref, () => ({ scrollToBottom, scrollToMessage }), [scrollToBottom, scrollToMessage]);

    if (messages.length === 0) return null;

    const virtualItems = virtualizer.getVirtualItems();
    const contentHeight = virtualContentHeight(totalSize);

    return (
      <>
        <div className="message-scroll-wrap">
          <div
            ref={scrollerRef}
            className="message-scroll"
            role="log"
            aria-label="Сообщения"
            aria-live="polite"
            onScroll={handleScroll}
            onPointerDown={handlePointerDown}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
          >
            <div className="message-virtual-list" style={{ height: contentHeight }}>
              {/* Fixed-height box in all states (loading / idle / end) so the
                  header never shifts the items below it during prepends. */}
              <div className={`msg-history-header${isLoadingMore ? " is-loading" : ""}${hasMoreMessages ? "" : " is-end"}`}>
                {isLoadingMore ? (
                  <span className="msg-history-loader" role="status" aria-live="polite">
                    <span className="msg-history-loader-spinner" aria-hidden="true" />
                    <span>Загружаем историю…</span>
                  </span>
                ) : hasMoreMessages ? (
                  <span className="msg-history-spacer" aria-hidden="true" />
                ) : (
                  <span className="msg-history-end-label">Начало переписки</span>
                )}
              </div>

              {virtualItems.map((row) => {
                const message = messages[row.index];
                if (!message) return null;
                const prev = row.index > 0 ? messages[row.index - 1] : null;
                return (
                  <div
                    key={row.key}
                    data-index={row.index}
                    data-message-id={message.id}
                    ref={virtualizer.measureElement}
                    className="message-virtual-item"
                    style={{ position: "absolute", top: HISTORY_HEADER_HEIGHT + row.start, left: 0, right: 0 }}
                  >
                    {renderMessage(message, prev, {
                      dateLabel: getDateSeparator(prev, message),
                      isConsecutive: isConsecutive(prev, message),
                      isNew: newMessageIds.has(message.id),
                    })}
                  </div>
                );
              })}

              {/* Real bottom gap — a list element so it participates in the
                  scroll math (scroller padding would sit below the fold). */}
              <div
                className="message-list-footer"
                aria-hidden="true"
                style={{ position: "absolute", top: HISTORY_HEADER_HEIGHT + totalSize, left: 0, right: 0 }}
              />
            </div>
          </div>
        </div>

        {!isAtBottom && (
          <button
            type="button"
            className="scroll-to-bottom-btn"
            onClick={scrollToBottom}
            aria-label={
              newMessageCount > 0
                ? `Прокрутить вниз (${newMessageCount} ${newMessageCount === 1 ? "новое" : "новых"} сообщени${newMessageCount === 1 ? "е" : "й"})`
                : "Прокрутить вниз"
            }
          >
            <ChevronDown size={20} />
            {newMessageCount > 0 && (
              <span className="scroll-to-bottom-badge">{newMessageCount > 99 ? "99+" : newMessageCount}</span>
            )}
          </button>
        )}
      </>
    );
  }),
);
