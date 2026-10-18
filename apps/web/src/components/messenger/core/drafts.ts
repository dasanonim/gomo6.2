/**
 * Composer drafts, per conversation.
 *
 * A draft belongs to a chat, not to the composer component: typing in one
 * conversation and switching to another must not carry the text over, and coming
 * back must not have lost it. Telegram keeps drafts and syncs them across
 * devices; here they live in `localStorage` per conversation — enough to survive
 * a reload or a relaunch of the PWA, and to keep two tabs from overwriting each
 * other's text in *different* chats (same chat in two tabs is last-writer-wins,
 * which is the same thing Telegram's own single-state store does).
 *
 * Kept out of the messenger store on purpose: it is a small, self-contained
 * persistence detail with no server counterpart, and the store is already the
 * hot path for messages.
 */

const STORAGE_PREFIX = "gomo6:draft:";
/** Telegram's own limit is generous; match the composer's send limit. */
const MAX_DRAFT_LENGTH = 4000;
/** How often a keystroke may touch storage. */
const FLUSH_DELAY_MS = 400;

const memory = new Map<string, string>();
const pending = new Map<string, string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function storageKey(conversationId: string): string {
  return `${STORAGE_PREFIX}${conversationId}`;
}

function flush(): void {
  flushTimer = null;
  for (const [conversationId, text] of pending) {
    try {
      if (text) localStorage.setItem(storageKey(conversationId), text);
      else localStorage.removeItem(storageKey(conversationId));
    } catch {
      // Storage unavailable (private mode, quota): the memory map still holds
      // the text for this session.
    }
  }
  pending.clear();
}

export function readDraft(conversationId: string): string {
  const cached = memory.get(conversationId);
  if (cached !== undefined) return cached;
  if (typeof localStorage === "undefined") return "";
  try {
    const stored = localStorage.getItem(storageKey(conversationId)) ?? "";
    if (stored) memory.set(conversationId, stored);
    return stored;
  } catch {
    return "";
  }
}

export function writeDraft(conversationId: string, text: string): void {
  const trimmed = text.length > MAX_DRAFT_LENGTH ? text.slice(0, MAX_DRAFT_LENGTH) : text;
  if (memory.get(conversationId) === trimmed && !pending.has(conversationId)) return;

  memory.set(conversationId, trimmed);
  pending.set(conversationId, trimmed);

  // A keystroke is not worth a synchronous storage write; the composer is the
  // most latency-sensitive surface in the app.
  if (flushTimer === null) {
    flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
  }
}

export function clearDraft(conversationId: string): void {
  writeDraft(conversationId, "");
}

/** Flush immediately (used before a full navigation / on unmount). */
export function flushDrafts(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flush();
}

/** Test-only hook: simulate a reload (keep storage, drop module state). */
export function __forgetDraftsInMemoryForTests(): void {
  pending.clear();
  memory.clear();
}

/** Test-only hook: drop everything, memory and storage. */
export function __resetDraftsForTests(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  pending.clear();
  memory.clear();
  if (typeof localStorage === "undefined") return;
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(STORAGE_PREFIX)) localStorage.removeItem(key);
    }
  } catch {
    // Ignore.
  }
}
