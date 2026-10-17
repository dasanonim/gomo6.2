import { describe, expect, it } from "vitest";
import {
  ANCHOR_AFTER,
  ANCHOR_BEFORE,
  INITIAL_WINDOW,
  MAX_DOM_MESSAGES,
  RESET_WINDOW,
  TAIL_WINDOW,
  aroundSlice,
  buildKeyIndex,
  clampSlice,
  resolveKeyWindow,
  sameKeyWindow,
  sliceSize,
  tailKeyWindow,
  tailSlice,
  trimBottom,
} from "./slicing";

const message = (id: string, client_id?: string) => ({ id, client_id, sent_at: "2026-08-08T12:00:00.000Z" });
const list = (count: number) => Array.from({ length: count }, (_, i) => message(`m${i}`));

describe("slicing — tailSlice", () => {
  it("mounts the newest window of a long history", () => {
    expect(tailSlice(10_000)).toEqual({ start: 10_000 - INITIAL_WINDOW, end: 10_000 });
  });

  it("mounts everything when the history is shorter than the window", () => {
    expect(tailSlice(12)).toEqual({ start: 0, end: 12 });
  });

  it("is empty for an empty history", () => {
    expect(tailSlice(0)).toEqual({ start: 0, end: 0 });
  });
});

describe("slicing — tailKeyWindow", () => {
  it("describes the newest window in keys, still following the tail", () => {
    expect(tailKeyWindow(list(500))).toEqual({ first: `m${500 - INITIAL_WINDOW}`, last: null });
  });

  it("supports a smaller reset window for a jump to the bottom", () => {
    expect(tailKeyWindow(list(500), RESET_WINDOW)).toEqual({ first: `m${500 - RESET_WINDOW}`, last: null });
  });

  it("is the empty window for an empty history", () => {
    expect(tailKeyWindow([])).toEqual(TAIL_WINDOW);
  });
});

describe("slicing — aroundSlice", () => {
  it("mounts a target with runway on both sides", () => {
    const slice = aroundSlice(500, 1000);
    expect(slice.start).toBe(500 - ANCHOR_BEFORE);
    expect(slice.end).toBe(500 + ANCHOR_AFTER);
  });

  it("clamps at the newest edge", () => {
    expect(aroundSlice(999, 1000)).toEqual({ start: 999 - ANCHOR_BEFORE, end: 1000 });
  });

  it("clamps at the oldest edge", () => {
    expect(aroundSlice(0, 1000)).toEqual({ start: 0, end: ANCHOR_AFTER });
  });

  it("handles an empty history", () => {
    expect(aroundSlice(3, 0)).toEqual({ start: 0, end: 0 });
  });
});

describe("slicing — clampSlice / sliceSize", () => {
  it("clamps to the array bounds", () => {
    expect(clampSlice({ start: -5, end: 40 }, 10)).toEqual({ start: 0, end: 10 });
  });

  it("caps the mounted window at the ceiling", () => {
    expect(clampSlice({ start: 0, end: 1000 }, 5000)).toEqual({ start: 0, end: MAX_DOM_MESSAGES });
  });

  it("measures the mounted row count", () => {
    expect(sliceSize({ start: 10, end: 40 })).toBe(30);
    expect(sliceSize({ start: 40, end: 10 })).toBe(0);
  });
});

describe("slicing — resolveKeyWindow", () => {
  const messages = list(200);
  const index = buildKeyIndex(messages);

  it("treats a null first as the tail window", () => {
    expect(resolveKeyWindow(TAIL_WINDOW, index, messages.length)).toEqual(tailSlice(200));
  });

  it("mounts through the store tail when last is null", () => {
    expect(resolveKeyWindow({ first: "m40", last: null }, index, messages.length)).toEqual({
      start: 40,
      end: 200,
    });
  });

  it("resolves an explicit key range", () => {
    expect(resolveKeyWindow({ first: "m40", last: "m89" }, index, messages.length)).toEqual({
      start: 40,
      end: 90,
    });
  });

  it("survives a prepend because it is keyed, not indexed", () => {
    // 50 older messages land above the window: the same keys now start 50 rows
    // later, so the mounted message set is unchanged.
    const prepended = [...list(50).map((m) => message(`older${m.id}`)), ...messages];
    const nextIndex = buildKeyIndex(prepended);
    expect(resolveKeyWindow({ first: "m40", last: "m89" }, nextIndex, prepended.length)).toEqual({
      start: 90,
      end: 140,
    });
  });

  it("reports an unresolvable window when the keys are gone", () => {
    expect(resolveKeyWindow({ first: "gone", last: "m89" }, index, messages.length)).toBeNull();
    expect(resolveKeyWindow({ first: "m40", last: "gone" }, index, messages.length)).toBeNull();
  });

  it("treats an inverted or empty range as unresolvable", () => {
    expect(resolveKeyWindow({ first: "m89", last: "m40" }, index, messages.length)).toBeNull();
  });

  it("is empty for an empty history", () => {
    expect(resolveKeyWindow(TAIL_WINDOW, new Map(), 0)).toEqual({ start: 0, end: 0 });
  });

  it("uses the canonical identity, not the server id", () => {
    const optimistic = [message("server-1", "local-1")];
    const optimisticIndex = buildKeyIndex(optimistic);
    expect(resolveKeyWindow({ first: "local-1", last: null }, optimisticIndex, 1)).toEqual({
      start: 0,
      end: 1,
    });
  });
});

describe("slicing — trimBottom", () => {
  const messages = list(500);

  it("does nothing at or below the ceiling", () => {
    expect(trimBottom(messages, 0, MAX_DOM_MESSAGES)).toBeNull();
    expect(trimBottom(messages, 100, 200)).toBeNull();
  });

  it("drops the rows below the ceiling and reports the new tail key", () => {
    expect(trimBottom(messages, 0, 400)).toEqual({ end: MAX_DOM_MESSAGES, last: `m${MAX_DOM_MESSAGES - 1}` });
  });

  it("keeps the window's start when it has slid away from zero", () => {
    expect(trimBottom(messages, 100, 600)).toEqual({ end: 400, last: "m399" });
  });
});

describe("slicing — sameKeyWindow", () => {
  it("compares by key", () => {
    expect(sameKeyWindow(TAIL_WINDOW, { first: null, last: null })).toBe(true);
    expect(sameKeyWindow({ first: "a", last: null }, { first: "a", last: "b" })).toBe(false);
  });
});
