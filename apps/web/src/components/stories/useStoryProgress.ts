import { useCallback, useEffect, useRef, type RefObject } from "react";

export type StoryProgressOptions = {
  /** Slide duration in ms (0 disables the timer). */
  duration: number;
  paused: boolean;
  onComplete: () => void;
  /** Changing this resets the progress (the slide changed). */
  resetKey: string;
  /** The active segment's fill element. Written directly — see below. */
  targetRef: RefObject<HTMLElement | null>;
  /** Optional progressbar element whose aria-valuenow mirrors the bar. */
  ariaRef?: RefObject<HTMLElement | null>;
};

const scaleX = (progress: number) => `scaleX(${Math.max(0, Math.min(1, progress))})`;

/**
 * Drives the progress bar of a non-video slide.
 *
 * Two deliberate decisions:
 *
 *  1. **No React state.** A bar that advances at 60fps must not re-render the
 *     whole player (media element, header, footer, Radix dialogs) sixty times a
 *     second — that is what made the previous version stutter. The hook writes
 *     `transform: scaleX()` straight to the segment element, so the bar is
 *     composited on the GPU and React does nothing per frame.
 *
 *  2. **Deltas from the frame clock.** The elapsed time is accumulated as the
 *     difference between consecutive requestAnimationFrame timestamps, never
 *     by mixing `Date.now()` with the frame timestamp (two different clocks —
 *     the old bug: the bar never advanced in a real browser). Pausing simply
 *     stops scheduling; resuming restarts the clock, so the pause gap is not
 *     counted and the slide continues where it stopped.
 */
export function useStoryProgress({
  duration,
  paused,
  onComplete,
  resetKey,
  targetRef,
  ariaRef,
}: StoryProgressOptions): void {
  const elapsedRef = useRef(0);
  const lastFrameRef = useRef<number | null>(null);
  const finishedRef = useRef(false);
  const completeRef = useRef(onComplete);
  completeRef.current = onComplete;

  const paint = useCallback(
    (progress: number) => {
      if (targetRef.current) targetRef.current.style.transform = scaleX(progress);
      if (ariaRef?.current) {
        ariaRef.current.setAttribute("aria-valuenow", String(Math.round(progress * 100)));
      }
    },
    [targetRef, ariaRef],
  );

  useEffect(() => {
    elapsedRef.current = 0;
    lastFrameRef.current = null;
    finishedRef.current = false;
    paint(0);
  }, [resetKey, paint]);

  useEffect(() => {
    if (duration <= 0 || paused || finishedRef.current) return;
    // A fresh run starts from a clean baseline: the first frame only records
    // the clock, so neither the pause gap nor the previous slide leaks in.
    lastFrameRef.current = null;

    let frame = 0;
    const tick = (now: number) => {
      if (lastFrameRef.current !== null) {
        elapsedRef.current += Math.max(0, now - lastFrameRef.current);
      }
      lastFrameRef.current = now;
      const progress = Math.min(1, elapsedRef.current / duration);
      paint(progress);
      if (progress >= 1) {
        finishedRef.current = true;
        completeRef.current();
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [duration, paused, resetKey, paint]);
}
