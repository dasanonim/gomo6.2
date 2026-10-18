import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeRow, makeScroller } from "@/test/fakeScroll";
import { FRAME_MS, installManualRaf, type ManualRaf } from "@/test/manualRaf";
import {
  SCROLL_MAX_DISTANCE,
  SCROLL_MIN_DURATION,
  __resetAnimateScrollForTests,
  animateScroll,
  cancelScrollAnimation,
  isAnimatingScroll,
  restartCurrentScrollAnimation,
} from "./animateScroll";

describe("animateScroll", () => {
  let raf: ManualRaf;

  beforeEach(() => {
    vi.useFakeTimers();
    raf = installManualRaf();
    __resetAnimateScrollForTests();
  });

  afterEach(() => {
    __resetAnimateScrollForTests();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("aligns an element to the end of the viewport", () => {
    const scroller = makeScroller(2000, 600);
    const row = makeRow(scroller.el, { offsetTop: 1000, offsetHeight: 60 });

    animateScroll({ container: scroller.el, element: row, position: "end", forceDuration: 0 });

    // The row bottom (1060) sits exactly on the viewport bottom (scrollTop 460).
    expect(scroller.scrollTop).toBe(460);
  });

  it("aligns an element to the top of the viewport", () => {
    const scroller = makeScroller(2000, 600);
    const row = makeRow(scroller.el, { offsetTop: 1000 });
    scroller.setScrollTop(1400);

    animateScroll({ container: scroller.el, element: row, position: "start", forceDuration: 0 });

    expect(scroller.scrollTop).toBe(1000);
  });

  it("centres an element between the reserves", () => {
    const scroller = makeScroller(2000, 600);
    const row = makeRow(scroller.el, { offsetTop: 1000, offsetHeight: 60 });

    animateScroll({
      container: scroller.el,
      element: row,
      position: "center",
      topReserve: 100,
      bottomReserve: 100,
      forceDuration: 0,
    });

    // Visible band is 100..500 (400 tall); a 60px row centres at 100+170.
    expect(scroller.scrollTop).toBe(1000 + 30 - 100 - 200);
  });

  it("jumps into place with a zero duration", () => {
    const scroller = makeScroller(2000, 600);
    animateScroll({ container: scroller.el, scrollTo: 400, forceDuration: 0 });

    expect(scroller.scrollTop).toBe(400);
    expect(isAnimatingScroll(scroller.el)).toBe(false);
  });

  it("cuts to within the glide distance, then animates only the last stretch", async () => {
    const scroller = makeScroller(4000, 600);
    const row = makeRow(scroller.el, { offsetTop: 3000, offsetHeight: 60 });
    scroller.setScrollTop(600);
    const target = 3000 + 60 - 600;

    animateScroll({ container: scroller.el, element: row, position: "end" });
    await raf.frame(FRAME_MS);
    const firstFrame = scroller.scrollTop;

    // The distance the reader cannot see is covered at once (a 1860px glide
    // would read as a hang); only the last `SCROLL_MAX_DISTANCE` animates.
    expect(firstFrame).toBeGreaterThan(600);
    expect(firstFrame).toBeGreaterThanOrEqual(target - SCROLL_MAX_DISTANCE - 1);
    expect(firstFrame).toBeLessThanOrEqual(target);

    await raf.advanceFrames(SCROLL_MIN_DURATION + 1200);

    expect(scroller.scrollTop).toBe(target);
  });

  it("never animates past the real edges of the content", async () => {
    const scroller = makeScroller(2000, 600);
    animateScroll({ container: scroller.el, scrollTo: 99999 });
    await raf.advanceFrames(SCROLL_MIN_DURATION + 1200);

    expect(scroller.scrollTop).toBe(1400);
    expect(isAnimatingScroll(scroller.el)).toBe(false);
  });

  it("reports the animation while it runs and stops when it lands", async () => {
    const scroller = makeScroller(2000, 600);
    animateScroll({ container: scroller.el, scrollTo: 400, forceDuration: 200 });

    expect(isAnimatingScroll(scroller.el)).toBe(true);
    await raf.advanceFrames(FRAME_MS * 4);
    expect(isAnimatingScroll(scroller.el)).toBe(true);
    expect(scroller.scrollTop).toBeGreaterThan(0);
    expect(scroller.scrollTop).toBeLessThan(400);

    await raf.advanceFrames(400);
    expect(isAnimatingScroll(scroller.el)).toBe(false);
    expect(scroller.scrollTop).toBe(400);
  });

  it("holds native scroll snapping off while gliding and restores it after", async () => {
    const scroller = makeScroller(2000, 600);
    scroller.el.style.scrollSnapType = "y proximity";

    animateScroll({ container: scroller.el, scrollTo: 400, forceDuration: 200 });
    expect(scroller.el.style.scrollSnapType).toBe("none");

    await raf.advanceFrames(400);
    expect(scroller.el.style.scrollSnapType).toBe("y proximity");
    expect(scroller.el.dataset.scrollSnapHeld).toBeUndefined();
  });

  it("hands the scroller back when the reader cancels the glide", async () => {
    const scroller = makeScroller(2000, 600);
    animateScroll({ container: scroller.el, scrollTo: 400, forceDuration: 400 });
    await raf.advanceFrames(FRAME_MS * 5);
    const interrupted = scroller.scrollTop;
    expect(interrupted).toBeGreaterThan(0);

    cancelScrollAnimation(scroller.el);
    await raf.advanceFrames(FRAME_MS * 30);

    expect(isAnimatingScroll(scroller.el)).toBe(false);
    expect(scroller.scrollTop).toBe(interrupted);
    expect(scroller.el.style.scrollSnapType).toBe("");
  });

  it("retargets a running glide when the content moved under it", async () => {
    const scroller = makeScroller(4000, 600);
    const row = makeRow(scroller.el, { offsetTop: 1000, offsetHeight: 60 });
    scroller.setScrollTop(600);

    const mutate = animateScroll({
      container: scroller.el,
      element: row,
      position: "end",
      forceDuration: 400,
      shouldReturnMutationFn: true,
    });
    mutate?.();
    await raf.advanceFrames(FRAME_MS * 4);

    // The row grew / moved while the glide was in flight (an image resolved, a
    // page was mounted above). A commit retargets the glide instead of fighting
    // it for the position.
    Object.defineProperty(row, "offsetTop", { get: () => 1400, configurable: true });
    restartCurrentScrollAnimation(scroller.el);
    await raf.advanceFrames(600);

    expect(scroller.scrollTop).toBe(1400 + 60 - 600);
    expect(isAnimatingScroll(scroller.el)).toBe(false);
  });

  it("does nothing when told to hand back the write", async () => {
    const scroller = makeScroller(2000, 600);
    const mutate = animateScroll({
      container: scroller.el,
      scrollTo: 400,
      forceDuration: 200,
      shouldReturnMutationFn: true,
    });

    expect(scroller.scrollTop).toBe(0);
    expect(isAnimatingScroll(scroller.el)).toBe(false);

    mutate?.();
    expect(isAnimatingScroll(scroller.el)).toBe(true);
    await raf.advanceFrames(400);
    expect(scroller.scrollTop).toBe(400);
  });
});

describe("animateScroll — positions and direction", () => {
  let raf: ManualRaf;

  beforeEach(() => {
    vi.useFakeTimers();
    raf = installManualRaf();
    __resetAnimateScrollForTests();
  });

  afterEach(() => {
    __resetAnimateScrollForTests();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("centre-or-top centres a message that fits the visible band", () => {
    const scroller = makeScroller(2000, 600);
    const row = makeRow(scroller.el, { offsetTop: 1000, offsetHeight: 60 });

    animateScroll({ container: scroller.el, element: row, position: "centerOrTop", forceDuration: 0 });

    expect(scroller.scrollTop).toBe(1000 + 30 - 300);
  });

  it("centre-or-top aligns a message taller than the band to the top", () => {
    const scroller = makeScroller(4000, 600);
    const tall = makeRow(scroller.el, { offsetTop: 1000, offsetHeight: 900 });
    scroller.setScrollTop(2000);

    animateScroll({
      container: scroller.el,
      element: tall,
      position: "centerOrTop",
      margin: 20,
      forceDuration: 0,
    });

    expect(scroller.scrollTop).toBe(1000 - 20);
  });

  it("anchors a down-glide to the target, whatever the current position", async () => {
    const scroller = makeScroller(6000, 600);
    const target = makeRow(scroller.el, { offsetTop: 4000, offsetHeight: 0 });
    scroller.setScrollTop(0);

    animateScroll({
      container: scroller.el,
      element: target,
      position: "end",
      maxDistance: 500,
      forceDirection: "down",
      forceDuration: 400,
    });

    // The glide begins at most 500px above the target — the rest is covered at
    // once (Telegram Web's scroll-to-bottom button).
    await raf.frame(FRAME_MS);
    const firstFrame = scroller.scrollTop;
    expect(firstFrame).toBeGreaterThanOrEqual(4000 + 0 - 600 - 500 - 1);

    await raf.advanceFrames(400);
    expect(scroller.scrollTop).toBe(4000 + 0 - 600);
  });
});
