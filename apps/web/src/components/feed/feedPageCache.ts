/** Viewer-scoped first-page cache for instant feed returns within a tab. */
export interface FeedPageCache<T> {
  items: T[];
  hasMore: boolean;
  savedAt: number;
}

interface StoredFeedPage<T> extends FeedPageCache<T> {
  version: 1;
  viewerKey: string;
}

const STORAGE_PREFIX = "gomo6:feed-page:v1:";
const CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_STORAGE_CHARS = 900_000;
const MAX_MEMORY_ENTRIES = 4;
const memory = new Map<string, StoredFeedPage<unknown>>();

const viewerKeyOf = (viewerId: string | null | undefined) => viewerId || "anon";
const storageKey = (viewerKey: string, limit: number) =>
  `${STORAGE_PREFIX}${encodeURIComponent(viewerKey)}:${limit}`;

function isFresh<T>(entry: StoredFeedPage<T>, now: number): boolean {
  const age = now - entry.savedAt;
  return entry.version === 1 && Number.isFinite(entry.savedAt) && age >= 0 && age <= CACHE_TTL_MS;
}

export function readFeedPageCache<T>(
  viewerId: string | null | undefined,
  limit: number,
  now = Date.now(),
): FeedPageCache<T> | null {
  const viewerKey = viewerKeyOf(viewerId);
  const key = storageKey(viewerKey, limit);
  let entry = memory.get(key) as StoredFeedPage<T> | undefined;

  if (!entry && typeof sessionStorage !== "undefined") {
    try {
      const raw = sessionStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<StoredFeedPage<T>>;
        if (
          parsed.version === 1 &&
          parsed.viewerKey === viewerKey &&
          Array.isArray(parsed.items) &&
          typeof parsed.hasMore === "boolean" &&
          typeof parsed.savedAt === "number"
        ) {
          entry = parsed as StoredFeedPage<T>;
          memory.set(key, entry as StoredFeedPage<unknown>);
        }
      }
    } catch {
      // Bad or unavailable storage is just a cold feed load.
    }
  }

  if (!entry || entry.items.length === 0) return null;
  if (!isFresh(entry, now)) {
    clearFeedPageCache(viewerId, limit);
    return null;
  }

  return { items: entry.items, hasMore: entry.hasMore, savedAt: entry.savedAt };
}

export function writeFeedPageCache<T>(
  viewerId: string | null | undefined,
  limit: number,
  items: T[],
  hasMore: boolean,
  now = Date.now(),
): void {
  if (items.length === 0) {
    clearFeedPageCache(viewerId, limit);
    return;
  }

  const viewerKey = viewerKeyOf(viewerId);
  const key = storageKey(viewerKey, limit);
  const entry: StoredFeedPage<T> = { version: 1, viewerKey, items, hasMore, savedAt: now };

  memory.delete(key);
  memory.set(key, entry as StoredFeedPage<unknown>);
  while (memory.size > MAX_MEMORY_ENTRIES) {
    const oldest = memory.keys().next().value as string | undefined;
    if (!oldest) break;
    memory.delete(oldest);
  }

  if (typeof sessionStorage === "undefined") return;
  try {
    // Keep the visible head if a very media-heavy response approaches the tab's
    // storage quota. The live in-memory copy still retains the complete page.
    for (let count = items.length; count >= 1; count -= 1) {
      const stored: StoredFeedPage<T> = {
        ...entry,
        items: items.slice(0, count),
        hasMore: hasMore || count < items.length,
      };
      const raw = JSON.stringify(stored);
      if (raw.length <= MAX_STORAGE_CHARS) {
        sessionStorage.setItem(key, raw);
        return;
      }
    }
  } catch {
    // Quota / private browsing: the in-memory cache still serves this tab.
  }
}

export function clearFeedPageCache(viewerId: string | null | undefined, limit: number): void {
  const key = storageKey(viewerKeyOf(viewerId), limit);
  memory.delete(key);
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.removeItem(key);
  } catch {
    // Ignore unavailable storage.
  }
}

/** Test-only helpers for simulating a new document while retaining tab storage. */
export function __forgetFeedPageCacheInMemoryForTests(): void {
  memory.clear();
}

export function __resetFeedPageCacheForTests(): void {
  memory.clear();
  if (typeof sessionStorage === "undefined") return;
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith(STORAGE_PREFIX)) sessionStorage.removeItem(key);
    }
  } catch {
    // Ignore unavailable storage.
  }
}
