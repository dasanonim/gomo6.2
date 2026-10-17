/**
 * Window arithmetic for the messenger's native DOM slicing list.
 *
 * The scroll container holds a plain, normal-flow DOM list and the browser's
 * own compositor thread owns the scroll position — no spacers, no absolute
 * rows, no transforms. The only thing this module owns is *which slice* of the
 * loaded history is mounted: a bounded window of ~150–300 rows that slides
 * bi-directionally as the reader moves.
 *
 * The window is expressed in message KEYS, never in array indices:
 *
 *  - `first` — the canonical key (`client_id || id`) of the oldest mounted row.
 *    `null` means "the tail window" (the newest {@link INITIAL_WINDOW} rows).
 *  - `last`  — the key of the newest mounted row. `null` means "follow the
 *    store tail": every newly appended message is mounted as it arrives.
 *
 * Keys survive a prepend (the store inserts an older page above the whole
 * array), an optimistic → server swap and an index shift, so the reader's
 * window never re-anchors to a different message. Indices do not: they move by
 * exactly the size of the inserted page.
 *
 * Everything here is pure so the sliding/GC decisions can be unit-tested
 * without a layout engine.
 */

import { messageKey, type MessageIdentity } from "./messageModel";

/** Half-open `[start, end)` range into the loaded message array. */
export interface MessageSlice {
  start: number;
  end: number;
}

/** Key-based description of the mounted window (see the module docblock). */
export interface KeyWindow {
  first: string | null;
  last: string | null;
}

/** The newest slice: `last: null` keeps following the store tail. */
export const TAIL_WINDOW: KeyWindow = { first: null, last: null };

/**
 * Hard ceiling of mounted rows. Native `content-visibility` makes off-screen
 * rows cheap, so this only bounds the React reconciliation + DOM memory cost of
 * a very deep window.
 */
export const MAX_DOM_MESSAGES = 300;
/** Rows mounted on open (and whenever the reader returns to the bottom). */
export const INITIAL_WINDOW = 150;
/** A jump to the bottom re-seeds the window to the newest N rows. */
export const RESET_WINDOW = 50;
/** Rows added per bi-directional expansion step. */
export const WINDOW_STEP = 50;
/** Rows removed beyond the ceiling, so GC does not run on every arrival. */
export const PRUNE_BATCH = 50;
/** Rows mounted above a `scrollToMessage` target. */
export const ANCHOR_BEFORE = 20;
/** Rows mounted below it — enough that the target can be centred. */
export const ANCHOR_AFTER = INITIAL_WINDOW - ANCHOR_BEFORE;

/** The newest `size` messages, clamped to the array. */
export function tailSlice(length: number, size = INITIAL_WINDOW): MessageSlice {
  const end = Math.max(0, length);
  return { start: Math.max(0, end - size), end };
}

/**
 * The tail window expressed in keys: the newest `size` rows, still following
 * the store tail (`last: null`). Used on open, on a jump to the bottom and
 * whenever the reader returns to the newest message.
 */
export function tailKeyWindow<T extends MessageIdentity>(
  messages: readonly T[],
  size = INITIAL_WINDOW,
): KeyWindow {
  const slice = tailSlice(messages.length, size);
  const first = messages[slice.start];
  return { first: first ? messageKey(first) : null, last: null };
}

/** A window that mounts `index` with `before` rows above and `after` below. */
export function aroundSlice(
  index: number,
  length: number,
  before = ANCHOR_BEFORE,
  after = ANCHOR_AFTER,
): MessageSlice {
  if (length <= 0) return { start: 0, end: 0 };
  const clamped = Math.max(0, Math.min(index, length - 1));
  const end = Math.max(1, Math.min(length, clamped + after));
  const start = Math.max(0, Math.min(clamped - before, end - 1));
  return { start, end };
}

/** Clamp a slice to `[0, length]`, keeping it at most `MAX_DOM_MESSAGES` wide. */
export function clampSlice(slice: MessageSlice, length: number): MessageSlice {
  const max = Math.max(0, length);
  const start = Math.max(0, Math.min(slice.start, max));
  let end = Math.max(start, Math.min(slice.end, max));
  if (end - start > MAX_DOM_MESSAGES) end = start + MAX_DOM_MESSAGES;
  return { start, end };
}

/** Number of mounted rows in a slice. */
export function sliceSize(slice: MessageSlice): number {
  return Math.max(0, slice.end - slice.start);
}

/** O(n) index of canonical message keys, used to resolve a {@link KeyWindow}. */
export function buildKeyIndex<T extends MessageIdentity>(messages: readonly T[]): Map<string, number> {
  const index = new Map<string, number>();
  for (let i = 0; i < messages.length; i += 1) index.set(messageKey(messages[i]), i);
  return index;
}

export function sameKeyWindow(a: KeyWindow, b: KeyWindow): boolean {
  return a.first === b.first && a.last === b.last;
}

/**
 * Resolve a key window against the current message array.
 *
 *  - `first: null` → the tail window.
 *  - `last: null` → mount through the newest loaded message.
 *  - `null` result → the window refers to messages that are no longer in the
 *    array (a full reload / a notes filter change); the caller re-seeds it.
 */
export function resolveKeyWindow(
  window: KeyWindow,
  indexByKey: ReadonlyMap<string, number>,
  length: number,
): MessageSlice | null {
  if (length <= 0) return { start: 0, end: 0 };
  if (window.first === null) return tailSlice(length);

  const start = indexByKey.get(window.first);
  if (start === undefined) return null;

  let end: number;
  if (window.last === null) {
    end = length;
  } else {
    const last = indexByKey.get(window.last);
    if (last === undefined) return null;
    end = last + 1;
  }
  if (end <= start) return null;
  return { start, end };
}

/**
 * Bottom GC for a window that has grown past the ceiling while the reader is
 * looking at history: rows BELOW the viewport are dropped, which cannot move
 * anything the reader can see. Returns the slice's new end plus the key the
 * window must now end on, or `null` when no trim is needed.
 */
export function trimBottom<T>(
  messages: readonly T[],
  start: number,
  end: number,
  keyOf: (message: T) => string,
): { end: number; last: string } | null {
  if (end - start <= MAX_DOM_MESSAGES) return null;
  const nextEnd = Math.min(end, start + MAX_DOM_MESSAGES);
  const node = messages[nextEnd - 1];
  if (!node) return null;
  return { end: nextEnd, last: keyOf(node) };
}
