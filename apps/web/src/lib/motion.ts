/**
 * Motion language — spring presets and spatial helpers.
 *
 * The app animates with SPRINGS, not with duration/ease curves: a spring has
 * velocity, so an interrupted animation continues from where it is instead of
 * restarting, and the tail decelerates like a physical object. `duration` is
 * only used for opacity (a fade has no physics) and as the reduced-motion
 * fallback.
 *
 * Presets are named by intent, not by number, so every surface that means the
 * same thing moves the same way:
 *
 *   snappy   — direct manipulation feedback (press, hover, toggle). Instant.
 *   standard — the default for entering/exiting content.
 *   soft     — large surfaces: panels, containers, page-level reflow.
 *   sheet    — sheets/dialogs that come from an edge and settle.
 *   pop      — small punctuation: a badge landing, an icon bouncing.
 *
 * Reduced motion is honoured per-component via `useSpring(reduce)`; when it is
 * on, every preset collapses to an instant transition and spatial offsets are
 * dropped.
 */
import type { Transition } from "framer-motion";

export const SPRING = {
  snappy: { type: "spring", stiffness: 520, damping: 38, mass: 0.9 },
  standard: { type: "spring", stiffness: 380, damping: 34, mass: 1 },
  soft: { type: "spring", stiffness: 260, damping: 30, mass: 1 },
  sheet: { type: "spring", stiffness: 300, damping: 32, mass: 0.9 },
  pop: { type: "spring", stiffness: 620, damping: 26, mass: 0.7 },
  /**
   * Shape properties — `border-radius`, `clip-path`. Fast and critically damped:
   * a shape that overshoots is not motion, it is a rendering glitch (a negative
   * radius, a mask that pops), so this preset deliberately has no bounce.
   */
  shape: { type: "spring", stiffness: 855, damping: 50, mass: 0.8 },
  /**
   * A shared-element flight — the geometry of an object travelling between two
   * boxes (avatar → photo). Stiffer than `soft` on purpose: a flight is the one
   * transition the user is actively waiting for, so it should be over quickly
   * while still carrying a spring's deceleration and interruptibility.
   */
  flight: { type: "spring", stiffness: 530, damping: 43, mass: 1 },
} as const satisfies Record<string, Transition>;

export type SpringName = keyof typeof SPRING;

/** Motion is off: apply the change now, without a curve. */
export const INSTANT: Transition = { duration: 0 };

/**
 * The transition to use for a preset given the user's reduced-motion setting
 * (`useReducedMotion()` returns `null` while unknown, treated as "allowed").
 */
export const springFor = (name: SpringName, reduce: boolean | null): Transition =>
  reduce ? INSTANT : SPRING[name];

/** A spatial slide: how far content travels along an axis when it enters. */
export const SPATIAL_OFFSET = {
  /** Tab/segment content — a hint of direction, not a slide show. */
  tab: 14,
  /** Cards and rows appearing in a stream. */
  row: 10,
  /** Full panels swapping in a two-pane layout. */
  panel: 24,
} as const;

/**
 * Direction of travel between two positions in an ordered sequence
 * (tabs, steps, pages). Equal positions count as forward.
 */
export const travelDirection = (from: number, to: number): 1 | -1 => (to >= from ? 1 : -1);

/**
 * Entering content that arrives from a direction. `false` disables the initial
 * state entirely (first paint, reduced motion) — the element then simply is
 * where it belongs.
 */
export const spatialEnter = (
  direction: 1 | -1,
  distance: number,
  reduce: boolean | null,
  animate = true,
) => ({
  initial: animate && !reduce ? { opacity: 0, x: direction * distance } : (false as const),
  animate: { opacity: 1, x: 0 },
});

/**
 * Press feedback for a tappable surface: scale in on pointer down, spring back
 * on release. Skipped under reduced motion (the change still happens).
 */
export const pressFeedback = (reduce: boolean | null, scale = 0.95) =>
  reduce ? {} : { whileTap: { scale } };

/** Hover lift — only where hover is a real pointer state. */
export const hoverLift = (reduce: boolean | null, scale = 1.03) =>
  reduce ? {} : { whileHover: { scale } };
