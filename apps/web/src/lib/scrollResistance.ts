/**
 * Resistance for latched scroll effects.
 *
 * A latched element (a sucked-in profile block, the pinned-bar strip) does not
 * release the moment the user scrolls up: it must be pulled. The distance
 * depends on how hard the pull is — a flick releases almost at once, a slow
 * drag has to travel the full base distance. This is the "sticky drawer" feel:
 * the shell resists, then lets go with a spring.
 *
 * @param speedPxPerMs upward scroll speed (positive number)
 * @param basePx        pull needed at a crawl
 * @param floorPx       pull needed at a hard flick
 */
export const releasePullPx = (speedPxPerMs: number, basePx = 130, floorPx = 30): number => {
  const ease = 1 - Math.min(0.8, Math.max(0, speedPxPerMs) / 3);
  return Math.max(floorPx, basePx * ease);
};
