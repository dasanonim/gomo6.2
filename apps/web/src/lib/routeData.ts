/**
 * Route-data registry — the "loaders" of this app's stale-while-revalidate
 * navigation. A route registers a `warm()` function that fills whatever cache
 * the page reads on mount (TanStack via `warmQuery`, the URL cache via
 * `getCached`), using the SAME key. Then:
 *
 *   • `prefetchRouteData(location)` — fire-and-forget on link intent (hover,
 *     focus, touch, viewport): the data is already cached by the time the
 *     click lands and the swap is instant.
 *
 * Navigation never waits for warm-up: the router swaps immediately and the
 * page paints from cache (or a shaped skeleton) on its first frame.
 *
 * This deliberately does NOT use React Router's data router: the project
 * already has a bespoke transition engine (see `lib/viewTransitions.ts`) and
 * four caches, and the registry gives the same loader semantics without
 * duplicating either.
 */
import { matchPath, type Location } from "react-router-dom";

import { queryClient } from "@/integrations/api/queryClient";

export interface RouteDataContext {
  location: Location;
  /** Path params captured by the entry's `match` pattern(s). */
  params: Record<string, string>;
}

export type RouteDataWarm = (ctx: RouteDataContext) => Promise<void> | void;

export interface RouteDataEntry {
  /** Stable id — re-registering the same id replaces it (HMR/dev). */
  id: string;
  /** One or more react-router path patterns this entry warms. */
  match: string | string[];
  /** Higher runs first; reserved for future scheduling. */
  priority?: number;
  warm: RouteDataWarm;
}

// ── Adapter ──────────────────────────────────────────────────────────────────

/** Warm the TanStack cache with the exact options a page's hook uses. */
export function warmQuery<T>(options: {
  queryKey: readonly unknown[];
  queryFn: () => Promise<T>;
  staleTime?: number;
}): Promise<T> {
  return queryClient.ensureQueryData(options) as Promise<T>;
}

// ── Registry ─────────────────────────────────────────────────────────────────

const entries = new Map<string, RouteDataEntry>();

export function registerRouteData(entry: RouteDataEntry): void {
  entries.set(entry.id, entry);
}

/** All entries matching `pathname`, most specific/last-registered last. */
export function matchedRouteData(pathname: string): RouteDataEntry[] {
  const matched: RouteDataEntry[] = [];
  for (const entry of entries.values()) {
    const patterns = Array.isArray(entry.match) ? entry.match : [entry.match];
    if (patterns.some((pattern) => matchPath({ path: pattern, end: true }, pathname))) {
      matched.push(entry);
    }
  }
  return matched.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
}

/** Test/HMR helper — clears the registry. */
export function __resetRouteData(): void {
  entries.clear();
}

const paramsFor = (entry: RouteDataEntry, pathname: string): Record<string, string> => {
  const patterns = Array.isArray(entry.match) ? entry.match : [entry.match];
  const params: Record<string, string> = {};
  for (const pattern of patterns) {
    const match = matchPath({ path: pattern, end: true }, pathname);
    if (!match) continue;
    for (const [key, value] of Object.entries(match.params)) {
      if (value == null) continue;
      // defineProperty, not `params[key] = value`: route params are
      // pattern-derived, but this keeps the write safe regardless — a
      // `__proto__` key would otherwise hit the prototype setter (CWE-1321).
      Object.defineProperty(params, key, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  }
  return params;
};

const locationKey = (location: Location): string => `${location.pathname}${location.search}`;

// Concurrent warm-ups for the same location share one promise (an intent
// prefetch followed by a viewport prefetch must not double-fetch).
const inflight = new Map<string, Promise<void>>();

// Only the newest warm-up keeps warming; a superseded one stops between
// entries so a fast scroll-through never blocks on abandoned work.
let latestToken = 0;

// Dev-only coverage signal: a navigation to a route with no preloader is not
// necessarily wrong (auth/settings/legal legitimately have none), so this is a
// deduped console.debug rather than a warning.
const warnedPaths = new Set<string>();
function noteMissingPreloader(pathname: string): void {
  if (!import.meta.env.DEV || import.meta.env.MODE === "test" || warnedPaths.has(pathname)) return;
  warnedPaths.add(pathname);
  console.debug(
    `[route-data] no preloader registered for ${pathname} — the swap will not wait for its data`,
  );
}

async function warmRoute(location: Location): Promise<void> {
  const key = locationKey(location);
  const pending = inflight.get(key);
  if (pending) return pending;

  const token = ++latestToken;
  const promise = (async () => {
    try {
      for (const entry of matchedRouteData(location.pathname)) {
        if (token !== latestToken) break;
        try {
          await entry.warm({
            location,
            params: paramsFor(entry, location.pathname),
          });
        } catch {
          // Best-effort: the page reads through the same cache on mount and
          // refetches a miss — a failed prefetch must never surface.
        }
      }
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

/** Whether any preloader is registered for `pathname`. */
export function hasRouteData(pathname: string): boolean {
  return matchedRouteData(pathname).length > 0;
}

/**
 * Fire-and-forget warm-up for link intent (hover/focus/touch/viewport). Same
 * cache fills as the page reads on mount, but never touches the loading bar
 * and respects the user's network preferences. Navigation never awaits this —
 * the swap is instant and the page paints from whatever is warm.
 */
export function prefetchRouteData(location: Location): void {
  if (!shouldPrefetch()) return;
  if (!hasRouteData(location.pathname)) noteMissingPreloader(location.pathname);
  void warmRoute(location);
}

/**
 * Whether intent prefetching is welcome on this connection. Mirrors the
 * browser's Save-Data / slow-connection signals; explicit clicks still work.
 */
export function shouldPrefetch(): boolean {
  if (typeof navigator === "undefined") return true;
  const connection = (navigator as Navigator & {
    connection?: { saveData?: boolean; effectiveType?: string };
  }).connection;
  if (!connection) return true;
  if (connection.saveData) return false;
  return !/(^|-)2g$/.test(connection.effectiveType ?? "");
}
