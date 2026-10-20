import { useId, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import "./stories.css";

export type StoryRingProps = {
  /** Total live slides — one arc each. */
  total: number;
  /** How many of them this viewer has already opened. */
  read?: number;
  /** Draw the close-friends (green) gradient. */
  closeFriends?: boolean;
  /** Anything inside the ring (the avatar itself). */
  children: ReactNode;
  className?: string;
};

/** More segments than this turn into a solid ring: the arcs become thinner
 * than a pixel on a 40px avatar and the count stops being readable. */
export const MAX_RING_SEGMENTS = 20;

/** Radial perimeter of the ring, in the 100×100 viewBox. With the SVG box 4px
 * larger than the avatar, r=47 sits just outside the avatar at every size. */
const RING_RADIUS = 47;

/**
 * StoryRing is a purely presentational segmented ring: unread slides are drawn
 * with the brand gradient, read ones with a thin muted stroke, and the gap
 * between arcs is the theme background so it reads as separate segments.
 *
 * Segment count and read boundary come from the server's per-viewer state —
 * there is no local "seen" flag to drift.
 */
export function StoryRing({ total, read = 0, closeFriends = false, children, className }: StoryRingProps) {
  const rawId = useId();
  const gradientId = `story-ring-${rawId.replace(/[^a-zA-Z0-9_-]/g, "")}`;

  const segments = Math.max(0, Math.min(total, MAX_RING_SEGMENTS));
  // More slides than arcs: keep the read/unread proportion readable.
  const readSegments =
    total === 0 ? 0 : Math.round(Math.min(Math.max(read, 0), total) * (segments / total));
  const gap = segments > 1 ? 0.02 : 0;
  const dash = segments > 0 ? 1 / segments - gap : 0;

  return (
    <span className={cn("story-ring relative inline-flex shrink-0 items-center justify-center rounded-full", className)}>
      {segments > 0 && (
        <svg
          aria-hidden="true"
          data-testid="story-ring-svg"
          viewBox="0 0 100 100"
          className="pointer-events-none absolute -inset-[4px] h-[calc(100%+8px)] w-[calc(100%+8px)]"
        >
          <defs>
            <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="100%">
              <stop
                offset="0%"
                stopColor={closeFriends ? "var(--story-ring-close-from)" : "var(--story-ring-from)"}
              />
              <stop
                offset="100%"
                stopColor={closeFriends ? "var(--story-ring-close-to)" : "var(--story-ring-to)"}
              />
            </linearGradient>
          </defs>
          {Array.from({ length: segments }, (_, i) => {
            const isRead = i < readSegments;
            return (
              <circle
                key={i}
                data-segment={i}
                data-read={isRead ? "true" : "false"}
                cx="50"
                cy="50"
                r={RING_RADIUS}
                fill="none"
                pathLength={1}
                stroke={isRead ? "oklch(var(--muted-foreground) / 0.6)" : `url(#${gradientId})`}
                // Non-scaling: a 2.5px ring at every avatar size. Scaling the
                // stroke with the box made the 80px profile ring 4.5px thick —
                // heavy and unlike Telegram — while the 48px rail ring looked
                // right. Absolute pixels keep both consistent.
                vectorEffect="non-scaling-stroke"
                strokeWidth={isRead ? 1.5 : 2.5}
                strokeDasharray={`${dash} 1`}
                strokeDashoffset={-i / segments}
                transform="rotate(-90 50 50)"
              />
            );
          })}
        </svg>
      )}
      {children}
    </span>
  );
}
