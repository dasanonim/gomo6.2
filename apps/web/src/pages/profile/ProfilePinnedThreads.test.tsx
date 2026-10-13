import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ReactNode } from "react";

import { ProfilePinnedThreads } from "@/pages/profile/ProfilePinnedThreads";

// ─── Mocks ───────────────────────────────────────────────────────────────────

let pinnedRows: Array<{ thread_id: string; position: number }> = [];
let threadRows: Array<Record<string, unknown>> = [];
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
      insert: (row: Record<string, unknown>) => awaitable([row]),
      delete: () => ({
        eq: (_column: string, value: string) => {
          deletedThreadIds.push(value);
          return awaitable([]);
        },
      }),
    };
  }
  if (table === "threads") return { select: () => selectChain(threadRows) };
  throw new Error(`unexpected table ${table}`);
});

vi.mock("@/integrations/api/compat", () => ({
  api: { from: (table: string) => mockFrom(table) },
}));

// The real list is a dense forum row (router links, hover previews); the block
// only needs to prove it passes the pins through and wires the row actions.
vi.mock("@/components/CompactThreadList", () => ({
  CompactThreadList: ({ rows, renderRowActions }: {
    rows: Array<{ id: string; title: string }>;
    renderRowActions?: (row: { id: string; title: string }) => ReactNode;
  }) => (
    <div data-testid="compact-list">
      {rows.map((row) => (
        <div key={row.id} data-testid="pinned-row">
          <span>{row.title}</span>
          {renderRowActions?.(row)}
        </div>
      ))}
    </div>
  ),
}));

vi.mock("@/components/PostActionsMenu", () => ({
  PostActionsMenu: ({ children }: { children: ReactNode }) => <div data-testid="row-menu">{children}</div>,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenuItem: ({ children, onClick, ...rest }: {
    children: ReactNode;
    onClick?: () => void;
  } & Record<string, unknown>) => (
    <button type="button" onClick={onClick} {...rest}>
      {children}
    </button>
  ),
}));

vi.mock("@/utils/threadFeedItem", () => ({
  fetchThreadLikesBatch: vi.fn(async () => new Map()),
}));

const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock("sonner", () => ({
  toast: { success: (...args: unknown[]) => toastSuccess(...args), error: (...args: unknown[]) => toastError(...args) },
}));

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);

const renderBlock = (props: Partial<React.ComponentProps<typeof ProfilePinnedThreads>> = {}) =>
  render(
    <ProfilePinnedThreads userId="owner" isOwner={false} currentUserId="me" {...props} />,
    { wrapper },
  );

beforeEach(() => {
  vi.clearAllMocks();
  pinnedRows = [];
  threadRows = [];
  deletedThreadIds = [];
});

describe("ProfilePinnedThreads", () => {
  it("shows a discovery hint to the owner when nothing is pinned", async () => {
    renderBlock({ isOwner: true });

    expect(await screen.findByText("Закрепите до 3 тем, чтобы показать их здесь")).toBeInTheDocument();
    expect(screen.queryByTestId("compact-list")).not.toBeInTheDocument();
  });

  it("renders nothing for a visitor when nothing is pinned", async () => {
    const { container } = renderBlock();

    // The pins query resolves to [] — the block must stay completely absent.
    await waitFor(() => expect(mockFrom).toHaveBeenCalledWith("profile_pinned_threads"));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("lists the pinned threads and offers the owner an unpin action", async () => {
    pinnedRows = [{ thread_id: "t1", position: 1 }];
    threadRows = [
      {
        id: "t1",
        title: "Закреплённая тема",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        user_id: "author",
        username: "author",
        is_anonymous: false,
        boards: { slug: "general", name: "General" },
      },
    ];

    renderBlock({ isOwner: true });

    expect(await screen.findByText("Закреплённая тема")).toBeInTheDocument();
    const unpin = screen.getByRole("button", { name: /Открепить из профиля/ });
    fireEvent.click(unpin);

    await waitFor(() => expect(deletedThreadIds).toEqual(["t1"]));
  });

  it("hides the unpin action from visitors", async () => {
    pinnedRows = [{ thread_id: "t1", position: 1 }];
    threadRows = [
      {
        id: "t1",
        title: "Чужая закреплённая тема",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        user_id: "author",
        username: "author",
        is_anonymous: false,
        boards: { slug: "general", name: "General" },
      },
    ];

    renderBlock();

    expect(await screen.findByText("Чужая закреплённая тема")).toBeInTheDocument();
    expect(screen.queryByTestId("row-menu")).not.toBeInTheDocument();
  });
});
