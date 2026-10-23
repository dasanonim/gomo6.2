import { PROFILE_CACHE_INVALIDATE_EVENT, profileCacheInvalidateUserId } from "@/utils/profileCacheEvents";

/**
 * Batched profile-display loader.
 *
 * Every rendered `<UserBadge>`/`<AdminBadge>` needs the same three things for
 * its author: the display profile row, the public customization and the admin
 * flag. Doing that per component produced an HTTP N+1 (3 requests per distinct
 * author — measured at ~70% of the production request volume).
 *
 * This module is a small DataLoader: `requestProfileSummary(id)` never fetches
 * immediately. It queues the id, resolves on the next tick with a single
 * `GET /api/v1/profiles/summary?ids=…` for every id requested in that tick, and
 * then serves all later reads from a 5-minute cache.
 *
 * The queue is also the invalidation point: `profile-cache:invalidate` drops the
 * affected entry (or everything for an unscoped event), and a generation counter
 * prevents an in-flight response from resurrecting stale data.
 */

export interface ProfileSummaryCustomization {
  username_css?: string | null;
  profile_badge_text?: string | null;
  profile_badge_css?: string | null;
  background_url?: string | null;
  background_variant?: string | null;
  [key: string]: unknown;
}

export interface ProfileSummary {
  id: string;
  public_id?: number | null;
  username: string;
  display_name?: string | null;
  avatar_url?: string | null;
  nickname_emoji_id?: string | null;
  is_admin: boolean;
  /** Present only for the viewer's own row; other rows carry `is_admin`. */
  roles?: string[] | null;
  customization?: ProfileSummaryCustomization | null;
}

interface CacheEntry {
  value: ProfileSummary | null;
  at: number;
}

const TTL = 5 * 60 * 1000;
// A miss is cached briefly so a deleted/unknown author does not get re-requested
// on every re-render, while a newly created user still appears soon.
const MISS_TTL = 30 * 1000;
const MAX_ENTRIES = 500;
const MAX_BATCH = 100;
const FLUSH_DELAY_MS = 0; // next macrotask: collects every effect of one commit

const cache = new Map<string, CacheEntry>();
const queue = new Set<string>();
const waiters = new Map<string, Array<(value: ProfileSummary | null) => void>>();
const listeners = new Set<() => void>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let generation = 0;

const normalizeKey = (userId: string): string => userId.trim().toLowerCase();

const notify = () => {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A broken subscriber must not stop the others.
    }
  }
};

const writeEntry = (key: string, value: ProfileSummary | null, currentGeneration: number) => {
  if (currentGeneration !== generation) return;
  if (!cache.has(key) && cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, at: Date.now() });
};

const readEntry = (key: string): ProfileSummary | null | undefined => {
  const entry = cache.get(key);
  if (!entry) return undefined;
  const maxAge = entry.value ? TTL : MISS_TTL;
  if (Date.now() - entry.at > maxAge) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
};

const chunk = <T,>(items: T[], size: number): T[][] => {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
};

const resolveWaiters = (ids: string[]) => {
  for (const id of ids) {
    const list = waiters.get(id);
    if (!list) continue;
    waiters.delete(id);
    const value = readEntry(id) ?? null;
    for (const resolve of list) resolve(value);
  }
};

/**
 * Last-resort path for a rolling deploy where the new frontend reaches an old
 * backend (the summary route 404s). It restores the previous per-user requests
 * only for this batch, so badges degrade to "slow" instead of "unstyled".
 */
const legacyFetch = async (id: string): Promise<ProfileSummary | null> => {
  const encoded = encodeURIComponent(id);
  try {
    const [profileRes, customizationRes] = await Promise.all([
      fetch(`/api/v1/profiles?id=eq.${encoded}`),
      fetch(`/api/v1/users/${encoded}/customization`),
    ]);
    const profilePayload = profileRes.ok ? await profileRes.json() : null;
    const customizationPayload = customizationRes.ok ? await customizationRes.json() : null;
    const profile = profilePayload?.data?.[0] ?? null;
    if (!profile) return null;

    // Roles are protected; a guest gets 401 here, which is fine (no badge).
    let roles: string[] = [];
    try {
      const rolesRes = await fetch(`/api/v1/user_roles?user_id=eq.${encoded}`);
      if (rolesRes.ok) {
        const rolesPayload = await rolesRes.json();
        roles = Array.isArray(rolesPayload?.data)
          ? rolesPayload.data.map((r: { role?: string }) => r.role).filter(Boolean) as string[]
          : [];
      }
    } catch {
      roles = [];
    }

    return {
      id: profile.id ?? id,
      public_id: profile.public_id ?? null,
      username: profile.username ?? "",
      display_name: profile.display_name ?? null,
      avatar_url: profile.avatar_url ?? null,
      nickname_emoji_id: profile.nickname_emoji_id ?? null,
      is_admin: roles.includes("admin"),
      roles,
      customization: customizationPayload?.data ?? null,
    };
  } catch {
    return null;
  }
};

const flush = async () => {
  flushTimer = null;
  if (queue.size === 0) return;

  const currentGeneration = generation;
  const ids = Array.from(queue);
  queue.clear();

  for (const batch of chunk(ids, MAX_BATCH)) {
    let rows: ProfileSummary[] | null = null;
    try {
      const res = await fetch(
        `/api/v1/profiles/summary?ids=${encodeURIComponent(batch.join(","))}`,
        { headers: { Accept: "application/json" } },
      );
      if (res.ok) {
        const payload = await res.json();
        rows = Array.isArray(payload?.data) ? (payload.data as ProfileSummary[]) : [];
      } else if (res.status !== 404 && res.status !== 405) {
        // A real backend error: fall through to the legacy path below.
        rows = null;
      }
    } catch {
      rows = null;
    }

    if (rows) {
      const byKey = new Map<string, ProfileSummary>();
      for (const row of rows) {
        if (!row?.id) continue;
        byKey.set(normalizeKey(row.id), row);
        if (row.public_id != null) byKey.set(String(row.public_id), row);
        writeEntry(normalizeKey(row.id), row, currentGeneration);
        if (row.public_id != null) writeEntry(String(row.public_id), row, currentGeneration);
      }
      for (const id of batch) {
        if (!byKey.has(id)) writeEntry(id, null, currentGeneration);
      }
    } else {
      const legacy = await Promise.all(batch.map(legacyFetch));
      for (let i = 0; i < batch.length; i++) {
        const value = legacy[i];
        writeEntry(batch[i], value, currentGeneration);
        if (value) {
          writeEntry(normalizeKey(value.id), value, currentGeneration);
          if (value.public_id != null) writeEntry(String(value.public_id), value, currentGeneration);
        }
      }
    }

    resolveWaiters(batch);
  }

  notify();
};

const scheduleFlush = () => {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    void flush();
  }, FLUSH_DELAY_MS);
};

/**
 * Requests one profile summary. Resolves on the next flush with the batched
 * result (or null when the user does not exist / the request failed), and is
 * deduplicated with every other call for the same id in the same tick.
 */
export const requestProfileSummary = (userId: string): Promise<ProfileSummary | null> => {
  if (!userId) return Promise.resolve(null);
  const key = normalizeKey(userId);

  const cached = readEntry(key);
  if (cached !== undefined) return Promise.resolve(cached);

  const pending = waiters.get(key);
  if (pending) {
    return new Promise((resolve) => pending.push(resolve));
  }

  const promise = new Promise<ProfileSummary | null>((resolve) => {
    waiters.set(key, [resolve]);
    queue.add(key);
    scheduleFlush();
  });
  return promise;
};

/** Prefetch a list (feeds/threads can call this instead of relying on badges). */
export const preloadProfileSummaries = (userIds: string[]): Promise<Array<ProfileSummary | null>> =>
  Promise.all(userIds.map((id) => requestProfileSummary(id)));

/** Synchronous cache read for render paths (returns null while loading). */
export const getCachedProfileSummary = (userId: string): ProfileSummary | null => {
  if (!userId) return null;
  return readEntry(normalizeKey(userId)) ?? null;
};

/**
 * Drops one user (scoped invalidation) or the whole cache (unscoped/editor
 * save). Matching by canonical id also clears entries cached under a public id.
 */
const invalidateKeys = (changed?: string): void => {
  generation++;
  if (changed) {
    const target = normalizeKey(changed);
    for (const [key, entry] of cache) {
      if (key === target || (entry.value && normalizeKey(entry.value.id) === target)) {
        cache.delete(key);
      }
    }
  } else {
    cache.clear();
  }
  notify();
};

/** Drops one user's cached summary (scoped invalidation by id). */
export const invalidateProfileSummary = (userId: string): void => {
  if (userId) invalidateKeys(userId);
};

/** Drops one user (from a DOM event) or the whole cache (unscoped). */
export const invalidateProfileSummaries = (event?: Event): void => {
  invalidateKeys(event ? profileCacheInvalidateUserId(event) : undefined);
};

/** Subscribe to cache updates (used by the React provider to re-render). */
export const subscribeProfileSummaries = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Test/HMR escape hatch. */
export const resetProfileSummaryLoader = (): void => {
  cache.clear();
  queue.clear();
  waiters.clear();
  listeners.clear();
  generation++;
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
};

if (typeof window !== "undefined") {
  window.addEventListener(PROFILE_CACHE_INVALIDATE_EVENT, (event) => {
    invalidateProfileSummaries(event);
  });
}
