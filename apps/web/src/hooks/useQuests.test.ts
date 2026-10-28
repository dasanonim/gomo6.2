import { renderHook, act, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useQuests } from "./useQuests";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const PROGRESS = {
  user_id: "u1",
  gems: 30,
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
          rewards: [{ kind: "gems", amount: 20 }],
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
    expect(result.current.gems).toBe(30);
    expect(result.current.unclaimedCount).toBe(1);
    expect(mockFetch.mock.calls.filter(([u]) => String(u).includes("/quests/progress")).length).toBe(1);
  });

  it("applyClaim patches the level and gems without refetching", async () => {
    const { result } = renderHook(() => useQuests("u1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    mockFetch.mockClear();

    act(() => {
      result.current.applyClaim("qs_avatar", 1, [{ kind: "gems", amount: 20 }]);
    });

    const lvl = result.current.quests[0].levels[0];
    expect(lvl.claimed).toBe(true);
    expect(lvl.can_claim).toBe(false);
    expect(result.current.unclaimedCount).toBe(0);
    expect(result.current.gems).toBe(50);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("applyChestOpen drops the chest and adds gems without refetching", async () => {
    const { result } = renderHook(() => useQuests("u1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    mockFetch.mockClear();

    act(() => {
      result.current.applyChestOpen("missing-id", 40);
    });
    expect(result.current.gems).toBe(70);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
