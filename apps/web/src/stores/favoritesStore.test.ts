import { describe, it, expect, beforeEach, vi } from "vitest";

import { useFavoritesStore } from "./favoritesStore";

const requestMock = vi.fn();
vi.mock("@/integrations/api/client", () => ({
  apiClient: { request: (...args: any[]) => requestMock(...args) },
}));

describe("favoritesStore.toggle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useFavoritesStore.getState().reset();
    requestMock.mockResolvedValue({ data: { ok: true } });
  });

  it("returns true after adding a favorite", async () => {
    const result = await useFavoritesStore.getState().toggle("thread", "t1");
    expect(result).toBe(true);
    expect(useFavoritesStore.getState().ids.has("thread:t1")).toBe(true);
  });

  it("returns false after removing a favorite", async () => {
    useFavoritesStore.setState({ ids: new Set(["thread:t1"]), loaded: true });
    const result = await useFavoritesStore.getState().toggle("thread", "t1");
    expect(result).toBe(false);
    expect(useFavoritesStore.getState().ids.has("thread:t1")).toBe(false);
  });

  it("returns the pre-click state (false) when an add fails", async () => {
    requestMock.mockRejectedValueOnce(new Error("network"));
    const result = await useFavoritesStore.getState().toggle("thread", "t1");
    expect(result).toBe(false);
    expect(useFavoritesStore.getState().ids.has("thread:t1")).toBe(false);
  });

  it("returns the pre-click state (true) when a remove fails", async () => {
    useFavoritesStore.setState({ ids: new Set(["thread:t1"]), loaded: true });
    requestMock.mockRejectedValueOnce(new Error("network"));
    const result = await useFavoritesStore.getState().toggle("thread", "t1");
    expect(result).toBe(true);
    expect(useFavoritesStore.getState().ids.has("thread:t1")).toBe(true);
  });
});
