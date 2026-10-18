/**
 * Animated programmatic scrolling.
 *
 * Ported from Telegram Web (`telegram-tt/src/util/animateScroll.ts`). Two ideas
 * are worth naming, because both are load-bearing:
 *
 *  - **The glide is bounded.** A jump across thousands of pixels is not animated
 *    over the whole distance; the animation starts at most `maxDistance` (800px)
 *    away from the current position and covers the rest instantly. Animating a
 *    10 000px scroll reads as a hang, not as smoothness.
 *  - **The scroller is marked while it animates.** `isAnimatingScroll()` lets the
 *    rest of the list ignore the scroll events this loop produces (they are not
 *    the reader scrolling) and lets the received-message logic retarget an
 *    in-flight glide instead of fighting it.
 *
 * CSS `scroll-behavior: smooth` is deliberately never used: it cannot be
 * retargeted, cannot be cancelled, and cannot tell the list that a programmatic
 * scroll is in progress.
 */

import { getOffsetToContainer, readContainerScrollTop } from "./scrollGeometry";

export type ScrollPosition = "start" | "end" | "center";

export interface AnimateScrollArgs {
  container: HTMLElement;
  /** Target element. Required unless `scrollTo` is given. */
  element?: HTMLElement | null;
  /** Absolute target `scrollTop`, bypassing `element`/`position`. */
  scrollTo?: number;
  /** Where the element should end up. Defaults to `end`. */
  position?: ScrollPosition;
  /** Gap to leave between the element and the viewport edge. */
  margin?: number;
  /** Chrome that covers the top / bottom of the scroller (used by `center`). */
  topReserve?: number;
  bottomReserve?: number;
  /** How far from the current position the glide may start. */
  maxDistance?: number;
  /** 0 = jump into place with no animation. */
  forceDuration?: number;
  /**
   * Return the write function instead of running it in the next mutation pass,
   * so the caller can run it inside its own forced reflow.
   */
  shouldReturnMutationFn?: boolean;
}

export const SCROLL_MIN_DURATION = 300;
export const SCROLL_MAX_DURATION = 600;
export const SCROLL_MAX_DISTANCE = 800;
/** Short hops use a slightly sharper easing than long ones. */
export const SCROLL_SHORT_TRANSITION_MAX_DISTANCE = 300;

type Animation = {
  frame: number;
  cancel: () => void;
};

const animations = new Map<HTMLElement, Animation>();
/** The args of the last glide per container, so a glide can be retargeted. */
const retargetable = new Map<HTMLElement, AnimateScrollArgs>();

let prefersReducedMotion: boolean | null = null;

function shouldReduceMotion(): boolean {
  if (prefersReducedMotion === null) {
    prefersReducedMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }
  return prefersReducedMotion;
}

export function isAnimatingScroll(container?: HTMLElement): boolean {
  if (!container) return animations.size > 0;
  return animations.has(container);
}

/** Stop the glide and hand the scroller back to the reader. */
export function cancelScrollAnimation(container?: HTMLElement): void {
  if (!container) {
    for (const key of [...animations.keys()]) cancelScrollAnimation(key);
    return;
  }
  const animation = animations.get(container);
  if (!animation) return;
  cancelAnimationFrame(animation.frame);
  animations.delete(container);
  releaseSnap(container);
}

/**
 * Re-target the running glide after the DOM changed under it (a message grew, a
 * page was mounted): the animation is restarted from the *current* geometry so
 * it still lands where it was aiming.
 */
export function restartCurrentScrollAnimation(container: HTMLElement): void {
  const pending = retargetable.get(container);
  if (!pending || !animations.has(container)) return;
  animateScroll({ ...pending, container });
}

export function animateScroll(args: AnimateScrollArgs): (() => void) | undefined {
  const mutate = createMutationFn(args);

  if (args.shouldReturnMutationFn) return mutate;

  // A new target supersedes the previous glide on the same scroller.
  cancelScrollAnimation(args.container);
  retargetable.set(args.container, args);
  mutate();
  return undefined;
}

function createMutationFn(args: AnimateScrollArgs): () => void {
  const {
    container,
    element,
    scrollTo: forcedTarget,
    position = "end",
    margin = 0,
    topReserve = 0,
    bottomReserve = 0,
    maxDistance = SCROLL_MAX_DISTANCE,
  } = args;

  let forceDuration = args.forceDuration;
  if (shouldReduceMotion()) forceDuration = 0;

  const containerHeight = container.clientHeight;

  let target = forcedTarget;
  if (target === undefined) {
    if (!element) return () => undefined;
    const elementTop = getOffsetToContainer(element, container);
    const elementHeight = element.offsetHeight;

    switch (position) {
      case "start":
        target = elementTop - margin;
        break;
      case "center": {
        const visibleHeight = Math.max(0, containerHeight - topReserve - bottomReserve);
        target =
          elementHeight < visibleHeight
            ? elementTop + elementHeight / 2 - topReserve - visibleHeight / 2
            : elementTop - margin;
        break;
      }
      case "end":
      default:
        target = elementTop + elementHeight + margin - containerHeight;
        break;
    }
  }

  const from = clampStart(container, target, maxDistance);
  let path = target - from;

  // Never animate into the rubber-band: the glide stops at the real edges.
  if (path < 0) {
    path = Math.max(path, -from);
  } else if (path > 0) {
    const remaining = container.scrollHeight - (from + containerHeight);
    path = Math.min(path, remaining);
  }

  const absPath = Math.abs(path);

  return () => {
    if (absPath < 1) {
      // Already there: land exactly (a sub-pixel drift is still a jump).
      if (container.scrollTop !== from) container.scrollTop = from;
      return;
    }

    const to = from + path;

    if (forceDuration === 0) {
      container.scrollTop = to;
      return;
    }

    const transition = absPath <= SCROLL_SHORT_TRANSITION_MAX_DISTANCE ? shortTransition : longTransition;
    const duration =
      forceDuration ??
      SCROLL_MIN_DURATION +
        (absPath / SCROLL_MAX_DISTANCE) * (SCROLL_MAX_DURATION - SCROLL_MIN_DURATION);

    cancelScrollAnimation(container);
    holdSnap(container);

    const startAt = Date.now();
    const animation: Animation = {
      frame: 0,
      cancel: () => undefined,
    };

    const step = () => {
      if (animations.get(container) !== animation) return;

      const t = Math.min((Date.now() - startAt) / duration, 1);
      const remaining = path * (1 - transition(t));
      const next = Math.round(to - remaining);

      animation.frame = requestAnimationFrame(step);

      // A write is skipped only when it would not move anything (avoids a
      // needless scroll event every frame at the very end).
      if (container.scrollTop !== next) container.scrollTop = next;

      const done = t >= 1 || container.scrollTop === to;
      if (done) {
        animations.delete(container);
        releaseSnap(container);
        retargetable.delete(container);
      }
    };

    animation.frame = requestAnimationFrame(step);
    animations.set(container, animation);
  };
}

/**
 * While a glide runs, native scroll snapping must be off: the two would fight
 * for the final position. Restored through the inline style so the class-based
 * snap (`.with-bottom-snap`) is untouched.
 */
function holdSnap(container: HTMLElement): void {
  container.dataset.scrollSnapHeld = container.style.scrollSnapType || "";
  container.style.scrollSnapType = "none";
}

function releaseSnap(container: HTMLElement): void {
  const held = container.dataset.scrollSnapHeld;
  if (held === undefined) return;
  delete container.dataset.scrollSnapHeld;
  container.style.scrollSnapType = held;
}

/** Where the glide starts: capped to `maxDistance` away from the target. */
function clampStart(container: HTMLElement, target: number, maxDistance: number): number {
  const scrollTop = readContainerScrollTop(container);
  const offset = target - scrollTop;

  if (offset < -maxDistance) return scrollTop + (offset + maxDistance);
  if (offset > maxDistance) return scrollTop + (offset - maxDistance);
  return scrollTop;
}

function shortTransition(t: number): number {
  return 1 - (1 - t) ** 3.5;
}

function longTransition(t: number): number {
  return 1 - (1 - t) ** 6;
}

/** Test-only: cancel every glide and forget the remembered targets. */
export function __resetAnimateScrollForTests(): void {
  for (const container of [...animations.keys()]) cancelScrollAnimation(container);
  retargetable.clear();
  prefersReducedMotion = null;
}
