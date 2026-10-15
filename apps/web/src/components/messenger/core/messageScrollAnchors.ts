/**
 * Session-scoped scroll anchor per conversation.
 *
 * The messenger store keeps only the *open* conversation's messages, so an
 * anchor lives exactly as long as the loaded range does: returning to a chat
 * restores the reader's place when the anchored message is still in memory, and
 * otherwise the list falls back to the newest message.
 *
 * The anchor is a message key plus how many pixels of that message sit above
 * the fold. `scrollTop` alone cannot serve — it points at a different message
 * as soon as any height above it changes (late media, edits, a prepend).
 */

export type MessageScrollAnchor = {
  /** Canonical message key (`client_id || id`). */
  key: string;
  /** Pixels of the anchored message hidden above the viewport top. */
  offset: number;
};

const anchors = new Map<string, MessageScrollAnchor>();

export function readMessageScrollAnchor(conversationId: string): MessageScrollAnchor | undefined {
  return anchors.get(conversationId);
}

export function writeMessageScrollAnchor(conversationId: string, anchor: MessageScrollAnchor): void {
  anchors.set(conversationId, anchor);
}

export function clearMessageScrollAnchor(conversationId: string): void {
  anchors.delete(conversationId);
}

/** Test-only hook: drop every saved anchor. */
export function __resetMessageScrollAnchorsForTests(): void {
  anchors.clear();
}
