/**
 * Pure scroll math for the message list.
 *
 * Extracted from MessageList so the geometry can be reasoned about and unit
 * tested without a DOM or a virtualizer. Everything here is a pure function of
 * numbers (and virtual rows); the React glue stays in the component.
 *
 * Layout constants live here too and are the single source of truth — the css
 * values they mirror are noted inline.
 */

/** `.msg-history-header` — fixed in every state (messenger.css). */
export const HISTORY_HEADER_HEIGHT = 34;
/** `.message-list-footer` — the gap under the last message (messenger.css). */
export const BOTTOM_GAP_HEIGHT = 12;
/** Distance from the real bottom that still counts as "at the bottom". */
export const AT_BOTTOM_SLACK = 12;
/** px of anchor drift considered "already aligned". */
export const ANCHOR_REALIGN_EPSILON = 2;

/** The minimal virtual-row shape (a `@tanstack/react-virtual` item satisfies it). */
export interface VirtualRow {
  index: number;
  start: number;
  end: number;
}

/** The anchor for a scroll position: the top-most visible message and how far
 *  its top has been scrolled past the viewport top (positive = above). */
export interface ScrollAnchor {
  messageId: string;
  /** Pixels between the top of the anchor message and the viewport top. */
  offset: number;
}

/** The full virtual content height the spacer must reserve. */
export function virtualContentHeight(virtualTotal: number): number {
  return HISTORY_HEADER_HEIGHT + virtualTotal + BOTTOM_GAP_HEIGHT;
}

/**
 * The scrollTop that pins the view to the real bottom, or 0 when the viewport
 * has no height yet (not laid out — writing scrollTop then is meaningless).
 *
 * Two sources of truth, whichever is larger: the laid-out DOM (`scrollHeight`
 * — catches an image growing past its reserved box) and the virtualizer's own
 * content height (catches a `measureElement` correction that has not reached
 * the DOM yet). Reading only one of them used to leave a small un-scrolled gap
 * at the bottom (issue #508).
 */
export function bottomTarget(
  scrollHeight: number,
  clientHeight: number,
  virtualTotal: number,
): number {
  if (clientHeight <= 0) return 0;
  return Math.max(0, Math.max(scrollHeight, virtualContentHeight(virtualTotal)) - clientHeight);
}

/** Whether the current scroll position is within {@link AT_BOTTOM_SLACK} of the bottom. */
export function isAtBottom(scrollHeight: number, scrollTop: number, clientHeight: number): boolean {
  return scrollHeight - scrollTop - clientHeight <= AT_BOTTOM_SLACK;
}

/**
 * The top-most visible message and how far its top is above the viewport top.
 * Derived from the virtualizer's measured/estimated offsets, not DOM rects —
 * exact for both rendered and not-yet-rendered items.
 */
export function captureAnchor(
  rows: readonly VirtualRow[],
  scrollTop: number,
  messageIdAt: (index: number) => string | undefined,
): ScrollAnchor | null {
  for (const row of rows) {
    const itemTop = HISTORY_HEADER_HEIGHT + row.start;
    const itemBottom = HISTORY_HEADER_HEIGHT + row.end;
    // Rows above the viewport are skipped; the first row whose bottom is at or
    // below the top edge is the top-most visible one.
    if (itemBottom <= scrollTop) continue;
    const messageId = messageIdAt(row.index);
    if (!messageId) continue;
    return { messageId, offset: scrollTop - itemTop };
  }
  return null;
}

/** The scrollTop that places an anchor back where it was captured. */
export function anchorScrollTop(rowStart: number, offset: number): number {
  return HISTORY_HEADER_HEIGHT + rowStart + offset;
}
