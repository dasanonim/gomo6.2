import { describe, it, expect } from "vitest";
import {
  appendMessages,
  indexById,
  indexByIdentity,
  mergeMessages,
  messageKey,
  prependOlder,
  sentAtMs,
  sortBySentAt,
  upsertMessage,
  type MessageIdentity,
} from "./messageModel";

type M = MessageIdentity & { content?: string };

const msg = (id: string, sent_at: string, client_id?: string | null): M => ({ id, sent_at, client_id });
const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();

describe("messageKey", () => {
  it("prefers the client id so an optimistic row and its echo share a slot", () => {
    expect(messageKey(msg("uuid-1", at(1), "c1"))).toBe("c1");
    expect(messageKey(msg("temp_c1", at(1), "c1"))).toBe("c1");
  });

  it("falls back to the server id when there is no client id", () => {
    expect(messageKey(msg("uuid-1", at(1)))).toBe("uuid-1");
    expect(messageKey(msg("uuid-1", at(1), ""))).toBe("uuid-1");
    expect(messageKey(msg("uuid-1", at(1), null))).toBe("uuid-1");
  });
});

describe("sentAtMs", () => {
  it("parses valid timestamps", () => {
    expect(sentAtMs(msg("a", at(3)))).toBe(Date.UTC(2026, 0, 1, 0, 0, 3));
  });

  it("treats an invalid timestamp as 0 (sorts first, never NaN)", () => {
    expect(sentAtMs(msg("a", "not-a-date"))).toBe(0);
    expect(sentAtMs(msg("a", ""))).toBe(0);
  });
});

describe("sortBySentAt", () => {
  it("orders chronologically", () => {
    const out = sortBySentAt([msg("c", at(3)), msg("a", at(1)), msg("b", at(2))]);
    expect(out.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("is stable on ties (caller's order wins)", () => {
    const out = sortBySentAt([msg("first", at(5)), msg("second", at(5)), msg("third", at(5))]);
    expect(out.map((m) => m.id)).toEqual(["first", "second", "third"]);
  });
});

describe("indexByIdentity / indexById", () => {
  const list = [msg("uuid-1", at(1), "c1"), msg("uuid-2", at(2))];

  it("keys the identity index by client_id || id", () => {
    const index = indexByIdentity(list);
    expect(index.get("c1")?.id).toBe("uuid-1");
    expect(index.get("uuid-2")?.id).toBe("uuid-2");
  });

  it("keys the id index by the server id (quotes/pins address these)", () => {
    const index = indexById(list);
    expect(index.get("uuid-1")?.id).toBe("uuid-1");
    expect(index.get("uuid-2")?.id).toBe("uuid-2");
    // The canonical key of the first message is its client id, not its uuid.
    expect(index.get("c1")).toBeUndefined();
  });
});

describe("mergeMessages", () => {
  it("dedupes by identity, an incoming copy wins, and sorts", () => {
    const existing = [msg("uuid-1", at(1), "c1"), msg("uuid-2", at(3))];
    const incoming = [{ ...msg("uuid-1", at(1), "c1"), content: "edited" }, msg("uuid-0", at(0))];
    const out = mergeMessages(existing, incoming);
    expect(out.map((m) => m.id)).toEqual(["uuid-0", "uuid-1", "uuid-2"]);
    expect(out[1].content).toBe("edited");
  });

  it("returns the same array when there is nothing to merge", () => {
    const existing = [msg("a", at(1))];
    expect(mergeMessages(existing, [])).toBe(existing);
  });

  it("keeps tie order stable", () => {
    const out = mergeMessages([msg("a", at(5))], [msg("b", at(5))]);
    expect(out.map((m) => m.id)).toEqual(["a", "b"]);
  });
});

describe("appendMessages", () => {
  it("concatenates in-order messages without re-sorting", () => {
    const existing = [msg("a", at(1)), msg("b", at(2))];
    const out = appendMessages(existing, [msg("c", at(3)), msg("d", at(4))]);
    expect(out.map((m) => m.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("falls back to a merge on clock skew (out-of-order arrival)", () => {
    const existing = [msg("a", at(1)), msg("c", at(3))];
    const out = appendMessages(existing, [msg("b", at(2))]);
    expect(out.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("falls back to a merge when an identity collides", () => {
    const existing = [msg("uuid-1", at(1), "c1")];
    const out = appendMessages(existing, [{ ...msg("uuid-1", at(1), "c1"), content: "echo" }]);
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe("echo");
  });

  it("handles an empty existing list", () => {
    const out = appendMessages([], [msg("a", at(2)), msg("b", at(1))]);
    expect(out.map((m) => m.id)).toEqual(["b", "a"]);
  });
});

describe("prependOlder", () => {
  it("prepends history and sorts", () => {
    const existing = [msg("c", at(3)), msg("d", at(4))];
    const out = prependOlder(existing, [msg("a", at(1)), msg("b", at(2))]);
    expect(out.map((m) => m.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("drops duplicates and keeps the existing (fresher) copy", () => {
    const existing = [{ ...msg("c", at(3)), content: "current" }];
    const out = prependOlder(existing, [{ ...msg("c", at(3)), content: "stale" }, msg("b", at(2))]);
    expect(out.map((m) => m.id)).toEqual(["b", "c"]);
    expect(out[1].content).toBe("current");
  });

  it("returns the same array when there is no older page", () => {
    const existing = [msg("a", at(1))];
    expect(prependOlder(existing, [])).toBe(existing);
  });
});

describe("upsertMessage", () => {
  it("replaces a temporary row in place (no reflow)", () => {
    const existing = [msg("a", at(1)), msg("temp_c2", at(2), "c2"), msg("b", at(3))];
    const out = upsertMessage(existing, { ...msg("uuid-c2", at(2), "c2"), content: "sent" });
    expect(out.map((m) => m.id)).toEqual(["a", "uuid-c2", "b"]);
    expect(out[1].content).toBe("sent");
  });

  it("appends when the identity is unknown", () => {
    const out = upsertMessage([msg("a", at(1))], msg("b", at(2)));
    expect(out.map((m) => m.id)).toEqual(["a", "b"]);
  });
});
