import { vi } from "vitest";

/**
 * Deterministic animation frames for tests.
 *
 * Vitest's fake timers do not fake `requestAnimationFrame` on this jsdom setup,
 * so a frame-driven module would either never run or run on the real clock. This
 * replaces rAF with a queue the test drains step by step, while still advancing
 * the fake clock — `Date.now()` based animations therefore progress exactly one
 * frame per call.
 */
export interface ManualRaf {
  /** Advance one frame: move the fake clock, drain the queue, run microtasks. */
  frame: (ms?: number) => Promise<void>;
  /** Advance by whole frames until `totalMs` is consumed. */
  advanceFrames: (totalMs: number) => Promise<void>;
  /** Drain the queue without moving the clock. */
  flushFrames: () => void;
  /** How many frames are waiting to run. */
  pending: () => number;
}

export const FRAME_MS = 16;

export function installManualRaf(): ManualRaf {
  let nextId = 1;
  const pending = new Map<number, FrameRequestCallback>();

  vi.stubGlobal("requestAnimationFrame", ((cb: FrameRequestCallback) => {
    const id = nextId++;
    pending.set(id, cb);
    return id;
  }) as typeof requestAnimationFrame);

  vi.stubGlobal("cancelAnimationFrame", ((id: number) => {
    pending.delete(id);
  }) as typeof cancelAnimationFrame);

  const drain = () => {
    const callbacks = [...pending.values()];
    pending.clear();
    for (const callback of callbacks) callback(Date.now());
  };

  const frame = async (ms: number = FRAME_MS) => {
    vi.advanceTimersByTime(ms);
    drain();
    await Promise.resolve();
    await Promise.resolve();
  };

  return {
    frame,
    async advanceFrames(totalMs: number) {
      let left = totalMs;
      // A frame is drained first so a queued callback runs even for `totalMs: 0`.
      await frame(0);
      while (left > 0) {
        const step = Math.min(FRAME_MS, left);
        await frame(step);
        left -= step;
      }
    },
    flushFrames: drain,
    pending: () => pending.size,
  };
}
