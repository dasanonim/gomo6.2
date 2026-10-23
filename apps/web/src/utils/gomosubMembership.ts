/**
 * One shared read for "is this user a member of that board (and with what
 * role?)".
 *
 * The board page used to ask the identical
 * `/api/v1/gomosub_memberships?board_id=eq.…&user_id=eq.…` three times per
 * mount (private-gate, private-channel filter, join-button state). Every
 * reader goes through getMyGomosubMembership: concurrent callers share one
 * in-flight request and a fresh snapshot is reused for 60s. Join/leave
 * writers call invalidateGomosubMembership so the next read is authoritative.
 */
export interface GomosubMembershipRow {
  id?: string;
  board_id?: string;
  user_id?: string;
  role_id?: string | null;
  [key: string]: unknown;
}

const TTL_MS = 60_000;

interface Entry {
  row: GomosubMembershipRow | null;
  at: number;
}

const cache = new Map<string, Entry>();
const inFlight = new Map<string, Promise<GomosubMembershipRow | null>>();

const key = (boardId: string, userId: string): string => `${boardId}|${userId}`;

async function fetchMembership(boardId: string, userId: string): Promise<GomosubMembershipRow | null> {
  const res = await fetch(
    `/api/v1/gomosub_memberships?board_id=eq.${encodeURIComponent(boardId)}&user_id=eq.${encodeURIComponent(userId)}`,
  );
  if (!res.ok) return null;
  const json = await res.json();
  const rows = (json.data ?? []) as GomosubMembershipRow[];
  return rows[0] ?? null;
}

export const getMyGomosubMembership = (
  boardId: string,
  userId: string,
): Promise<GomosubMembershipRow | null> => {
  if (!boardId || !userId) return Promise.resolve(null);
  const k = key(boardId, userId);

  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.row);

  const pending = inFlight.get(k);
  if (pending) return pending;

  const run = (async (): Promise<GomosubMembershipRow | null> => {
    try {
      const row = await fetchMembership(boardId, userId);
      cache.set(k, { row, at: Date.now() });
      return row;
    } catch {
      return hit?.row ?? null;
    } finally {
      inFlight.delete(k);
    }
  })();
  inFlight.set(k, run);
  return run;
};

/** Drop cached memberships (one board, or everything when omitted). */
export const invalidateGomosubMembership = (boardId?: string, userId?: string): void => {
  if (!boardId && !userId) {
    cache.clear();
    return;
  }
  for (const k of Array.from(cache.keys())) {
    const [b, u] = k.split("|");
    if ((boardId === undefined || b === boardId) && (userId === undefined || u === userId)) {
      cache.delete(k);
    }
  }
};

/** Test/HMR escape hatch. */
export const resetGomosubMembershipCache = (): void => {
  cache.clear();
  inFlight.clear();
};
