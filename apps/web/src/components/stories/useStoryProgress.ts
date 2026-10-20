import { useEffect, useRef, useState } from "react";

export type StoryProgressOptions = {
  /** Slide duration in ms (0 disables the timer). */
  duration: number;
  paused: boolean;
  onComplete: () => void;
  /** Changing this resets the progress (the slide changed). */
  resetKey: string;
};

/**
 * Drives the progress bar of a non-video slide. Progress is measured with
 * `Date.now()` inside requestAnimationFrame so pausing (hold, tab hidden, a
 * dialog) freezes the bar and resuming continues from the same place instead of
 * restarting the slide — the behaviour Telegram users expect.
 */
export function useStoryProgress({ duration, paused, onComplete, resetKey }: StoryProgressOptions): number {
  const [progress, setProgress] = useState(0);
  const elapsedRef = useRef(0);
  const startedAtRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const finishedRef = useRef(false);
  const completeRef = useRef(onComplete);
  completeRef.current = onComplete;

  useEffect(() => {
    elapsedRef.current = 0;
    startedAtRef.current = null;
    finishedRef.current = false;
    setProgress(0);
  }, [resetKey]);

  useEffect(() => {
    if (duration <= 0 || finishedRef.current) return;

    if (paused) {
      if (startedAtRef.current !== null) {
        elapsedRef.current += Date.now() - startedAtRef.current;
        startedAtRef.current = null;
      }
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      setProgress(Math.min(1, elapsedRef.current / duration));
      return;
    }

    startedAtRef.current = Date.now();
    const tick = (now: number) => {
      const elapsed = elapsedRef.current + (now - (startedAtRef.current ?? now));
      const next = Math.min(1, elapsed / duration);
      setProgress(next);
      if (next >= 1) {
        finishedRef.current = true;
        rafRef.current = null;
        completeRef.current();
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (startedAtRef.current !== null) {
        elapsedRef.current += Date.now() - startedAtRef.current;
        startedAtRef.current = null;
      }
    };
  }, [paused, duration, resetKey]);

  return progress;
}
