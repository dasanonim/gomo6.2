import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ProfileCacheProvider, useProfileCache } from "./ProfileCacheContext";
import { ReactNode } from "react";
import { resetProfileSummaryLoader } from "@/utils/profileSummaryLoader";
import { PROFILE_CACHE_INVALIDATE_EVENT } from "@/utils/profileCacheEvents";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", (...args: unknown[]) => mockFetch(...args));

function wrapper({ children }: { children: ReactNode }) {
  return <ProfileCacheProvider>{children}</ProfileCacheProvider>;
}

type Row = {
  id: string;
  public_id?: number | null;
  username: string;
  display_name?: string | null;
  avatar_url?: string | null;
  nickname_emoji_id?: string | null;
  is_admin?: boolean;
  roles?: string[];
  customization?: Record<string, unknown> | null;
};

function respondWith(rows: Row[]): void {
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ success: true, data: rows }),
  });
}

/** Serve each requested id from the `ids=` list (used by batching tests). */
function respondPerId(makeRow: (id: string) => Row): void {
  mockFetch.mockImplementation((url: string) => {
    const raw = url.split("ids=")[1] ?? "";
    const ids = decodeURIComponent(raw).split(",").filter(Boolean);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: ids.map(makeRow) }),
    });
  });
}

async function flushQueue(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe("ProfileCacheContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetProfileSummaryLoader();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("throws when used outside the provider", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => {
      renderHook(() => useProfileCache());
    }).toThrow("useProfileCache must be used within ProfileCacheProvider");
    consoleSpy.mockRestore();
  });

  it("getProfile returns null for an empty cache", () => {
    const { result } = renderHook(() => useProfileCache(), { wrapper });
    expect(result.current.getProfile("user-1")).toBeNull();
  });

  it("loadProfile maps the batched summary onto ProfileData", async () => {
    respondWith([
      {
        id: "11111111-1111-1111-1111-111111111111",
        public_id: 42,
        username: "alice",
        avatar_url: "av.jpg",
        nickname_emoji_id: "emoji-1",
        is_admin: true,
        roles: ["admin"],
        customization: { username_css: "color: red" },
      },
    ]);
    const { result } = renderHook(() => useProfileCache(), { wrapper });

    let data: Awaited<ReturnType<typeof result.current.loadProfile>>;
    await act(async () => {
      const pending = result.current.loadProfile("11111111-1111-1111-1111-111111111111");
      await flushQueue();
      data = await pending;
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toContain("/api/v1/profiles/summary?ids=");
    expect(data!.username).toBe("alice");
    expect(data!.isAdmin).toBe(true);
    expect(data!.avatarUrl).toBe("av.jpg");
    expect(data!.public_id).toBe(42);
    expect(data!.customization).toEqual({ username_css: "color: red" });

    const cached = result.current.getProfile("11111111-1111-1111-1111-111111111111");
    expect(cached?.username).toBe("alice");
  });

  it("coalesces every author mounted in the same tick into one request", async () => {
    respondPerId((id) => ({ id, username: id, is_admin: false }));
    const { result } = renderHook(() => useProfileCache(), { wrapper });

    await act(async () => {
      const pending = Promise.all([
        result.current.loadProfile("user-1"),
        result.current.loadProfile("user-2"),
        result.current.loadProfile("user-3"),
      ]);
      await flushQueue();
      await pending;
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("user-1");
    expect(url).toContain("user-2");
    expect(url).toContain("user-3");
  });

  it("serves a repeated load from the cache", async () => {
    respondPerId((id) => ({ id, username: id }));
    const { result } = renderHook(() => useProfileCache(), { wrapper });

    await act(async () => {
      const pending = result.current.loadProfile("user-1");
      await flushQueue();
      await pending;
    });
    await act(async () => {
      const pending = result.current.loadProfile("user-1");
      await flushQueue();
      await pending;
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("resolves a public-id lookup through the canonical row", async () => {
    respondPerId((id) => ({ id: "uuid-1", public_id: 42, username: "alice" }));
    const { result } = renderHook(() => useProfileCache(), { wrapper });

    await act(async () => {
      const pending = result.current.loadProfile("42");
      await flushQueue();
      await pending;
    });

    // The response was keyed by both the canonical uuid and the public number.
    expect(result.current.getProfile("42")?.username).toBe("alice");
    expect(result.current.getProfile("uuid-1")?.username).toBe("alice");
  });

  it("a scoped invalidation clears only the affected profile", async () => {
    respondPerId((id) => ({ id, username: id }));
    const { result } = renderHook(() => useProfileCache(), { wrapper });

    await act(async () => {
      const pending = Promise.all([
        result.current.loadProfile("user-1"),
        result.current.loadProfile("user-2"),
      ]);
      await flushQueue();
      await pending;
    });

    act(() => {
      window.dispatchEvent(
        new CustomEvent(PROFILE_CACHE_INVALIDATE_EVENT, { detail: { userId: "user-1" } }),
      );
    });

    expect(result.current.getProfile("user-1")).toBeNull();
    expect(result.current.getProfile("user-2")?.username).toBe("user-2");
  });

  it("an unscoped invalidation clears every cached profile", async () => {
    respondPerId((id) => ({ id, username: id }));
    const { result } = renderHook(() => useProfileCache(), { wrapper });

    await act(async () => {
      const pending = Promise.all([
        result.current.loadProfile("user-1"),
        result.current.loadProfile("user-2"),
      ]);
      await flushQueue();
      await pending;
    });

    act(() => {
      window.dispatchEvent(new CustomEvent(PROFILE_CACHE_INVALIDATE_EVENT));
    });

    expect(result.current.getProfile("user-1")).toBeNull();
    expect(result.current.getProfile("user-2")).toBeNull();
  });

  it("clearCache drops everything", async () => {
    respondPerId((id) => ({ id, username: id }));
    const { result } = renderHook(() => useProfileCache(), { wrapper });

    await act(async () => {
      const pending = result.current.loadProfile("user-1");
      await flushQueue();
      await pending;
    });
    act(() => result.current.clearCache());

    expect(result.current.getProfile("user-1")).toBeNull();
  });
});
