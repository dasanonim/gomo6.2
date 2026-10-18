/**
 * A synthetic layout for scroll tests.
 *
 * jsdom performs no layout: every `offsetTop`, `scrollHeight` and `clientHeight`
 * is 0, and `scrollTop` is a write-only property. The scroll engine is *all*
 * about those numbers, so tests build a tiny deterministic layout instead —
 * the same technique the pre-existing `MessageList.test.tsx` uses.
 *
 * The fake scroller clamps `scrollTop` the way a browser does, which is what
 * makes the "pin with a sentinel" contract (`scrollTop = 1e7` lands at the
 * bottom) testable at all.
 */

export interface FakeScroller {
  el: HTMLElement;
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  setScrollTop(value: number): void;
  setContentHeight(value: number): void;
  setViewportHeight(value: number): void;
}

export function makeScroller(contentHeight: number, viewportHeight: number): FakeScroller {
  const el = document.createElement("div");
  let scrollTop = 0;
  let scrollHeight = contentHeight;
  let clientHeight = viewportHeight;

  Object.defineProperty(el, "scrollHeight", { get: () => scrollHeight, configurable: true });
  Object.defineProperty(el, "clientHeight", { get: () => clientHeight, configurable: true });
  Object.defineProperty(el, "offsetHeight", { get: () => clientHeight, configurable: true });
  Object.defineProperty(el, "clientTop", { get: () => 0, configurable: true });
  Object.defineProperty(el, "scrollTop", {
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = Math.max(0, Math.min(value, Math.max(0, scrollHeight - clientHeight)));
    },
    configurable: true,
  });

  return {
    el,
    get scrollTop() {
      return scrollTop;
    },
    get scrollHeight() {
      return scrollHeight;
    },
    get clientHeight() {
      return clientHeight;
    },
    setScrollTop(value: number) {
      el.scrollTop = value;
    },
    setContentHeight(value: number) {
      scrollHeight = value;
    },
    setViewportHeight(value: number) {
      clientHeight = value;
    },
  };
}

/** A row inside `container`: an offset box with an offset parent. */
export function makeRow(
  container: HTMLElement,
  {
    offsetTop,
    offsetHeight = 60,
    offsetParent,
  }: { offsetTop: number; offsetHeight?: number; offsetParent?: HTMLElement | null },
): HTMLElement {
  const row = document.createElement("div");
  container.appendChild(row);
  Object.defineProperty(row, "offsetTop", { get: () => offsetTop, configurable: true });
  Object.defineProperty(row, "offsetHeight", { get: () => offsetHeight, configurable: true });
  Object.defineProperty(row, "offsetParent", {
    get: () => (offsetParent === undefined ? container : offsetParent),
    configurable: true,
  });
  return row;
}
