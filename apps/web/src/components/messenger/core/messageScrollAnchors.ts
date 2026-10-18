/**
 * Scroll anchor per conversation, surviving a reload.
 *
 * The store keeps only the *open* conversation's messages, so an anchor lives
 * exactly as long as the loaded range does: returning to a chat restores the
 * reader's place when the anchored message is still in memory, and otherwise the
 * list falls back to the newest message.
 *
 * The anchor is a message key plus how many pixels of that message sit above
 * the fold. `scrollTop` alone cannot serve — it points at a different message
 * as soon as any height above it changes (late media, edits, a prepend).
 *
 * Persistence: the module map is a cache, `sessionStorage` is the store. A phone
 * that reloads the PWA (or a desktop tab that is refreshed) keeps the place it
 * was reading, which is what Telegram Web does with its persisted scroll offset
 * and saved viewport. Session storage, not local: two tabs on different messages
 * of the same chat must not fight over one entry, and the entry is worthless
 * once the tab is gone.
 */

export type MessageScrollAnchor = {
  /** Canonical message key (`client_id || id`). */
  key: string;
  /** Pixels of the anchored message hidden above the viewport top. */
  offset: number;
};

const STORAGE_PREFIX = "gomo6:msg-anchor:";

const anchors = new Map<string, MessageScrollAnchor>();

function storageKey(conversationId: string): string {
  return `${STORAGE_PREFIX}${conversationId}`;
}

function readStored(conversationId: string): MessageScrollAnchor | undefined {
  if (typeof sessionStorage === "undefined") return undefined;
  try {
    const raw = sessionStorage.getItem(storageKey(conversationId));
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<MessageScrollAnchor>;
    if (typeof parsed?.key !== "string") return undefined;
    return { key: parsed.key, offset: typeof parsed.offset === "number" ? parsed.offset : 0 };
  } catch {
    // Storage can be unavailable (private mode quota, disabled cookies) — the
    // in-memory cache still works for this session.
    return undefined;
  }
}

function writeStored(conversationId: string, anchor: MessageScrollAnchor): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(storageKey(conversationId), JSON.stringify(anchor));
  } catch {
    // Quota or disabled storage: an unpersisted anchor is not an error.
  }
}

function removeStored(conversationId: string): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.removeItem(storageKey(conversationId));
  } catch {
    // Ignore.
  }
}

export function readMessageScrollAnchor(conversationId: string): MessageScrollAnchor | undefined {
  const cached = anchors.get(conversationId);
  if (cached) return cached;

  const stored = readStored(conversationId);
  if (stored) anchors.set(conversationId, stored);
  return stored;
}

export function writeMessageScrollAnchor(conversationId: string, anchor: MessageScrollAnchor): void {
  const existing = anchors.get(conversationId);
  if (existing && existing.key === anchor.key && existing.offset === anchor.offset) {
    // Same place as the last rest: do not touch storage again.
    return;
  }
  anchors.set(conversationId, anchor);
  writeStored(conversationId, anchor);
}

export function clearMessageScrollAnchor(conversationId: string): void {
  if (!anchors.has(conversationId) && !readStored(conversationId)) return;
  anchors.delete(conversationId);
  removeStored(conversationId);
}

/** Test-only hook: drop every saved anchor, memory and storage. */
export function __resetMessageScrollAnchorsForTests(): void {
  for (const conversationId of [...anchors.keys()]) removeStored(conversationId);
  anchors.clear();
  if (typeof sessionStorage !== "undefined") {
    try {
      for (const key of Object.keys(sessionStorage)) {
        if (key.startsWith(STORAGE_PREFIX)) sessionStorage.removeItem(key);
      }
    } catch {
      // Ignore.
    }
  }
}

/** Test-only hook: simulate a page reload (keep storage, drop module state). */
export function __forgetMessageScrollAnchorsInMemoryForTests(): void {
  anchors.clear();
}
