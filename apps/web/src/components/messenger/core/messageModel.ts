/**
 * Canonical message identity and ordering for the messenger.
 *
 * A message carries two ids: the server `id` (a UUID, assigned on insert) and
 * the sender-minted `client_id` (stable across the optimistic → server
 * round-trip). Using ONE identity everywhere — `client_id || id` — lets an
 * optimistic message and its server echo collapse into a single slot instead
 * of racing as two rows, and keeps the mounted list's row keys stable.
 *
 * Before this module the store keyed merges by `id || client_id` while
 * MessageList keyed items by `client_id ?? id` — two different identities for
 * the same message. Everything here uses the MessageList convention.
 *
 * The functions are pure and order-stable: a merge never reshuffles messages
 * that already share a `sent_at` (Array.prototype.sort is stable since
 * ES2019), so virtual item windows never jump on a tie.
 */

/** The minimal shape needed for identity + ordering (MessageView satisfies it). */
export interface MessageIdentity {
  id: string;
  client_id?: string | null;
  sent_at: string;
}

/** The canonical identity: `client_id` when present, else the server `id`. */
export function messageKey(message: MessageIdentity): string {
  return message.client_id || message.id;
}

/** `sent_at` as epoch ms; a missing/invalid timestamp sorts first (0). */
export function sentAtMs(message: MessageIdentity): number {
  const parsed = Date.parse(message.sent_at);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Stable chronological order (ties keep the caller's insertion order). */
export function sortBySentAt<T extends MessageIdentity>(messages: readonly T[]): T[] {
  return [...messages].sort((a, b) => sentAtMs(a) - sentAtMs(b));
}

/** O(1) lookup by canonical identity. */
export function indexByIdentity<T extends MessageIdentity>(messages: readonly T[]): Map<string, T> {
  const index = new Map<string, T>();
  for (const message of messages) index.set(messageKey(message), message);
  return index;
}

/**
 * O(1) lookup by server `id`. This is the key quoted replies and pinned
 * messages are addressed by (`parent_message_id` / `pinned_message_id` hold
 * server ids, not client ids), so it must NOT be the canonical identity.
 */
export function indexById<T extends MessageIdentity>(messages: readonly T[]): Map<string, T> {
  const index = new Map<string, T>();
  for (const message of messages) index.set(message.id, message);
  return index;
}

/**
 * Merge `incoming` into `existing` by canonical identity (an incoming copy
 * replaces an existing one for the same identity), then sort chronologically.
 * Used for delta sync and anywhere arrival order is not guaranteed.
 */
export function mergeMessages<T extends MessageIdentity>(
  existing: readonly T[],
  incoming: readonly T[],
): T[] {
  if (incoming.length === 0) return existing as T[];
  const byIdentity = indexByIdentity(existing);
  for (const message of incoming) byIdentity.set(messageKey(message), message);
  return sortBySentAt([...byIdentity.values()]);
}

/**
 * Fast append for the common realtime case: every incoming message is at or
 * after the current tail and none collides with an existing identity, so the
 * array is concatenated without a full sort. Falls back to {@link mergeMessages}
 * on clock skew or an identity collision (e.g. an echo of an optimistic row).
 */
export function appendMessages<T extends MessageIdentity>(
  existing: readonly T[],
  incoming: readonly T[],
): T[] {
  if (incoming.length === 0) return existing as T[];
  if (existing.length === 0) return mergeMessages(existing, incoming);
  const tailMs = sentAtMs(existing[existing.length - 1]);
  const existingKeys = new Set(existing.map(messageKey));
  const inOrder = incoming.every(
    (message) => sentAtMs(message) >= tailMs && !existingKeys.has(messageKey(message)),
  );
  return inOrder ? [...existing, ...incoming] : mergeMessages(existing, incoming);
}

/**
 * Prepend an older page of history, dropping duplicates. A message present in
 * both lists keeps the `existing` copy (it may carry a local edit/status that
 * the re-fetched page lacks); the result is sorted chronologically.
 */
export function prependOlder<T extends MessageIdentity>(
  existing: readonly T[],
  older: readonly T[],
): T[] {
  if (older.length === 0) return existing as T[];
  const byIdentity = indexByIdentity(existing);
  for (const message of older) {
    const key = messageKey(message);
    if (!byIdentity.has(key)) byIdentity.set(key, message);
  }
  return sortBySentAt([...byIdentity.values()]);
}

/**
 * Insert or replace a single message by canonical identity, preserving its
 * slot. This is the optimistic → server swap: the temporary row is replaced
 * in place, so a mounted row never reflows (a re-sort could move it).
 */
export function upsertMessage<T extends MessageIdentity>(
  messages: readonly T[],
  next: T,
): T[] {
  const key = messageKey(next);
  const at = messages.findIndex((message) => messageKey(message) === key);
  if (at < 0) return [...messages, next];
  const copy = messages.slice();
  copy[at] = next;
  return copy;
}
