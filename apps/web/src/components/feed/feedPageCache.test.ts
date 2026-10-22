import { beforeEach, describe, expect, it } from "vitest";
import {
  __forgetFeedPageCacheInMemoryForTests,
  __resetFeedPageCacheForTests,
  readFeedPageCache,
  writeFeedPageCache,
} from "./feedPageCache";

describe("feed page cache", () => {
  beforeEach(() => __resetFeedPageCacheForTests());

  it("keeps the first page separate for each viewer", () => {
    writeFeedPageCache("alice", 20, [{ id: "alice-post" }], true, 100);
    writeFeedPageCache("bob", 20, [{ id: "bob-post" }], false, 100);

    expect(readFeedPageCache<{ id: string }>("alice", 20, 101)?.items[0].id).toBe("alice-post");
    expect(readFeedPageCache<{ id: string }>("bob", 20, 101)?.items[0].id).toBe("bob-post");
    expect(readFeedPageCache("guest", 20, 101)).toBeNull();
  });

  it("survives a document reload through this tab's session storage", () => {
    writeFeedPageCache("alice", 20, [{ id: "cached" }], true, 1_000);
    __forgetFeedPageCacheInMemoryForTests();

    expect(readFeedPageCache<{ id: string }>("alice", 20, 1_001)?.items).toEqual([
      { id: "cached" },
    ]);
  });

  it("drops expired entries instead of showing old feed content", () => {
    writeFeedPageCache("alice", 20, [{ id: "old" }], true, 1_000);

    expect(readFeedPageCache("alice", 20, 1_000 + 30 * 60 * 1000 + 1)).toBeNull();
  });

  it("keeps pagination metadata when storage trims an oversized response", () => {
    const items = Array.from({ length: 12 }, (_, index) => ({
      id: String(index),
      body: "x".repeat(100_000),
    }));
    writeFeedPageCache("alice", 20, items, false, 2_000);
    __forgetFeedPageCacheInMemoryForTests();

    const cached = readFeedPageCache<typeof items[number]>("alice", 20, 2_001);
    expect(cached?.items.length).toBeGreaterThan(0);
    expect(cached?.items.length).toBeLessThan(items.length);
    expect(cached?.hasMore).toBe(true);
  });
});
