import type { GiftCatalogItem } from "@/components/GiftCard";
import { requestProfileSummary } from "@/utils/profileSummaryLoader";
import { profileCacheInvalidateUserId } from "@/utils/profileCacheEvents";

/**
 * TTL-cached metadata for the current user (roles, username, avatar) and the
 * public gift catalog.
 *
 * Every page (Profile, Thread, Index, Board...) used to fetch user_roles +
 * profiles on mount just to know the moderator/admin flags — one navigation
 * fired the same requests per page. This collapses them into a single batched
 * call cached for 5 minutes, so a page-to-page hop costs 0 requests.
 *
 * The cache is cleared on the same 'profile-cache:invalidate' DOM event that
 * clears ProfileCacheContext, so saving a profile/avatar is reflected on the
 * next load instead of serving stale data for 5 minutes.
 */

export interface CurrentUserMeta {
  roles: string[];
  color: string;
  username: string;
  avatarUrl?: string;
  /** Custom nickname emoji shown next to the display name (nickname_emoji_id). */
  nicknameEmojiId?: string | null;
}

const TTL = 5 * 60 * 1000; // 5 minutes
const EMPTY: CurrentUserMeta = { roles: [], color: "", username: "" };

interface CacheEntry {
  expiresAt: number;
  value: CurrentUserMeta;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<CurrentUserMeta>>();

/**
 * Clears cached metadata. With a scoped `profile-cache:invalidate` event the
 * only entry that can be stale is the changed user's, so a viewer's own
 * roles/avatar are left alone instead of being refetched on every other
 * person's profile edit. No event (or an unscoped one) resets everything.
 */
export function clearCurrentUserMetaCache(event?: Event) {
  const changedUserId = event ? profileCacheInvalidateUserId(event) : undefined;
  if (changedUserId) {
    cache.delete(changedUserId);
    inFlight.delete(changedUserId);
    return;
  }
  cache.clear();
  inFlight.clear();
}

if (typeof window !== "undefined") {
  window.addEventListener("profile-cache:invalidate", clearCurrentUserMetaCache);
}

async function fetchCurrentUserMeta(userId: string): Promise<CurrentUserMeta> {
  // The batched summary carries the viewer's own role list (only their row
  // includes it) plus the username/avatar the header needs. One request, shared
  // with every profile badge mounted in the same tick.
  const summary = await requestProfileSummary(userId);
  return {
    roles: summary?.roles ?? (summary?.is_admin ? ["admin"] : []),
    // username_color achievement rewards were removed — no nickname color.
    color: "",
    username: summary?.username ?? "",
    avatarUrl: summary?.avatar_url ?? undefined,
    nicknameEmojiId: summary?.nickname_emoji_id ?? null,
  };
}

export async function getCurrentUserMeta(userId: string | undefined): Promise<CurrentUserMeta> {
  if (!userId) return EMPTY;

  const now = Date.now();
  const hit = cache.get(userId);
  if (hit && hit.expiresAt > now) return hit.value;

  const existing = inFlight.get(userId);
  if (existing) return existing;

  const promise = (async (): Promise<CurrentUserMeta> => {
    try {
      const value = await fetchCurrentUserMeta(userId);
      cache.set(userId, { expiresAt: Date.now() + TTL, value });
      return value;
    } catch {
      // Network/5xx failure: degrade to empty meta WITHOUT caching it, so the
      // next call retries. Never let a page crash because cached metadata
      // (roles/color) failed to load.
      return EMPTY;
    } finally {
      inFlight.delete(userId);
    }
  })();

  inFlight.set(userId, promise);
  return promise;
}

// ─── Gift catalog (public, rarely changes) ──────────────────────────────────

const GIFT_CATALOG_TTL = 10 * 60 * 1000; // 10 minutes
let giftCatalogCache: { expiresAt: number; value: GiftCatalogItem[] } | null = null;
let giftCatalogInFlight: Promise<GiftCatalogItem[]> | null = null;

export async function getGiftCatalog(): Promise<GiftCatalogItem[]> {
  if (giftCatalogCache && giftCatalogCache.expiresAt > Date.now()) {
    return giftCatalogCache.value;
  }
  if (giftCatalogInFlight) return giftCatalogInFlight;

  giftCatalogInFlight = (async () => {
    try {
      const res = await fetch("/api/v1/gift_catalog");
      const json = await res.json().catch(() => ({ data: [] }));
      const items = (json.data ?? []) as GiftCatalogItem[];
      giftCatalogCache = { expiresAt: Date.now() + GIFT_CATALOG_TTL, value: items };
      return items;
    } finally {
      giftCatalogInFlight = null;
    }
  })();

  return giftCatalogInFlight;
}
