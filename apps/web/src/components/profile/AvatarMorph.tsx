import { motion, useReducedMotion } from "motion/react";
import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { SPRING, springFor } from "@/lib/motion";
import { toViewportRect, type ViewportRect } from "@/utils/domRect";

/**
 * One image, flying between two boxes — the avatar → full-screen-photo morph.
 *
 * Deliberately NOT a View Transition: the browser can only cross-fade two
 * snapshots, which dissolves a circle into a square instead of growing a window
 * (and clipping a snapshot to morph the radius breaks the rest of the incoming
 * page). Here a single real <img> is interpolated by framer — the same pixels
 * the whole way — so nothing is ever handed over mid-flight.
 *
 * Three separate motions, on purpose:
 *   geometry (position + scale) — the flight itself, a spring;
 *   shape (`border-radius`)     — `shape`, critically damped, no overshoot;
 *   handover (opacity)          — a short fade ONCE the flight has landed, so the
 *                                 gallery's own copy of the photo and its chrome
 *                                 can take over without a visible cut.
 *
 * Geometry is scale-based: the element is laid out at its END size and the start
 * is a translate + scale. Animating width/height would reflow the page per frame.
 */

/** The gallery photo the morph lands on (or leaves from). */
const TARGET_SELECTOR = ".msg-lightbox-slide[data-active] .msg-lightbox-media";

/** How long the clone takes to dissolve once the real photo is under it, in ms. */
const FADE_MS = 140;

export interface AvatarMorphProps {
  src: string;
  /** "open" grows the avatar into the photo; "close" shrinks it back. */
  direction: "open" | "close";
  /** Where the image is now (the avatar when opening, the photo when closing). */
  from: ViewportRect;
  /** Where it goes. Omitted when opening: the gallery photo is measured once it
      is on screen (it mounts a frame after the click). */
  to?: ViewportRect | null;
  /**
   * The flight has landed — the caller may show the real photo and the viewer
   * chrome now. The clone is still on screen (it fades itself out right after),
   * so the two are never visible at different sizes.
   */
  onLanded: () => void;
  /** The clone is gone; the caller can drop it from state. */
  onDone: () => void;
}

export function AvatarMorph({ src, direction, from, to, onLanded, onDone }: AvatarMorphProps) {
  const reduce = useReducedMotion();
  const [target, setTarget] = useState<ViewportRect | null>(to ?? null);
  const [landed, setLanded] = useState(false);
  const landedRef = useRef(onLanded);
  const doneRef = useRef(onDone);
  const fadeTimerRef = useRef<number | null>(null);
  landedRef.current = onLanded;
  doneRef.current = onDone;

  // Reduced motion: no flight at all — the caller's state change is the whole
  // transition, which is what the preference asks for.
  useEffect(() => {
    if (reduce) doneRef.current();
  }, [reduce]);

  // A pending handover must not fire into an unmounted component.
  useEffect(() => () => {
    if (fadeTimerRef.current !== null) window.clearTimeout(fadeTimerRef.current);
  }, []);

  // Measure the destination when the caller could not (the gallery is still
  // mounting). Bounded: a morph that never lands must not leave the clone stuck.
  useLayoutEffect(() => {
    if (to) {
      setTarget(to);
      return;
    }
    let raf = 0;
    let tries = 0;
    const measure = () => {
      const rect = toViewportRect(document.querySelector(TARGET_SELECTOR)?.getBoundingClientRect());
      if (rect) {
        setTarget(rect);
        return;
      }
      if (tries++ > 40) {
        doneRef.current();
        return;
      }
      raf = requestAnimationFrame(measure);
    };
    raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
  }, [to]);

  const opening = direction === "open";

  const handleFlightComplete = () => {
    // Let the gallery show its own photo + chrome while the clone is still
    // exactly on top of it, then dissolve the clone. The two images are in the
    // same box at the same size, so the dissolve is invisible — what it buys us
    // is that a sub-pixel difference between them can never pop.
    landedRef.current();
    setLanded(true);
    if (!opening) {
      // Nothing to dissolve when closing: the photo has reached the avatar and
      // the viewer is already gone. Finishing here also matters because the
      // animate object does not change on landing, so framer would never fire a
      // second completion — the clone would stay mounted forever (and the avatar
      // would stop responding, since the caller guards on the morph being gone).
      doneRef.current();
      return;
    }
    // The dissolve has a fixed duration, so a timer is exact where waiting for a
    // second animation callback is not.
    fadeTimerRef.current = window.setTimeout(() => doneRef.current(), FADE_MS + 20);
  };

  if (reduce || !target) return null;

  // The element is laid out at its end size; the other end is a transform.
  const base = opening ? target : from;
  const small = opening ? from : target;

  const collapsed = {
    x: small.x + small.width / 2 - (base.x + base.width / 2),
    y: small.y + small.height / 2 - (base.y + base.height / 2),
    scaleX: small.width / base.width,
    scaleY: small.height / base.height,
    borderRadius: "50%",
  };
  const expanded = { x: 0, y: 0, scaleX: 1, scaleY: 1, borderRadius: "0%" };
  // Only the OPENING needs the dissolve: the gallery's own photo appears under
  // the clone there. Closing has nothing to cross-fade (the viewer has already
  // faded away), so the clone simply stops existing when it lands.
  const at = (state: typeof collapsed) =>
    landed && opening ? { ...state, opacity: 0 } : state;

  const transition = reduce
    ? { duration: 0 }
    : {
        ...springFor("flight", reduce),
        // Shape: settles with the flight, not before it — the circle becomes a
        // square over the same beat the box grows, which is what keeps it from
        // reading as two separate events. Closing mirrors it: the photo stays
        // square while it shrinks and only rounds as it arrives at the avatar.
        borderRadius: { ...SPRING.shape, delay: opening ? 0 : 0.14 },
        opacity: { duration: FADE_MS / 1000, ease: [0.4, 0, 0.2, 1] },
      };

  // Portalled to <body> on purpose: the profile page renders inside <main>, which
  // is `isolate` (its own stacking context) — a clone in there paints UNDER the
  // gallery, which portals to <body> at z-index 150. That made the flight look
  // like a dark shadow moving behind the viewer instead of the photo itself.
  return createPortal(
    <motion.img
      src={src}
      alt=""
      draggable={false}
      aria-hidden="true"
      initial={opening ? collapsed : expanded}
      animate={at(opening ? expanded : collapsed)}
      transition={transition}
      onAnimationComplete={handleFlightComplete}
      className="pointer-events-none fixed left-0 top-0 select-none object-cover"
      style={{
        left: base.x,
        top: base.y,
        width: base.width,
        height: base.height,
        zIndex: 200,
      }}
    />,
    document.body,
  );
}
