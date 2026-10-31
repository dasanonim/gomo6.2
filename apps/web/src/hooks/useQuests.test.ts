import { renderHook, act, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useQuests, type ToppedUpLevel } from "./useQuests";
import { eventManager } from "@/services/eventManager";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

vi.mock("@/services/eventManager", () => {
  const handlers = new Set<(m: { data?: unknown }) => void>();
  return {
    eventManager: {
      on: (_type: string, h: (m: { data?: unknown }) => void) => {
        handlers.add(h);
        return () => {
          handlers.delete(h);
        };
      },
      __emit: (m: { data?: unknown }) => {
        handlers.forEach((h) => h(m));
      },
    },
  };
});

function emitNotification(data: unknown) {
  (eventManager as unknown as { __emit: (m: { data?: unknown }) => void }).__emit({ data });
}

const PROGRESS = {
  user_id: "u1",
  drops: 30,
  unclaimed_count: 1,
  quests: [
    {
      group_key: "qs_avatar",
      title_key: "t",
      category: "profile",
      track: "first_steps",
      icon: "smile",
      sort_order: 1,
      current_level: 1,
      progress_current: 1,
      levels: [
        {
          level: 1,
          threshold: 1,
          name_key: "k",
          description_key: "d",
          rewards: [{ kind: "drops", amount: 20 }],
          completed: true,
          claimed: false,
          can_claim: true,
        },
      ],
    },
  ],
  chests: [],
};

function ok(data: unknown) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: () => Promise.resolve({ success: true, data }),
    text: () => Promise.resolve(JSON.stringify({ success: true, data })),
  };
}

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockImplementation(() => Promise.resolve(ok(PROGRESS)));
});

describe("useQuests", () => {
  it("loads progress once and derives unclaimed from quests", async () => {
    const { result } = renderHook(() => useQuests("u1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.drops).toBe(30);
    expect(result.current.unclaimedCount).toBe(1);
    expect(mockFetch.mock.calls.filter(([u]) => String(u).includes("/quests/progress")).length).toBe(1);
  });

  it("applyClaim patches the level and drops without refetching", async () => {
    const { result } = renderHook(() => useQuests("u1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    mockFetch.mockClear();

    act(() => {
      result.current.applyClaim("qs_avatar", 1, [{ kind: "drops", amount: 20 }]);
    });

    const lvl = result.current.quests[0].levels[0];
    expect(lvl.claimed).toBe(true);
    expect(lvl.can_claim).toBe(false);
    expect(result.current.unclaimedCount).toBe(0);
    expect(result.current.drops).toBe(50);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("applyChestOpen drops the chest and adds drops without refetching", async () => {
    const { result } = renderHook(() => useQuests("u1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    mockFetch.mockClear();

    act(() => {
      result.current.applyChestOpen("missing-id", 40);
    });
    expect(result.current.drops).toBe(70);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("reloads on achievement_unlock for the viewed user (debounced)", async () => {
    const { result, unmount } = renderHook(() => useQuests("u1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    mockFetch.mockClear();

    // чужой анлок и посторонние типы страницу не трогают
    act(() => {
      emitNotification({ type: "achievement_unlock", user_id: "someone-else" });
      emitNotification({ type: "like", user_id: "u1" });
    });
    await new Promise((r) => setTimeout(r, 900));
    expect(mockFetch).not.toHaveBeenCalled();

    // свой анлок — один фоновый рефетч на пачку событий
    act(() => {
      emitNotification({ type: "achievement_unlock", user_id: "u1" });
      emitNotification({ type: "achievement_unlock", user_id: "u1" });
    });
    await waitFor(
      () => expect(mockFetch.mock.calls.filter(([u]) => String(u).includes("/quests/progress")).length).toBe(1),
      { timeout: 3000 },
    );
    unmount();
  });

  it("surfaces recalc flags and tops up via reconcile", async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(ok({ ...PROGRESS, recalc_available: true, catalog_updated_at: "2026-10-31T00:00:00Z" })),
    );
    const { result } = renderHook(() => useQuests("u1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.recalcAvailable).toBe(true);
    expect(result.current.catalogUpdatedAt).toBe("2026-10-31T00:00:00Z");

    mockFetch.mockImplementation((url: string) =>
      String(url).includes("/quests/reconcile")
        ? Promise.resolve(
            ok({
              topped_up: [
                {
                  group_key: "entries",
                  level: 1,
                  granted: [
                    { kind: "drops", amount: 15 },
                    { kind: "chest", chest_id: "c1", mechanic: "rarity_chest" },
                  ],
                },
              ],
            }),
          )
        : Promise.resolve(ok(PROGRESS)),
    );
    let topped: ToppedUpLevel[] = [];
    await act(async () => {
      topped = await result.current.reconcile();
    });
    expect(topped).toHaveLength(1);

    act(() => {
      result.current.applyRecalc(topped);
    });
    expect(result.current.drops).toBe(45);
    expect(result.current.chests).toHaveLength(1);
    expect(result.current.chests[0].id).toBe("c1");
    expect(result.current.recalcAvailable).toBe(false);
  });
});
