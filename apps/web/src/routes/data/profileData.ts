import { api } from "@/integrations/api/compat";
import { getCached, peekCached } from "@/integrations/api/queryCache";
import { registerRouteData } from "@/lib/routeData";
import { profileLookupUrl } from "@/utils/entityUrl";
import type { Profile } from "@/pages/profile/types";

/**
 * The viewer-scoped cache key Profile reads its row through. Shared so the
 * route preloader warms exactly the entry the page will hit on mount.
 */
export const profilePageCacheKey = (viewerId: string | undefined, param: string): string =>
  `profile-page:${viewerId ?? "guest"}:${param}`;

// The viewer id the most recent warm ran with. `warmProfilePageRow` runs first
// from the route preloader — before the router swaps views — so by the time the
// profile page mounts the id is known and the page can read the warmed row
// SYNCHRONOUSLY (peekWarmedProfilePageRow below) instead of painting a bare
// page background until its own loadProfile chain lands. An auth switch
// broadcasts `auth:expired` (all logout paths in apiClient), which drops the
// remembered id; the viewer's next warm records it again. When the chain fails
// everything degrades to the existing behaviour: the peek misses and the page
// renders its row as soon as the loadProfile fetch returns.
let warmedViewerId: string | undefined;

if (typeof window !== "undefined") {
  window.addEventListener("auth:expired", () => { warmedViewerId = undefined; });
}

/** Synchronous read of the row the route preloader warmed for this param. */
export const peekWarmedProfilePageRow = (param: string): Profile | null => {
  if (!param) return null;
  return peekCached<Profile | null>(profilePageCacheKey(warmedViewerId, param)) ?? null;
};

/** Fetch a profile row by UUID or public id. Shared by the page + preloader. */
export const fetchProfilePageRow = async (param: string): Promise<Profile | null> => {
  const res = await fetch(profileLookupUrl(param));
  const json = await res.json();
  return (json.data?.[0] as Profile | undefined) ?? null;
};

/** Warm the profile row through the same viewer-scoped key the page reads. */
export const warmProfilePageRow = async (viewerId: string | undefined, param: string): Promise<Profile | null> => {
  warmedViewerId = viewerId;
  return getCached<Profile | null>(
    profilePageCacheKey(viewerId, param),
    () => fetchProfilePageRow(param),
    // Fresh for a minute, then served stale (instantly) for up to five more
    // while a background revalidation runs — so back-navigation never blocks.
    { ttlMs: 60_000, staleTtlMs: 5 * 60_000 },
  );
};

export function registerProfileRouteData(): void {
  registerRouteData({
    id: "profile",
    match: "/profile/:userId",
    // Warm the profile row before the router swaps to the profile page, so the
    // previous page stays until the profile is ready and then it paints
    // instantly. Privacy/friendship reads are cheap and fill in after mount
    // (the page self-corrects), so the row alone is the gate.
    warm: async ({ location }) => {
      const param = location.pathname.split("/")[2];
      if (!param) return;

      const { data: { session } } = await api.auth.getSession();
      const viewerId = session?.user?.id;
      await warmProfilePageRow(viewerId, param);
    },
  });
}
