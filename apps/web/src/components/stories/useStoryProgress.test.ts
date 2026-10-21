import { renderHook, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installManualRaf, type ManualRaf } from "@/test/manualRaf";
import { useStoryProgress } from "./useStoryProgress";

const onComplete = vi.fn();

function progressOf(el: HTMLElement): number {
  const match = /scaleX\(([-\d.]+)\)/.exec(el.style.transform);
  return match ? Number(match[1]) : 0;
}

describe("useStoryProgress", () => {
  let raf: ManualRaf;
  let bar: HTMLSpanElement;
  let track: HTMLDivElement;

  const setup = (options?: { duration?: number; resetKey?: string }) => {
    const ref = { current: bar };
    const ariaRef = { current: track };
    return renderHook(
      ({ paused, duration, resetKey }: { paused: boolean; duration: number; resetKey: string }) =>
        useStoryProgress({
          duration,
          paused,
          resetKey,
          targetRef: ref,
          ariaRef,
          onComplete: onComplete,
        }),
      {
        initialProps: {
          paused: false,
          duration: options?.duration ?? 1000,
          resetKey: options?.resetKey ?? "s1",
        },
      },
    );
  };

  beforeEach(() => {
    vi.useFakeTimers();
    raf = installManualRaf();
    bar = document.createElement("span");
    track = document.createElement("div");
    onComplete.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("advances the bar over the slide duration and completes once", async () => {
    setup();

    await act(() => raf.advanceFrames(500));
    expect(progressOf(bar)).toBeGreaterThan(0.3);
    expect(progressOf(bar)).toBeLessThan(0.7);
    expect(track.getAttribute("aria-valuenow")).toBeTruthy();
    expect(onComplete).not.toHaveBeenCalled();

    await act(() => raf.advanceFrames(600));
    expect(progressOf(bar)).toBe(1);
    expect(onComplete).toHaveBeenCalledTimes(1);

    // A finished slide must not fire again even if frames keep coming.
    await act(() => raf.advanceFrames(500));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("freezes while paused and resumes from the same place without counting the pause", async () => {
    const { rerender } = setup();

    await act(() => raf.advanceFrames(400));
    const frozen = progressOf(bar);
    expect(frozen).toBeGreaterThan(0.2);

    rerender({ paused: true, duration: 1000, resetKey: "s1" });
    await act(() => raf.advanceFrames(2000));
    expect(progressOf(bar)).toBeCloseTo(frozen, 2);
    expect(onComplete).not.toHaveBeenCalled();

    rerender({ paused: false, duration: 1000, resetKey: "s1" });
    await act(() => raf.advanceFrames(300));
    expect(progressOf(bar)).toBeGreaterThan(frozen);
    expect(progressOf(bar)).toBeLessThan(1);
  });

  it("resets to zero when the slide changes", async () => {
    const { rerender } = setup();

    await act(() => raf.advanceFrames(500));
    expect(progressOf(bar)).toBeGreaterThan(0.3);

    rerender({ paused: false, duration: 1000, resetKey: "s2" });
    expect(progressOf(bar)).toBe(0);
  });

  it("does nothing for a zero duration (video path)", async () => {
    setup({ duration: 0 });

    await act(() => raf.advanceFrames(5000));
    expect(progressOf(bar)).toBe(0);
    expect(onComplete).not.toHaveBeenCalled();
  });
});
