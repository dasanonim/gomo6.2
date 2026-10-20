import { useRef, type PointerEvent as ReactPointerEvent } from "react";

export type VideoTimelineProps = {
  /** Evenly spaced frames of the clip (empty while they are being extracted). */
  frames: string[];
  /** 0..1 playback position. */
  progress: number;
  currentTime: number;
  duration: number;
  /** Called with 0..1 when the user taps or drags the track. */
  onSeek: (ratio: number) => void;
};

function formatTime(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const minutes = Math.floor(safe / 60);
  const rest = Math.floor(safe % 60);
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}

/**
 * The clip's timeline: frame thumbnails, a playhead and a scrub area. Tapping
 * or dragging seeks the preview — this is the video's own timeline, not a list
 * of the author's slides.
 */
export function VideoTimeline({ frames, progress, currentTime, duration, onSeek }: VideoTimelineProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const clamped = Math.min(1, Math.max(0, progress));

  const seekFrom = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    onSeek(Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)));
  };

  const handleDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // Not every engine (or jsdom) implements pointer capture; seeking must
    // still work with a plain pointerdown.
    event.currentTarget.setPointerCapture?.(event.pointerId);
    seekFrom(event.clientX);
  };

  const handleMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.buttons === 0) return;
    seekFrom(event.clientX);
  };

  return (
    <div className="space-y-1.5" data-testid="video-timeline">
      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label="Позиция видео"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(clamped * 100)}
        onPointerDown={handleDown}
        onPointerMove={handleMove}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") onSeek(Math.max(0, clamped - 0.05));
          else if (event.key === "ArrowRight") onSeek(Math.min(1, clamped + 0.05));
        }}
        className="relative h-14 cursor-pointer touch-none select-none overflow-hidden rounded-xl bg-white/10"
      >
        {frames.length > 0 && (
          <div className="pointer-events-none flex h-full">
            {frames.map((frame, index) => (
              <img
                key={index}
                src={frame}
                alt=""
                draggable={false}
                className="h-full min-w-0 flex-1 object-cover"
              />
            ))}
          </div>
        )}
        {/* Unplayed part is dimmed, like a scrubber. */}
        <div
          className="pointer-events-none absolute inset-y-0 right-0 bg-black/45"
          style={{ left: `${clamped * 100}%` }}
        />
        <div
          className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 rounded-full bg-white shadow-[0_0_6px_rgba(0,0,0,0.6)]"
          style={{ left: `${clamped * 100}%` }}
        />
      </div>
      <div className="flex justify-between px-0.5 text-[11px] tabular-nums text-white/45">
        <span>{formatTime(currentTime)}</span>
        <span>{formatTime(duration)}</span>
      </div>
    </div>
  );
}
