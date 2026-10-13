import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ReactNode } from "react";

import {
  MAX_PINNED_PROFILE_THREADS,
  usePinnedThreadIds,
  useProfilePinnedThreads,
  useThreadPinToggle,
  useTogglePinnedThread,
} from "./useProfilePinnedThreads";

// ─── api.from mock ───────────────────────────────────────────────────────────
// The hook reads two tables: profile_pinned_threads (the pin rows, and the
// insert/delete of a toggle) and threads (the bodies, in one batch). The mock is
// table-aware and returns awaitable chains, so the hook's `await` works at any
// step of the builder.

let pinnedRows: Array<{ thread_id: string; position: number }> = [];
let threadRows: Array<Record<string, unknown>> = [];
let inserted: Array<Record<string, unknown>> = [];
let deletedThreadIds: string[] = [];
/** Set to make the next pin attempt reject (e.g. `{ status: 409 }`). */
let insertError: unknown = null;
/** How many times the pin-id list has been fetched (refetch assertions). */
let pinnedListFetches = 0;

const awaitable = (data: unknown) => ({
  then: (onFulfilled: (value: { data: unknown; error: null }) => unknown, onRejected?: (reason: unknown) => unknown) =>
    Promise.resolve({ data, error: null }).then(onFulfilled, onRejected),
});

const selectChain = (data: unknown) => {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "order", "in", "limit", "range"]) {
    chain[method] = vi.fn(() => chain);
  }
  Object.assign(chain, awaitable(data));
  return chain;
};

const mockFrom = vi.fn((table: string) => {
  if (table === "profile_pinned_threads") {
    return {
      select: () => {
        pinnedListFetches += 1;
        return selectChain(pinnedRows);
      },
      insert: (row: Record<string, unknown>) => {
        inserted.push(row);
        return insertError
          ? Promise.reject(insertError)
          : Promise.resolve({ data: [row], error: null });
      },
      delete: () => ({
        eq: (_column: string, value: string) => {
          deletedThreadIds.push(value);
          return Promise.resolve({ data: [], error: null });
        },
      }),
    };
  }
  if (table === "threads") {
    return { select: () => selectChain(threadRows) };
  }
  throw new Error(`unexpected table ${table}`);
});

vi.mock("@/integrations/api/compat", () => ({
  api: { from: (table: string) => mockFrom(table) },
}));

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);

const thread = (id: string, title: string) => ({
  id,
  title,
  content: "",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  user_id: "author",
  username: "author",
  is_anonymous: false,
  boards: { slug: "general", name: "General" },
});

beforeEach(() => {
  vi.clearAllMocks();
  pinnedRows = [];
  threadRows = [];
  inserted = [];
  deletedThreadIds = [];
  insertError = null;
  pinnedListFetches = 0;
});

describe("useProfilePinnedThreads", () => {
  it("returns the pinned threads in the owner's order", async () => {
    pinnedRows = [
      { thread_id: "t2", position: 1 },
      { thread_id: "t1", position: 2 },
    ];
    // The threads endpoint returns them in its own order — the hook must
    // reorder by the stored position.
    threadRows = [thread("t1", "First"), thread("t2", "Second")];

    const { result } = renderHook(() => useProfilePinnedThreads("owner"), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.map((row) => row.id)).toEqual(["t2", "t1"]);
  });

  it("drops threads the viewer cannot see", async () => {
    pinnedRows = [
      { thread_id: "visible", position: 1 },
      { thread_id: "hidden", position: 2 },
    ];
    // The private board's thread is filtered out by GET /threads server-side.
    threadRows = [thread("visible", "Visible")];

    const { result } = renderHook(() => useProfilePinnedThreads("owner"), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.map((row) => row.id)).toEqual(["visible"]);
  });

  it("does not fetch thread bodies when nothing is pinned", async () => {
    const { result } = renderHook(() => useProfilePinnedThreads("owner"), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
    expect(mockFrom).not.toHaveBeenCalledWith("threads");
  });
});

describe("usePinnedThreadIds", () => {
  it("returns the pinned thread ids", async () => {
    pinnedRows = [{ thread_id: "t1", position: 1 }];

    const { result } = renderHook(() => usePinnedThreadIds("me"), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(["t1"]);
  });

  it("stays disabled without a user id", () => {
    const { result } = renderHook(() => usePinnedThreadIds(null), { wrapper });
    expect(result.current.fetchStatus).toBe("idle");
  });
});

describe("useTogglePinnedThread", () => {
  it("inserts a pin row when pinning", async () => {
    const { result } = renderHook(() => useTogglePinnedThread("me"), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ threadId: "t1", pinned: true });
    });

    expect(inserted).toEqual([{ thread_id: "t1" }]);
    expect(deletedThreadIds).toEqual([]);
  });

  it("deletes the pin row when unpinning", async () => {
    const { result } = renderHook(() => useTogglePinnedThread("me"), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ threadId: "t1", pinned: false });
    });

    expect(deletedThreadIds).toEqual(["t1"]);
    expect(inserted).toEqual([]);
  });
});

it("caps the list at the backend limit", () => {
  expect(MAX_PINNED_PROFILE_THREADS).toBe(3);
});

// ─── useThreadPinToggle (the thread page's «три точки» item) ─────────────────

describe("useThreadPinToggle", () => {
  const renderToggle = (threadId: string | undefined, userId: string | null = "me") =>
    renderHook(() => useThreadPinToggle(threadId, userId), { wrapper });

  it("reports an unpinned thread and pins it", async () => {
    const { result } = renderToggle("t1");
    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(result.current.isPinned).toBe(false);
    expect(result.current.limitReached).toBe(false);

    let outcome: Awaited<ReturnType<typeof result.current.toggle>> | undefined;
    await act(async () => {
      outcome = await result.current.toggle();
    });

    expect(inserted).toEqual([{ thread_id: "t1" }]);
    expect(outcome).toEqual({ status: "ok", pinned: true });
  });

  it("reports a pinned thread and unpins it", async () => {
    pinnedRows = [{ thread_id: "t1", position: 1 }];
    const { result } = renderToggle("t1");
    await waitFor(() => expect(result.current.isPinned).toBe(true));

    let outcome: Awaited<ReturnType<typeof result.current.toggle>> | undefined;
    await act(async () => {
      outcome = await result.current.toggle();
    });

    expect(deletedThreadIds).toEqual(["t1"]);
    expect(outcome).toEqual({ status: "ok", pinned: false });
  });

  it("flags the cap for a new thread but never blocks unpinning a pinned one", async () => {
    pinnedRows = [
      { thread_id: "a", position: 1 },
      { thread_id: "b", position: 2 },
      { thread_id: "c", position: 3 },
    ];

    const atCap = renderToggle("new-thread");
    await waitFor(() => expect(atCap.result.current.limitReached).toBe(true));
    expect(atCap.result.current.isPinned).toBe(false);

    const alreadyPinned = renderToggle("a");
    await waitFor(() => expect(alreadyPinned.result.current.isPinned).toBe(true));
    // The cap must not trap a thread that is already pinned — otherwise it could
    // never be removed without unpinning something else first.
    expect(alreadyPinned.result.current.limitReached).toBe(false);
  });

  it("maps a 409 to the limit outcome and refreshes the stale pin list", async () => {
    insertError = Object.assign(new Error("Pinned threads limit reached"), { status: 409 });
    const { result } = renderToggle("t1");
    await waitFor(() => expect(pinnedListFetches).toBe(1));

    let outcome: Awaited<ReturnType<typeof result.current.toggle>> | undefined;
    await act(async () => {
      outcome = await result.current.toggle();
    });

    expect(outcome).toEqual({ status: "limit" });
    // The rejected pin proves the cached list was stale — it must be refetched so
    // the menu stops offering an action that can only fail again.
    await waitFor(() => expect(pinnedListFetches).toBe(2));
  });

  it("maps any other failure to the generic outcome without a refetch", async () => {
    insertError = Object.assign(new Error("boom"), { status: 500 });
    const { result } = renderToggle("t1");
    await waitFor(() => expect(pinnedListFetches).toBe(1));

    let outcome: Awaited<ReturnType<typeof result.current.toggle>> | undefined;
    await act(async () => {
      outcome = await result.current.toggle();
    });

    expect(outcome).toEqual({ status: "error" });
    expect(pinnedListFetches).toBe(1);
  });

  it("refuses to toggle without a thread id", async () => {
    const { result } = renderToggle(undefined);

    let outcome: Awaited<ReturnType<typeof result.current.toggle>> | undefined;
    await act(async () => {
      outcome = await result.current.toggle();
    });

    expect(outcome).toEqual({ status: "error" });
    expect(inserted).toEqual([]);
    expect(deletedThreadIds).toEqual([]);
  });
});
