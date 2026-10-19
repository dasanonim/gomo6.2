import { describe, it, expect, beforeEach } from "vitest";
import {
  applyReaction,
  describeChip,
  describeReactors,
  getQuickReaction,
  noteReactionUsed,
  replaceChips,
  sortChips,
} from "./reactions";
import type { ReactionSummary } from "./types";

const me = { id: "u1", username: "me" };
const peer = { id: "u2", username: "bob" };
const other = { id: "u3", username: "carol" };

const chip = (overrides: Partial<ReactionSummary> = {}): ReactionSummary => ({
  emoji: "❤️",
  count: 1,
  mine: false,
  users: [peer],
  ...overrides,
});

beforeEach(() => localStorage.clear());

describe("applyReaction", () => {
  it("adds a first reaction as my own chip", () => {
    const chips = applyReaction([], "❤️", me, "toggle", me.id);

    expect(chips).toEqual([{ emoji: "❤️", count: 1, mine: true, users: [me], mineAt: expect.any(String) }]);
  });

  it("removes my reaction on a second toggle", () => {
    const added = applyReaction([], "❤️", me, "toggle", me.id);
    const removed = applyReaction(added, "❤️", me, "toggle", me.id);

    expect(removed).toEqual([]);
  });

  it("keeps a peer's chip when I remove mine", () => {
    const start = [chip({ emoji: "🔥", count: 2, users: [me, peer], mine: true })];
    const next = applyReaction(start, "🔥", me, "toggle", me.id);

    expect(next).toEqual([{ emoji: "🔥", count: 1, mine: false, users: [peer] }]);
  });

  it("never marks my chip from someone else's delta", () => {
    const next = applyReaction([], "👍", peer, "add", me.id);

    expect(next[0]).toEqual({ emoji: "👍", count: 1, mine: false, users: [peer] });
  });

  it("marks my chip when my own delta arrives from another device", () => {
    const next = applyReaction([], "👍", me, "add", me.id);

    expect(next[0].mine).toBe(true);
  });

  it("ignores a removal of a reaction that was never there", () => {
    const start = [chip()];

    expect(applyReaction(start, "😂", peer, "remove", me.id)).toEqual(start);
  });

  it("is idempotent on a repeated add (a retried request)", () => {
    const once = applyReaction([], "🎉", peer, "add", me.id);
    const twice = applyReaction(once, "🎉", peer, "add", me.id);

    expect(twice).toEqual(once);
  });

  it("orders chips by popularity and keeps ties stable", () => {
    let chips = applyReaction([], "🔥", peer, "add", me.id);
    chips = applyReaction(chips, "❤️", peer, "add", me.id);
    chips = applyReaction(chips, "❤️", other, "add", me.id);

    expect(chips.map((entry) => entry.emoji)).toEqual(["❤️", "🔥"]);
    expect(chips[0].count).toBe(2);
  });
});

describe("the per-message cap", () => {
  it("replaces the reader's oldest reaction instead of refusing a fourth", () => {
    let chips = applyReaction([], "❤️", me, "add", me.id);
    chips = applyReaction(chips, "🔥", me, "add", me.id);
    chips = applyReaction(chips, "😂", me, "add", me.id);
    expect(chips).toHaveLength(3);

    chips = applyReaction(chips, "👍", me, "add", me.id);

    // Twitter… err, Telegram: the new one lands, the first one the reader chose
    // loses its owner.
    expect(chips).toHaveLength(3);
    expect(chips.map((chip) => chip.emoji).sort()).toEqual(["😂", "👍", "🔥"].sort());
    expect(chips.every((chip) => chip.mine)).toBe(true);
  });

  it("keeps a peer's reaction when the reader's own chip is evicted", () => {
    // ❤️ is shared with a peer and was the reader's first choice.
    let chips = applyReaction([], "❤️", me, "add", me.id);
    chips = applyReaction(chips, "❤️", peer, "add", me.id);
    chips = applyReaction(chips, "🔥", me, "add", me.id);
    chips = applyReaction(chips, "😂", me, "add", me.id);

    chips = applyReaction(chips, "👍", me, "add", me.id);

    const heart = chips.find((chip) => chip.emoji === "❤️");
    // The viewer's row is gone (it was the oldest); the peer's stays.
    expect(heart).toEqual({ emoji: "❤️", count: 1, mine: false, users: [peer] });
    expect(chips.filter((chip) => chip.mine)).toHaveLength(3);
  });

  it("never evicts on a peer's delta", () => {
    let chips = applyReaction([], "❤️", me, "add", me.id);
    chips = applyReaction(chips, "🔥", me, "add", me.id);
    chips = applyReaction(chips, "😂", me, "add", me.id);
    chips = applyReaction(chips, "😮", peer, "add", me.id);

    expect(chips).toHaveLength(4);
    expect(chips.filter((chip) => chip.mine)).toHaveLength(3);
    expect(chips.find((chip) => chip.emoji === "😮")?.mine).toBe(false);
  });
});

describe("sortChips / replaceChips", () => {
  it("sorts by count and does not mutate the input", () => {
    const input = [
      chip({ emoji: "😂", count: 1 }),
      chip({ emoji: "❤️", count: 3 }),
      chip({ emoji: "🔥", count: 1 }),
    ];
    const sorted = sortChips(input);

    expect(sorted.map((entry) => entry.emoji)).toEqual(["❤️", "😂", "🔥"]);
    expect(input.map((entry) => entry.emoji)).toEqual(["😂", "❤️", "🔥"]);
  });

  it("turns a missing server list into an empty array", () => {
    expect(replaceChips(undefined)).toEqual([]);
  });
});

describe("the quick reaction", () => {
  it("defaults to ❤️", () => {
    expect(getQuickReaction()).toBe("❤️");
  });

  it("remembers the last used reaction", () => {
    noteReactionUsed("🔥");
    expect(getQuickReaction()).toBe("🔥");
  });

  it("falls back to the default when the stored value is not a reaction", () => {
    localStorage.setItem("gomo6:reactions:recent", "not-an-emoji");
    expect(getQuickReaction()).toBe("❤️");
  });
});

describe("labels", () => {
  it("names the viewer as «Вы»", () => {
    const entry = chip({ count: 2, users: [me, peer] });

    expect(describeReactors(entry, me.id)).toBe("Вы, bob");
    expect(describeChip({ ...entry, mine: true }, me.id)).toBe("❤️ 2: Вы, bob (ваша реакция)");
  });

  it("summarises a crowd", () => {
    const entry = chip({ count: 5, users: [peer, other, { id: "u4", username: "dan" }] });

    expect(describeReactors(entry, me.id)).toBe("bob, carol, dan");
  });
});
