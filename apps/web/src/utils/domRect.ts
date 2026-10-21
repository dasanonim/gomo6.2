/** Viewport box of an element, or null when it is not laid out (yet). */
export interface ViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * `getBoundingClientRect()` → a plain, comparable box. Returns null for an
 * element that has no area yet (unmounted, hidden, or an <img> still without an
 * intrinsic size) — motion code must treat that as "not ready", never as
 * "zero-sized box", or it animates to a point at the top-left of the screen.
 */
export const toViewportRect = (rect: DOMRect | null | undefined): ViewportRect | null =>
  rect && rect.width > 1 && rect.height > 1
    ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    : null;
