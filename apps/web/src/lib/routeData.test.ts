import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Location } from "react-router-dom";

import {
  prefetchRouteData,
  registerRouteData,
  matchedRouteData,
  shouldPrefetch,
  hasRouteData,
  __resetRouteData,
} from "./routeData";
import { useLoadingBarStore } from "@/stores/loadingBarStore";

const location = (pathname: string): Location =>
  ({ pathname, search: "", hash: "", state: null, key: "test" }) as Location;

const setConnection = (connection: unknown): void => {
  Object.defineProperty(navigator, "connection", { configurable: true, value: connection });
};

describe("routeData", () => {
  beforeEach(() => {
    __resetRouteData();
  });

  afterEach(() => {
    delete (navigator as unknown as { connection?: unknown }).connection;
  });

  it("matches an entry by path pattern and captures params", async () => {
    const warm = vi.fn().mockResolvedValue(undefined);
    registerRouteData({ id: "profile", match: "/profile/:userId", warm });

    expect(matchedRouteData("/profile/42").map((e) => e.id)).toEqual(["profile"]);
    expect(matchedRouteData("/profile/42/wall/7")).toEqual([]);

    prefetchRouteData(location("/profile/42"));
    await vi.waitFor(() => expect(warm).toHaveBeenCalledTimes(1));
    expect(warm.mock.calls[0][0].params).toEqual({ userId: "42" });
  });

  it("warms nothing when no entry matches", async () => {
    const warm = vi.fn();
    registerRouteData({ id: "profile", match: "/profile/:userId", warm });

    prefetchRouteData(location("/unrelated"));
    await new Promise((r) => setTimeout(r, 10));
    expect(warm).not.toHaveBeenCalled();
  });

  it("shares one in-flight warm-up for concurrent identical prefetches", async () => {
    let resolve!: () => void;
    const warm = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    registerRouteData({ id: "thread", match: "/thread/:threadId", warm });

    prefetchRouteData(location("/thread/1"));
    prefetchRouteData(location("/thread/1"));
    await new Promise((r) => setTimeout(r, 10));
    expect(warm).toHaveBeenCalledTimes(1);
    resolve();
  });

  it("does not cache a failed warm forever — the next prefetch retries", async () => {
    const warm = vi.fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(undefined);
    registerRouteData({ id: "board", match: "/g/:slug", warm });

    prefetchRouteData(location("/g/test"));
    await vi.waitFor(() => expect(warm).toHaveBeenCalledTimes(1));
    // Let the rejection settle (in-flight entry released) before retrying.
    await new Promise((r) => setTimeout(r, 10));
    prefetchRouteData(location("/g/test"));
    await vi.waitFor(() => expect(warm).toHaveBeenCalledTimes(2));
  });

  it("never drives the header loading bar on intent prefetch", async () => {
    let release!: () => void;
    const warm = vi.fn(() => new Promise<void>((r) => { release = r; }));
    registerRouteData({ id: "slow", match: "/slow", warm });

    const before = useLoadingBarStore.getState().count;
    prefetchRouteData(location("/slow"));
    // Navigation is instant now — no progress reported while warming.
    expect(useLoadingBarStore.getState().count).toBe(before);
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(useLoadingBarStore.getState().count).toBe(before);
  });

  it("shows the bar when a navigation joins a bar-less intent prefetch", async () => {
    // Intent prefetch never drives the bar — navigation is instant now, and
    // the header bar belongs to the pages' own streaming loads.
    let release!: () => void;
    const warm = vi.fn(() => new Promise<void>((r) => { release = r; }));
    registerRouteData({ id: "joined", match: "/joined", warm });

    const before = useLoadingBarStore.getState().count;
    prefetchRouteData(location("/joined"));
    prefetchRouteData(location("/joined"));
    expect(useLoadingBarStore.getState().count).toBe(before);

    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(useLoadingBarStore.getState().count).toBe(before);
    expect(warm).toHaveBeenCalledTimes(1);
  });

  it("prefetchRouteData skips warming when Save-Data is on", () => {
    const warm = vi.fn();
    registerRouteData({ id: "profile", match: "/profile/:userId", warm });

    setConnection({ saveData: true });
    expect(shouldPrefetch()).toBe(false);
    prefetchRouteData(location("/profile/42"));
    expect(warm).not.toHaveBeenCalled();
  });

  it("prefetchRouteData warms on intent when the connection allows it", () => {
    const warm = vi.fn().mockResolvedValue(undefined);
    registerRouteData({ id: "profile", match: "/profile/:userId", warm });

    setConnection({ saveData: false, effectiveType: "4g" });
    expect(shouldPrefetch()).toBe(true);
    prefetchRouteData(location("/profile/42"));
    expect(warm).toHaveBeenCalledTimes(1);
  });

  it("treats 2g connections as not worth prefetching", () => {
    setConnection({ saveData: false, effectiveType: "2g" });
    expect(shouldPrefetch()).toBe(false);
    setConnection({ effectiveType: "slow-2g" });
    expect(shouldPrefetch()).toBe(false);
    setConnection({ effectiveType: "3g" });
    expect(shouldPrefetch()).toBe(true);
  });

  it("reports whether a route has a preloader", () => {
    registerRouteData({ id: "profile", match: "/profile/:userId", warm: vi.fn() });
    expect(hasRouteData("/profile/42")).toBe(true);
    expect(hasRouteData("/settings")).toBe(false);
  });

  it("stops before the next entry once a newer warm-up supersedes it", async () => {
    let releaseFirst!: () => void;
    const first = vi.fn(() => new Promise<void>((r) => { releaseFirst = r; }));
    const second = vi.fn().mockResolvedValue(undefined);
    registerRouteData({ id: "first", match: "/g/one", warm: first });
    registerRouteData({ id: "second", match: "/g/one", warm: second });
    registerRouteData({ id: "other", match: "/g/two", warm: vi.fn().mockResolvedValue(undefined) });

    prefetchRouteData(location("/g/one"));
    // A newer warm-up bumps the token before the first entry settles.
    prefetchRouteData(location("/g/two"));
    releaseFirst();
    await new Promise((r) => setTimeout(r, 10));

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });
});
