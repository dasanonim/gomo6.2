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
          {Array.from({ length: segments }, (_, index) => {
            const isRead = index < readSegments;
            const stroke = isRead
              ? "oklch(var(--muted-foreground) / 0.55)"
              : `url(#${gradientId})`;
            const shared = {
              "data-segment": index,
              "data-read": isRead ? "true" : "false",
              fill: "none",
              stroke,
              strokeWidth: 2.5,
              strokeLinecap: "round" as const,
              vectorEffect: "non-scaling-stroke" as const,
            };

            // One slide is a full circle: an arc path of exactly 360° would
            // render nothing, and a dashed circle would leave a fake gap.
            if (segments === 1) {
              return <circle key={index} {...shared} cx="50" cy="50" r={RING_RADIUS} />;
            }

            // Explicit arcs (not dash patterns): every segment has the same
            // angular length and the same gap, so the divisions stay even at
            // any size — dash offsets + round caps used to merge some gaps and
            // stretch others, which read as a crooked ring.
            const gap = segments <= 3 ? 14 : segments <= 6 ? 10 : segments <= 10 ? 8 : 6;
            const step = 360 / segments;
            const from = -90 + index * step + gap / 2;
            const to = -90 + (index + 1) * step - gap / 2;
            const point = (deg: number) => {
              const rad = (deg * Math.PI) / 180;
              return [50 + RING_RADIUS * Math.cos(rad), 50 + RING_RADIUS * Math.sin(rad)];
            };
            const [x1, y1] = point(from);
            const [x2, y2] = point(to);
            const largeArc = to - from > 180 ? 1 : 0;
            return (
              <path
                key={index}
                {...shared}
                d={`M ${x1} ${y1} A ${RING_RADIUS} ${RING_RADIUS} 0 ${largeArc} 1 ${x2} ${y2}`}
              />
            );
          })}
        </svg>
      )}
      {children}
    </span>
  );
}
