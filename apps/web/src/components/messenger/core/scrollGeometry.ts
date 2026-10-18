/**
 * Scroll geometry primitives shared by the messenger list and the GomoSub
 * channel chat.
 *
 * The three rules this module encodes come from Telegram Web
 * (`components/middle/helpers/messageListReserves.ts`):
 *
 *  1. **"At the bottom" is a position, not a flag.** It is re-derived from the
 *     scroller's own geometry on every pass, so a container that grew under the
 *     reader (a new message, a taller composer, a pinned banner appearing) is
 *     judged by where the reader actually is.
 *  2. **Pinning to the bottom is a sentinel write, not a computed one.**
 *     `scrollTop = 1e7` clamps to the maximum, so the reader stays glued to the
 *     newest row even if content keeps growing between the write and the next
 *     layout.
 *  3. **The saved position is measured from the bottom** (`scrollHeight -
 *     scrollTop`, Telegram's `scrollOffset`), never from the top: the list's
 *     height changes all the time (header, composer, keyboard) and a top-based
 *     offset would point at a different message after every such change.
 */

/** Slack for "the reader is at the newest message". */
export const AT_BOTTOM_THRESHOLD = 4;
/** Slack for "the reader is at the oldest mounted row". */
export const AT_TOP_THRESHOLD = 4;
/** Beyond the real maximum, so the write always clamps to the bottom. */
export const SCROLL_BOTTOM_SENTINEL = 1e7;
/** Class that turns native scroll snapping on (see `.with-bottom-snap`). */
export const BOTTOM_SNAP_CLASS = "with-bottom-snap";

/** One named `scrollTop` read, so every measurement is greppable. */
export function readContainerScrollTop(container: HTMLElement): number {
  return container.scrollTop;
}

/**
 * Telegram's `scrollOffset`: the distance from `scrollTop` to the bottom of the
 * content. Stored per conversation and used to restore the reader's place when
 * no message anchor is available.
 */
export function getBottomOffset(container: HTMLElement): number {
  return container.scrollHeight - readContainerScrollTop(container);
}

/** Pixels of unread content below the fold (0 when pinned to the bottom). */
export function getDistanceFromBottom(container: HTMLElement): number {
  return container.scrollHeight - readContainerScrollTop(container) - container.clientHeight;
}

export function isAtBottom(container: HTMLElement, threshold = AT_BOTTOM_THRESHOLD): boolean {
  return getDistanceFromBottom(container) <= threshold;
}

export function isAtTop(container: HTMLElement, threshold = AT_TOP_THRESHOLD): boolean {
  return readContainerScrollTop(container) <= threshold;
}

/** Glue the reader to the newest row, whatever the content height becomes. */
export function pinToBottom(container: HTMLElement): void {
  container.scrollTop = SCROLL_BOTTOM_SENTINEL;
}

/** Move to an absolute position, clamped by the engine. */
export function setScrollTop(container: HTMLElement, scrollTop: number): void {
  container.scrollTop = Math.max(0, Math.round(scrollTop));
}

/**
 * Offset of `element` from the top of `container`'s scroll box — the coordinate
 * `scrollTop` speaks in. Ported from Telegram Web's `getOffsetToContainer`.
 */
export function getOffsetToContainer(element: HTMLElement, container: HTMLElement): number {
  let offsetTop = 0;
  let current: HTMLElement | null = element;

  while (current && current !== container && !current.contains(container)) {
    offsetTop += current.offsetTop;
    current = current.offsetParent as HTMLElement | null;
  }

  return offsetTop - container.clientTop;
}
