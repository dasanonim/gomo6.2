import { beforeEach, describe, expect, it } from "vitest";
import {
  __forgetMessageScrollAnchorsInMemoryForTests,
  __resetMessageScrollAnchorsForTests,
  clearMessageScrollAnchor,
  readMessageScrollAnchor,
  writeMessageScrollAnchor,
} from "./messageScrollAnchors";

describe("messageScrollAnchors", () => {
  beforeEach(() => {
    __resetMessageScrollAnchorsForTests();
  });

  it("round-trips an anchor", () => {
    writeMessageScrollAnchor("c1", { key: "m5", offset: 12 });
    expect(readMessageScrollAnchor("c1")).toEqual({ key: "m5", offset: 12 });
  });

  it("survives a reload: the map is a cache, sessionStorage is the store", () => {
    writeMessageScrollAnchor("c1", { key: "m5", offset: 12 });

    // A reload keeps sessionStorage, not module state.
    __forgetMessageScrollAnchorsInMemoryForTests();

    expect(readMessageScrollAnchor("c1")).toEqual({ key: "m5", offset: 12 });
  });

  it("forgets the place when the reader is at the newest message", () => {
    writeMessageScrollAnchor("c1", { key: "m5", offset: 12 });
    clearMessageScrollAnchor("c1");
    __forgetMessageScrollAnchorsInMemoryForTests();

    expect(readMessageScrollAnchor("c1")).toBeUndefined();
  });

  it("keeps conversations apart", () => {
    writeMessageScrollAnchor("c1", { key: "a", offset: 1 });
    writeMessageScrollAnchor("c2", { key: "b", offset: 2 });
    __forgetMessageScrollAnchorsInMemoryForTests();

    expect(readMessageScrollAnchor("c1")?.key).toBe("a");
    expect(readMessageScrollAnchor("c2")?.key).toBe("b");
  });

  it("ignores a corrupt or foreign stored value instead of throwing", () => {
    sessionStorage.setItem("gomo6:msg-anchor:c1", "{not json");
    expect(readMessageScrollAnchor("c1")).toBeUndefined();

    sessionStorage.setItem("gomo6:msg-anchor:c2", JSON.stringify({ offset: 3 }));
    expect(readMessageScrollAnchor("c2")).toBeUndefined();
  });
});
