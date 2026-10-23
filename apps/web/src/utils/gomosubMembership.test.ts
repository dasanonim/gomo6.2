import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getMyGomosubMembership,
  invalidateGomosubMembership,
  resetGomosubMembershipCache,
} from "./gomosubMembership";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", (...args: unknown[]) => mockFetch(...args));

const row = { id: "m1", board_id: "b1", user_id: "u1", role_id: "member" };

function respondWith(rows: unknown[]): void {
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ success: true, data: rows }),
  });
}

describe("getMyGomosubMembership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetGomosubMembershipCache();
  });

  it("returns null without ids and fires no request", async () => {
    expect(await getMyGomosubMembership("", "u1")).toBeNull();
    expect(await getMyGomosubMembership("b1", "")).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns the membership row", async () => {
    respondWith([row]);
    expect(await getMyGomosubMembership("b1", "u1")).toEqual(row);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("returns null when not a member", async () => {
    respondWith([]);
    expect(await getMyGomosubMembership("b1", "u1")).toBeNull();
  });

  it("collapses concurrent readers onto one request", async () => {
    respondWith([row]);
    const [a, b, c] = await Promise.all([
      getMyGomosubMembership("b1", "u1"),
      getMyGomosubMembership("b1", "u1"),
      getMyGomosubMembership("b1", "u1"),
    ]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect([a, b, c]).toEqual([row, row, row]);
  });

  it("reuses a fresh snapshot", async () => {
    respondWith([row]);
    await getMyGomosubMembership("b1", "u1");
    await getMyGomosubMembership("b1", "u1");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("refetches after invalidation", async () => {
    respondWith([row]);
    await getMyGomosubMembership("b1", "u1");
    invalidateGomosubMembership("b1", "u1");
    await getMyGomosubMembership("b1", "u1");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("invalidation is scoped to the board", async () => {
    respondWith([row]);
    await getMyGomosubMembership("b1", "u1");
    await getMyGomosubMembership("b2", "u1");
    invalidateGomosubMembership("b1", "u1");
    await getMyGomosubMembership("b1", "u1");
    await getMyGomosubMembership("b2", "u1");
    // b1 refetched, b2 served from cache: 2 initial + 1 refetch.
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});
