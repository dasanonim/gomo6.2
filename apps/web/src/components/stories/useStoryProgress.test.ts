import { renderHook, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installManualRaf, type ManualRaf } from "@/test/manualRaf";
import { useStoryProgress } from "./useStoryProgress";

describe("useStoryProgress", () => {
  let raf: ManualRaf;

  beforeEach(() => {
    vi.useFakeTimers();
    raf = installManualRaf();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("fills the bar over the slide duration and completes once", async () => {
    const onComplete = vi.fn();
    const { result } = renderHook(() =>
      useStoryProgress({ duration: 1000, paused: false, onComplete, resetKey: "s1" }),
    );

    await act(() => raf.advanceFrames(500));
    expect(result.current).toBeGreaterThan(0.3);
    expect(result.current).toBeLessThan(0.7);
    expect(onComplete).not.toHaveBeenCalled();

    await act(() => raf.advanceFrames(600));
    expect(result.current).toBe(1);
    expect(onComplete).toHaveBeenCalledTimes(1);

    // A finished slide must not fire again even if frames keep coming.
    await act(() => raf.advanceFrames(500));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("freezes while paused and resumes from the same place", async () => {
    const onComplete = vi.fn();
    const { result, rerender } = renderHook(
      ({ paused }) => useStoryProgress({ duration: 1000, paused, onComplete, resetKey: "s1" }),
      { initialProps: { paused: false } },
    );

    await act(() => raf.advanceFrames(400));
    const frozen = result.current;
    expect(frozen).toBeGreaterThan(0.2);

    rerender({ paused: true });
    await act(() => raf.advanceFrames(800));
    expect(result.current).toBeCloseTo(frozen, 1);
    expect(onComplete).not.toHaveBeenCalled();

    rerender({ paused: false });
    await act(() => raf.advanceFrames(700));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("resets to zero when the slide changes", async () => {
    const onComplete = vi.fn();
    const { result, rerender } = renderHook(
      ({ resetKey }) =>
        useStoryProgress({ duration: 1000, paused: false, onComplete, resetKey }),
      { initialProps: { resetKey: "s1" } },
    );

    await act(() => raf.advanceFrames(500));
    expect(result.current).toBeGreaterThan(0.3);

    rerender({ resetKey: "s2" });
    expect(result.current).toBe(0);
  });

  it("does nothing for a zero duration (video path)", async () => {
    const onComplete = vi.fn();
    const { result } = renderHook(() =>
      useStoryProgress({ duration: 0, paused: false, onComplete, resetKey: "v1" }),
    );

    await act(() => raf.advanceFrames(5000));
    expect(result.current).toBe(0);
    expect(onComplete).not.toHaveBeenCalled();
  });
});
