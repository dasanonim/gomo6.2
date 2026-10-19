import type { ReactionSummary, ReactionUser } from "./types";

// ─── Message reactions ──────────────────────────────────────────────────────
// The chips are a pure fold over deltas: the server sends `add`/`remove` events
// (and the full chip list for a page or a toggle), the client folds them.
// Everything here is pure so the optimistic path and the realtime path share
// exactly one implementation.

/**
 * Telegram's quick set: the bar above the message on a long-press, and the
 * first entry is what a double-tap applies. The server accepts any emoji; a
 * curated set is what the bar shows (Telegram's own picker is server-defined
 * too, not the full keyboard).
 */
export const QUICK_REACTIONS = ["❤️", "🔥", "😂", "👍", "😮", "😢", "🎉"] as const;

/** The "more" grid: the rest of the everyday set, in reading order. */
export const REACTION_SET = [
  "❤️", "🔥", "😂", "👍", "😮", "😢", "🎉",
  "😍", "🤔", "🙈", "💯", "👏", "🙏", "🫶",
  "😎", "🤝", "💔", "😡", "🤯", "🥰", "😴",
  "🤪", "🤮", "🥳", "😇", "🫡", "👀", "⚡",
] as const;

const RECENT_KEY = "gomo6:reactions:recent";
const DEFAULT_QUICK_REACTION = "❤️";

function readRecent(): string | null {
  try {
    const value = localStorage.getItem(RECENT_KEY);
    if (!value) return null;
    return (REACTION_SET as readonly string[]).includes(value) ? value : null;
  } catch {
    return null;
  }
}

/** The reaction a double-tap applies: the last one the reader used, else ❤️. */
export function getQuickReaction(): string {
  return readRecent() ?? DEFAULT_QUICK_REACTION;
}

/** Remembers the reaction the reader used, for the next double-tap. */
export function noteReactionUsed(emoji: string): void {
  try {
    localStorage.setItem(RECENT_KEY, emoji);
  } catch {
    /* private mode — the default still works */
  }
}

/**
 * Popularity first, then the order the chips first appeared. Mirrors the
 * server's order so an optimistic list and a server list look the same.
 */
export function sortChips(chips: ReactionSummary[]): ReactionSummary[] {
  return chips
    .map((chip, index) => ({ chip, index }))
    .sort((a, b) => (b.chip.count - a.chip.count) || (a.index - b.index))
    .map(({ chip }) => chip);
}

function hasUser(chip: ReactionSummary, userId: string): boolean {
  return chip.users.some((user) => user.id === userId);
}

/**
 * Folds one reaction into a chip list.
 *
 * - `add` / `remove` are the realtime semantics (an event happened);
 * - `toggle` is the local one (the reader tapped a chip): remove if the viewer
 *   is already there, add otherwise — the same rule the server uses;
 * - `mine` is recomputed from the reactor list, never carried over, so a peer's
 *   event can never mark the viewer's own chip.
 */
export function applyReaction(
  chips: ReactionSummary[] | undefined,
  emoji: string,
  user: ReactionUser,
  action: "add" | "remove" | "toggle",
  viewerId: string,
): ReactionSummary[] {
  const list = chips ? [...chips] : [];
  const index = list.findIndex((chip) => chip.emoji === emoji);
  const existing = index >= 0 ? list[index] : null;
  const present = existing ? hasUser(existing, user.id) : false;
  const resolved: "add" | "remove" = action === "toggle" ? (present ? "remove" : "add") : action;

  if (resolved === "add") {
    if (!existing) {
      list.push({ emoji, count: 1, mine: viewerId === user.id, users: [user] });
      return sortChips(list);
    }
    if (present) {
      // A repeated add (a retried request): only the flag can be stale.
      if (existing.mine === hasUser(existing, viewerId)) return list;
      list[index] = { ...existing, mine: hasUser(existing, viewerId) };
      return sortChips(list);
    }
    const users = [...existing.users, user];
    list[index] = {
      ...existing,
      count: users.length,
      users,
      mine: hasUser({ ...existing, users }, viewerId),
    };
    return sortChips(list);
  }

  if (!existing || !present) return list;
  const users = existing.users.filter((entry) => entry.id !== user.id);
  if (users.length === 0) {
    list.splice(index, 1);
    return list;
  }
  list[index] = {
    ...existing,
    count: users.length,
    users,
    mine: hasUser({ ...existing, users }, viewerId),
  };
  return sortChips(list);
}

/** Replaces a message's chips with the server's authoritative list. */
export function replaceChips(next: ReactionSummary[] | undefined): ReactionSummary[] {
  return next ? sortChips(next) : [];
}

/** The people behind a chip, as a readable "who reacted" line. */
export function describeReactors(chip: ReactionSummary, viewerId: string): string {
  const names = chip.users.map((user) => (user.id === viewerId ? "Вы" : user.username || "Кто-то"));
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 3).join(", ")} и ещё ${names.length - 3}`;
}

/** How the chip reads to a screen reader. */
export function describeChip(chip: ReactionSummary, viewerId: string): string {
  const who = describeReactors(chip, viewerId);
  return `${chip.emoji} ${chip.count}: ${who}${chip.mine ? " (ваша реакция)" : ""}`;
}
