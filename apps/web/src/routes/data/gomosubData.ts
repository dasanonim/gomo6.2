import { getCached } from "@/integrations/api/queryCache";
import { registerRouteData } from "@/lib/routeData";

/**
 * One public community in the /g catalog, produced by the
 * `GET /api/rpc/gomosubs_directory` endpoint: board metadata + member/channel
 * counts + the viewer's joined flag in a single request (no per-board
 * head-count fetches, no thread/likes loading}.
 */
export type GomoSubDirectoryItem = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  cover_image_url?: string | null;
  gomosub_avatar_url?: string | null;
  gomosub_tags?: string[] | null;
  visibility: string;
  created_at: string;
  member_count: number;
  channel_count: number;
  joined: boolean;
};

/**
 * Explicit cache key (the GET URL) so the page can read through `useCachedQuery`
 * and the route preloader can warm the exact same entry. Membership writes
 * invalidate it via the `/api/rpc/gomosubs_directory` prefix; writes to
 * `boards` invalidate it via the generic `/api/v1/boards` prefix.
 */
export const GOMOSUBS_DIRECTORY_KEY = "/api/rpc/gomosubs_directory";

export const GOMOSUBS_TTL_MS = 5 * 60 * 1000;
export const GOMOSUBS_STALE_MS = 30 * 60 * 1000;

export const fetchGomoSubsDirectory = async (): Promise<GomoSubDirectoryItem[]> => {
  const res = await fetch(GOMOSUBS_DIRECTORY_KEY);
  if (!res.ok) throw new Error(`gomosubs_directory HTTP ${res.status}`);
  const json = await res.json();
  return (json.data as GomoSubDirectoryItem[]) ?? [];
};

export const loadGomoSubsDirectory = (): Promise<GomoSubDirectoryItem[]> =>
  getCached(GOMOSUBS_DIRECTORY_KEY, fetchGomoSubsDirectory, {
    ttlMs: GOMOSUBS_TTL_MS,
    staleTtlMs: GOMOSUBS_STALE_MS,
  });

export function registerGomoSubRouteData(): void {
  registerRouteData({
    id: "gomosubs",
    match: ["/gomosubs", "/g"],
    warm: async () => {
      await loadGomoSubsDirectory();
    },
  });
}
