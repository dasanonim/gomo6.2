import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ReactNode } from "react";

import {
  MAX_PINNED_PROFILE_THREADS,
  usePinnedThreadIds,
  useProfilePinnedThreads,
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
      select: () => selectChain(pinnedRows),
      insert: (row: Record<string, unknown>) => {
        inserted.push(row);
        return awaitable([row]);
      },
      delete: () => ({
        eq: (_column: string, value: string) => {
          deletedThreadIds.push(value);
          return awaitable([]);
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
