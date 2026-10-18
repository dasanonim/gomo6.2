import { describe, expect, it } from "vitest";
import { makeRow, makeScroller } from "@/test/fakeScroll";
import {
  AT_BOTTOM_THRESHOLD,
  SCROLL_BOTTOM_SENTINEL,
  getBottomOffset,
  getDistanceFromBottom,
  getOffsetToContainer,
  isAtBottom,
  isAtTop,
  pinToBottom,
  readContainerScrollTop,
  setScrollTop,
} from "./scrollGeometry";

describe("scrollGeometry", () => {
  it("measures the saved position from the bottom, not the top", () => {
    const scroller = makeScroller(2000, 600);
    scroller.setScrollTop(400);

    // A taller container (composer grown by 100px) keeps the same offset.
    expect(getBottomOffset(scroller.el)).toBe(1600);
    scroller.setViewportHeight(700);
    expect(getBottomOffset(scroller.el)).toBe(1600);
  });

  it("reports the distance to the bottom and treats slack as the bottom", () => {
    const scroller = makeScroller(2000, 600);
    scroller.setScrollTop(1400);
    expect(getDistanceFromBottom(scroller.el)).toBe(0);
    expect(isAtBottom(scroller.el)).toBe(true);

    scroller.setScrollTop(1400 - AT_BOTTOM_THRESHOLD - 1);
    expect(isAtBottom(scroller.el)).toBe(false);
  });

  it("pins with a sentinel write, so growth cannot unstick the reader", () => {
    const scroller = makeScroller(2000, 600);
    pinToBottom(scroller.el);
    expect(readContainerScrollTop(scroller.el)).toBe(1400);

    // Content grew between the write and the next layout: the sentinel clamps.
    scroller.setContentHeight(3000);
    expect(scroller.el.scrollTop).toBe(1400);

    pinToBottom(scroller.el);
    expect(readContainerScrollTop(scroller.el)).toBe(2400);
    expect(SCROLL_BOTTOM_SENTINEL).toBeGreaterThan(2400);
  });

  it("never scrolls above the content or below the fold", () => {
    const scroller = makeScroller(2000, 600);
    setScrollTop(scroller.el, -50);
    expect(readContainerScrollTop(scroller.el)).toBe(0);
    setScrollTop(scroller.el, 99999);
    expect(readContainerScrollTop(scroller.el)).toBe(1400);
    setScrollTop(scroller.el, 100.4);
    expect(readContainerScrollTop(scroller.el)).toBe(100);
  });

  it("detects the top of the mounted window", () => {
    const scroller = makeScroller(2000, 600);
    expect(isAtTop(scroller.el)).toBe(true);
    scroller.setScrollTop(50);
    expect(isAtTop(scroller.el)).toBe(false);
  });

  it("resolves an element offset in the scroller's own coordinates", () => {
    const scroller = makeScroller(2000, 600);
    const wrapper = document.createElement("div");
    scroller.el.appendChild(wrapper);
    // A row nested one level down: both offsets accumulate.
    const nested = document.createElement("div");
    wrapper.appendChild(nested);
    Object.defineProperty(wrapper, "offsetTop", { get: () => 120, configurable: true });
    Object.defineProperty(wrapper, "offsetParent", { get: () => scroller.el, configurable: true });
    Object.defineProperty(nested, "offsetTop", { get: () => 40, configurable: true });
    Object.defineProperty(nested, "offsetParent", { get: () => wrapper, configurable: true });

    expect(getOffsetToContainer(nested, scroller.el)).toBe(160);
  });

  it("treats an element that is the container as offset zero", () => {
    const scroller = makeScroller(2000, 600);
    expect(getOffsetToContainer(scroller.el, scroller.el)).toBe(0);
  });

  it("resolves a direct child row against its own offset parent", () => {
    const scroller = makeScroller(2000, 600);
    const row = makeRow(scroller.el, { offsetTop: 900, offsetHeight: 60 });
    expect(getOffsetToContainer(row, scroller.el)).toBe(900);
  });
});
