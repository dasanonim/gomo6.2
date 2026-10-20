import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { VideoTimeline } from "./VideoTimeline";

function renderTimeline(progress = 0.5) {
  const onSeek = vi.fn();
  render(
    <VideoTimeline
      frames={["a", "b", "c"]}
      progress={progress}
      currentTime={1.5}
      duration={3}
      onSeek={onSeek}
    />,
  );
  const track = screen.getByRole("slider");
  vi.spyOn(track, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: 200,
    height: 56,
    right: 200,
    bottom: 56,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
  return { onSeek, track };
}

describe("VideoTimeline", () => {
  it("draws one thumbnail per extracted frame", () => {
    renderTimeline();
    const timeline = screen.getByTestId("video-timeline");
    expect(timeline.querySelectorAll("img")).toHaveLength(3);
  });

  it("seeks to the tapped position", () => {
    const { onSeek, track } = renderTimeline();
    fireEvent.pointerDown(track, { clientX: 50, pointerId: 1, buttons: 1 });
    expect(onSeek).toHaveBeenCalledWith(0.25);

    fireEvent.pointerDown(track, { clientX: 150, pointerId: 2, buttons: 1 });
    expect(onSeek).toHaveBeenCalledWith(0.75);
  });

  it("clamps taps outside the track", () => {
    const { onSeek, track } = renderTimeline();
    fireEvent.pointerDown(track, { clientX: -40, pointerId: 1, buttons: 1 });
    expect(onSeek).toHaveBeenCalledWith(0);
    fireEvent.pointerDown(track, { clientX: 999, pointerId: 2, buttons: 1 });
    expect(onSeek).toHaveBeenCalledWith(1);
  });

  it("seeks with the keyboard", () => {
    const { onSeek, track } = renderTimeline(0.5);
    fireEvent.keyDown(track, { key: "ArrowRight" });
    expect(onSeek).toHaveBeenCalledWith(0.55);
    fireEvent.keyDown(track, { key: "ArrowLeft" });
    expect(onSeek).toHaveBeenCalledWith(0.45);
  });
});
