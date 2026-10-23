import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseCssToStyle,
  getProfileCustomization,
  clearCustomizationCache,
  dispatchProfileCacheInvalidate,
} from "./profileCustomization";
import { PROFILE_CACHE_INVALIDATE_EVENT } from "@/utils/profileCacheEvents";
import { resetProfileSummaryLoader } from "@/utils/profileSummaryLoader";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", (...args: unknown[]) => mockFetch(...args));

function respondWith(rows: unknown[], ok = true, status = ok ? 200 : 500): void {
  mockFetch.mockResolvedValue({
    ok,
    status,
    json: async () => ({ success: ok, data: rows }),
  });
}

const row = (customization: Record<string, unknown> | null) => ({
  id: "user-1",
  username: "alice",
  is_admin: false,
  customization,
});

describe("parseCssToStyle", () => {
  it("returns empty object for empty string", () => {
    expect(parseCssToStyle("")).toEqual({});
  });

  it("parses single color declaration", () => {
    expect(parseCssToStyle("color: red")).toEqual({ color: "red" });
  });

  it("parses multiple declarations", () => {
    const result = parseCssToStyle("color: blue; font-weight: bold");
    expect(result).toEqual({ color: "blue", fontWeight: "bold" });
  });

  it("converts kebab-case to camelCase", () => {
    expect(parseCssToStyle("font-size: 14px")).toEqual({ fontSize: "14px" });
  });

  it("handles webkit prefix", () => {
    const result = parseCssToStyle("-webkit-background-clip: text");
    expect(result).toEqual({ WebkitBackgroundClip: "text" });
  });

  it("handles webkit-text-fill-color", () => {
    const result = parseCssToStyle("-webkit-text-fill-color: transparent");
    expect(result).toEqual({ WebkitTextFillColor: "transparent" });
  });

  it("handles text-shadow", () => {
    const result = parseCssToStyle("text-shadow: 0 0 5px red");
    expect(result).toEqual({ textShadow: "0 0 5px red" });
  });

  it("handles background-color", () => {
    expect(parseCssToStyle("background-color: #fff")).toEqual({ backgroundColor: "#fff" });
  });

  it("handles border-radius", () => {
    expect(parseCssToStyle("border-radius: 8px")).toEqual({ borderRadius: "8px" });
  });

  it("skips declarations without colon", () => {
    expect(parseCssToStyle("invalid-no-colon")).toEqual({});
  });

  it("skips declarations with empty property or value", () => {
    expect(parseCssToStyle(": value; property:")).toEqual({});
  });

  it("handles values containing colons (e.g. rgba)", () => {
    const result = parseCssToStyle("background: rgba(0, 0, 0, 0.5)");
    expect(result).toEqual({ background: "rgba(0, 0, 0, 0.5)" });
  });
});

describe("getProfileCustomization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetProfileSummaryLoader();
  });

  it("reads the batched public summary, not the owner-scoped table", async () => {
    // Regression guard: /profile_customization is scoped to the caller's own
    // user_id, so a foreign id came back empty and nobody ever saw another
    // user's nickname colour.
    respondWith([row({ username_css: "color: red" })]);

    const result = await getProfileCustomization("user-1");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toContain("/api/v1/profiles/summary?ids=user-1");
    expect(result).toEqual({ username_css: "color: red" });
  });

  it("returns null when the summary has no row", async () => {
    respondWith([]);

    const result = await getProfileCustomization("user-1");
    expect(result).toBeNull();
  });

  it("caches the result on subsequent calls", async () => {
    respondWith([row({ username_css: "color: blue" })]);

    await getProfileCustomization("user-1");
    await getProfileCustomization("user-1");

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("deduplicates concurrent requests for the same user", async () => {
    respondWith([row({ username_css: "color: red" })]);

    await Promise.all([
      getProfileCustomization("user-1"),
      getProfileCustomization("user-1"),
      getProfileCustomization("user-1"),
    ]);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("batches different users mounted in the same tick", async () => {
    mockFetch.mockImplementation((url: string) => {
      const ids = decodeURIComponent(url.split("ids=")[1] ?? "").split(",");
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: ids.map((id) => ({ id, username: id, is_admin: false, customization: { username_css: "color: red" } })),
        }),
      });
    });

    await Promise.all([
      getProfileCustomization("user-1"),
      getProfileCustomization("user-2"),
      getProfileCustomization("user-3"),
    ]);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("user-1");
    expect(url).toContain("user-2");
    expect(url).toContain("user-3");
  });

  it("re-fetches once the cached entry passes its TTL", async () => {
    respondWith([row({ username_css: "color: blue" })]);

    // Only Date is faked, so the flush timer still settles normally.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await getProfileCustomization("user-1");
      expect(mockFetch).toHaveBeenCalledTimes(1);

      vi.setSystemTime(Date.now() + 4 * 60 * 1000);
      await getProfileCustomization("user-1");
      expect(mockFetch).toHaveBeenCalledTimes(1);

      vi.setSystemTime(Date.now() + 6 * 60 * 1000);
      await getProfileCustomization("user-1");
      expect(mockFetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops the cached entry when the profile is invalidated", async () => {
    respondWith([row({ username_css: "color: red" })]);

    await getProfileCustomization("user-1");
    dispatchProfileCacheInvalidate("user-1");
    await getProfileCustomization("user-1");

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe("clearCustomizationCache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetProfileSummaryLoader();
  });

  it("clears a specific user from cache", async () => {
    respondWith([row({ username_css: null })]);

    await getProfileCustomization("user-1");
    clearCustomizationCache("user-1");
    await getProfileCustomization("user-1");

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("clears the whole cache when no userId is given", async () => {
    respondWith([row({ username_css: null })]);

    await getProfileCustomization("user-1");
    clearCustomizationCache();
    await getProfileCustomization("user-1");

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe("dispatchProfileCacheInvalidate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetProfileSummaryLoader();
  });

  it("dispatches a scoped event and clears the cached entry", async () => {
    respondWith([row({ username_css: null })]);
    const listener = vi.fn();
    window.addEventListener(PROFILE_CACHE_INVALIDATE_EVENT, listener);

    await getProfileCustomization("user-1");
    dispatchProfileCacheInvalidate("user-1");

    expect(listener).toHaveBeenCalledTimes(1);
    const event = listener.mock.calls[0][0] as CustomEvent;
    expect(event.detail).toEqual({ userId: "user-1" });

    window.removeEventListener(PROFILE_CACHE_INVALIDATE_EVENT, listener);
  });
});
