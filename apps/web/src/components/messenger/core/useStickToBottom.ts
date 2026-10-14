import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type MutableRefObject,
  type RefObject,
} from "react";
import type { useVirtualizer } from "@tanstack/react-virtual";
import type { MessageView } from "../types";
import { clearScrollPosition, getScrollPosition, saveScrollPosition } from "../scrollPosition";
import {
  ANCHOR_REALIGN_EPSILON,
  PIN_SETTLE_EPSILON,
  PIN_SETTLE_MAX_MS,
  anchorScrollTop,
  bottomTarget,
  captureAnchor as captureAnchorFromRows,
  isAtBottom as isAtBottomScroll,
  type ScrollAnchor,
} from "./scrollEngine";

/** The scrollTop that places `anchor` back where it was captured. Uses the
 *  virtualizer's offset lookup (not the rendered rows) so an anchor that is
 *  not mounted yet — e.g. while history is being hunted — still resolves. */
function resolveAnchorTarget(
  virtualizer: ReturnType<typeof useVirtualizer>,
  messages: MessageView[],
  anchor: ScrollAnchor,
): number | null {
  const index = messages.findIndex((message) => message.id === anchor.messageId);
  if (index < 0) return null;
  const offset = virtualizer.getOffsetForIndex(index);
  if (!offset) return null;
  return anchorScrollTop(offset[0], anchor.offset);
}

export interface UseStickToBottomParams {
  scrollerRef: RefObject<HTMLDivElement | null>;
  messages: MessageView[];
  virtualizer: ReturnType<typeof useVirtualizer>;
  conversationId: string | null;
  /** Fired when the at-bottom state flips (e.g. to clear the "N new" pill). */
  onAtBottomChange?: (atBottom: boolean) => void;
}

export interface UseStickToBottom {
  /** Whether the viewport is at (or within the slack of) the bottom. */
  isAtBottom: boolean;
  /** The same value as a ref — for effects that must not re-subscribe. */
  isAtBottomRef: MutableRefObject<boolean>;
  /** The session-saved anchor being restored, or null. Exposed so the list can
   *  hunt history until the anchor message is present. */
  restoreAnchorRef: MutableRefObject<ScrollAnchor | null>;
  /** Stick/anchor part of a scroll event; the list composes its own handler. */
  handleScroll: () => void;
  handlePointerDown: () => void;
  handlePointerUp: () => void;
  /** Imperative "go to the true bottom" (send scroll, FAB). */
  scrollToBottom: () => void;
}

/**
 * Owns the message list's scroll position: the bottom pin, the live scroll
 * anchor, session restore, and the self-healing settle from issue #508.
 *
 * The list stays a plain top-anchored scroller (index 0 = oldest at the top).
 * All behaviour is explicit — nothing fights the browser:
 *
 *  - **Bottom pin** — while the user is at the bottom, every layout change
 *    (append, image load, measurement correction, keyboard resize) re-clamps
 *    scrollTop to the real bottom in the same frame, then a bounded settle
 *    loop keeps re-clamping as late measurements land.
 *  - **Anchor stabilization** — the instant the user scrolls up, the message
 *    at the top edge (plus its pixel offset) is captured; every later layout
 *    change restores that exact message to that exact offset, so prepends and
 *    estimate→measured corrections never move the visible content.
 *  - **Session restore** — returning to a chat restores the saved anchor.
 *  - **Gesture safety** — no scrollTop is written while a gesture is in flight
 *    (`virtualizer.isScrolling`) or between pointerdown and the first scroll.
 */
export function useStickToBottom({
  scrollerRef,
  messages,
  virtualizer,
  conversationId,
  onAtBottomChange,
}: UseStickToBottomParams): UseStickToBottom {
  const [isAtBottom, setIsAtBottom] = useState(true);
  const isAtBottomRef = useRef(true);
  // True while the user's finger is down on the scroller (touch or mouse). The
  // pin must yield immediately, not after the first scroll event.
  const userDraggingRef = useRef(false);
  // The live anchor: the message at the top edge of the viewport + offset.
  // null while the user is at the bottom (the pin owns the position then).
  const anchorRef = useRef<ScrollAnchor | null>(null);
  // The session-saved anchor, captured once at mount and hunted until found.
  const restoreAnchorRef = useRef<ScrollAnchor | null>(null);
  // Bottom-settle rAF handle + its bounds.
  const pinSettleRafRef = useRef<number | null>(null);
  const pinSettleDeadlineRef = useRef(0);
  const pinSettleLastTargetRef = useRef(-1);

  // Keep the callback in a ref so a new identity never re-runs the pin effect.
  const onAtBottomChangeRef = useRef(onAtBottomChange);
  onAtBottomChangeRef.current = onAtBottomChange;

  const setAtBottom = useCallback((next: boolean) => {
    if (isAtBottomRef.current === next) return;
    isAtBottomRef.current = next;
    setIsAtBottom(next);
    if (next) onAtBottomChangeRef.current?.(true);
  }, []);

  const bottomScrollTarget = useCallback(
    (el: HTMLElement) => bottomTarget(el.scrollHeight, el.clientHeight, virtualizer.getTotalSize()),
    [virtualizer],
  );

  const cancelBottomSettle = useCallback(() => {
    if (pinSettleRafRef.current !== null) {
      cancelAnimationFrame(pinSettleRafRef.current);
      pinSettleRafRef.current = null;
    }
    pinSettleDeadlineRef.current = 0;
    pinSettleLastTargetRef.current = -1;
  }, []);

  // Keeps re-clamping to the (moving) bottom for a short bounded window while
  // the user is at the bottom. Yields immediately to a gesture and stops as
  // soon as the target stops growing.
  const settleToBottom = useCallback(() => {
    if (pinSettleRafRef.current !== null) return;
    pinSettleDeadlineRef.current = Date.now() + PIN_SETTLE_MAX_MS;
    pinSettleLastTargetRef.current = -1;
    const step = () => {
      pinSettleRafRef.current = null;
      const el = scrollerRef.current;
      if (!el || !isAtBottomRef.current || userDraggingRef.current) return;
      const target = bottomScrollTarget(el);
      if (Math.abs(el.scrollTop - target) > PIN_SETTLE_EPSILON) el.scrollTop = target;
      if (target === pinSettleLastTargetRef.current) return;
      pinSettleLastTargetRef.current = target;
      if (Date.now() < pinSettleDeadlineRef.current) {
        pinSettleRafRef.current = requestAnimationFrame(step);
      }
    };
    pinSettleRafRef.current = requestAnimationFrame(step);
  }, [bottomScrollTarget, scrollerRef]);

  const handlePointerDown = useCallback(() => {
    userDraggingRef.current = true;
    cancelBottomSettle();
  }, [cancelBottomSettle]);

  const handlePointerUp = useCallback(() => {
    userDraggingRef.current = false;
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const atBottom = isAtBottomScroll(el.scrollHeight, el.scrollTop, el.clientHeight);
    setAtBottom(atBottom);

    if (atBottom) {
      anchorRef.current = null;
      if (conversationId) clearScrollPosition(conversationId);
    } else {
      const anchor = captureAnchorFromRows(
        virtualizer.getVirtualItems(),
        el.scrollTop,
        (index) => messages[index]?.id,
      );
      anchorRef.current = anchor;
      if (conversationId && anchor) saveScrollPosition(conversationId, anchor);
    }

    // A real user scroll releases the restore anchor — programmatic corrections
    // land exactly on the target, so they never release it.
    const restore = restoreAnchorRef.current;
    if (restore) {
      const target = resolveAnchorTarget(virtualizer, messages, restore);
      if (target !== null && Math.abs(el.scrollTop - target) > 8) {
        restoreAnchorRef.current = null;
      }
    }
  }, [conversationId, messages, scrollerRef, setAtBottom, virtualizer]);

  // ── Capture the saved position on (re)mount BEFORE the pin effect below —
  // a passive effect would run after it and the anchor would never be applied
  // on the very first messages render.
  useLayoutEffect(() => {
    if (restoreAnchorRef.current === null && conversationId) {
      const saved = getScrollPosition(conversationId);
      if (saved) restoreAnchorRef.current = { ...saved };
    }
  }, [conversationId]);

  // ── Bottom pin / anchor stabilization ────────────────────────────────
  // Three mutually exclusive modes: session restore, bottom pin, anchor re-align.
  const totalSize = virtualizer.getTotalSize();
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;

    // Never fight an active gesture: writing scrollTop mid-drag or mid-momentum
    // stutters the list. virtualizer.isScrolling stays true until it settles;
    // userDraggingRef covers the window between pointerdown and the first scroll.
    if (virtualizer.isScrolling || userDraggingRef.current) return;

    const restore = restoreAnchorRef.current;
    if (restore) {
      const target = resolveAnchorTarget(virtualizer, messages, restore);
      if (target !== null) {
        if (Math.abs(el.scrollTop - target) > 2) el.scrollTop = target;
        anchorRef.current = { messageId: restore.messageId, offset: restore.offset };
        restoreAnchorRef.current = null;
        setAtBottom(false);
        return;
      }
      // The anchor is not loaded yet — history is being hunted in the
      // background; behave like a normal open until it arrives.
    }

    if (isAtBottomRef.current) {
      const target = bottomScrollTarget(el);
      if (Math.abs(el.scrollTop - target) > 1) el.scrollTop = target;
      settleToBottom();
      return;
    }

    const anchor = anchorRef.current;
    if (!anchor) return;
    const target = resolveAnchorTarget(virtualizer, messages, anchor);
    if (target === null) return;
    if (Math.abs(el.scrollTop - target) > ANCHOR_REALIGN_EPSILON) el.scrollTop = target;
    // isScrolling is a dep too: a correction skipped mid-gesture must be applied
    // the moment the gesture settles. scrollRect.height fires when a
    // keyboard-resized shell shrinks/grows the scroller.
  }, [
    totalSize,
    messages,
    virtualizer,
    virtualizer.isScrolling,
    virtualizer.scrollRect?.height,
    bottomScrollTarget,
    settleToBottom,
    scrollerRef,
    setAtBottom,
  ]);

  // Cancel any pending settle on unmount.
  useLayoutEffect(() => cancelBottomSettle, [cancelBottomSettle]);

  const scrollToBottom = useCallback(() => {
    // Explicitly returning to the bottom cancels any saved position.
    restoreAnchorRef.current = null;
    anchorRef.current = null;
    if (conversationId) clearScrollPosition(conversationId);
    const el = scrollerRef.current;
    if (el) {
      const target = bottomScrollTarget(el);
      if (typeof el.scrollTo === "function") {
        el.scrollTo({ top: target, behavior: "smooth" });
      } else {
        el.scrollTop = target;
      }
    }
    isAtBottomRef.current = true;
    setIsAtBottom(true);
    // Always clear the "N new" pill, even if we were already at the bottom.
    onAtBottomChangeRef.current?.(true);
  }, [bottomScrollTarget, conversationId, scrollerRef]);

  return {
    isAtBottom,
    isAtBottomRef,
    restoreAnchorRef,
    handleScroll,
    handlePointerDown,
    handlePointerUp,
    scrollToBottom,
  };
}
