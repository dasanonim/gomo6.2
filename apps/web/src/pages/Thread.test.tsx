import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { describe, it, expect, beforeEach, vi, beforeAll } from "vitest";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockAuth = { getSession: vi.fn(), getUser: vi.fn(), onAuthStateChange: vi.fn() };
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// «Закрепить в профиле» (issue #518): the pin-id list read + the pin/unpin writes.
const mockFrom = vi.fn();
const mockPinInsert = vi.fn();
const mockPinDelete = vi.fn();
let pinnedIds: string[] = [];

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

const installPinApi = () => {
  mockFrom.mockImplementation((table: string) => {
    if (table === "profile_pinned_threads") {
      return {
        select: () => selectChain(pinnedIds.map((id, i) => ({ thread_id: id, position: i + 1 }))),
        insert: (...args: unknown[]) => mockPinInsert(...args),
        delete: () => ({ eq: (...args: unknown[]) => mockPinDelete(...args) }),
      };
    }
    return undefined;
  });
};

vi.mock("@/integrations/api/compat", () => ({
  api: { from: (...args: unknown[]) => mockFrom(...args), rpc: vi.fn(), auth: mockAuth },
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));
vi.mock("@/hooks/queries", () => ({
  useThread: vi.fn(),
  useThreadSubscription: vi.fn(),
}));
vi.mock("@/services/websocket", () => ({
  wsService: { subscribe: vi.fn(), subscribeToThread: vi.fn(), unsubscribe: vi.fn(), on: vi.fn().mockReturnValue(vi.fn()) },
}));
vi.mock("@/utils/storage", () => ({ storageUrl: () => null }));
vi.mock("@/utils/currentUserMeta", () => ({
  getCurrentUserMeta: () => Promise.resolve({ roles: [], color: "", username: "me", avatarUrl: null }),
}));
vi.mock("@/contexts/LikesCacheContext", () => ({
  LikesCacheProvider: ({ children }: any) => children,
  useLikesCache: () => ({ getLikeData: vi.fn(), loadLikeData: vi.fn(), updateLikeData: vi.fn(), loadLikeDataBatch: vi.fn() }),
}));
vi.mock("@/components/PentagramLoader", () => ({ PentagramLoader: () => <div data-testid="pentagram-loader">Loading...</div> }));
vi.mock("@/components/ProcessedContent", () => ({
  ProcessedContent: ({ content }: any) => <div data-testid="processed-content">{content}</div>,
}));
vi.mock("@/components/UserBadge", () => ({ UserBadge: () => <span data-testid="user-badge" /> }));
vi.mock("@/components/LikeButton", () => ({ LikeButton: () => null }));
vi.mock("@/components/Lightbox", () => ({ Lightbox: () => null }));
vi.mock("@/components/Poll", () => ({ Poll: () => null }));
// The menu itself is Radix (needs a portal + menu context); render its children
// inline so the owner and pin items are reachable in jsdom.
vi.mock("@/components/PostActionsMenu", () => ({
  PostActionsMenu: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="post-actions-menu">{children}</div>
  ),
}));
vi.mock("@/components/ui/dropdown-menu", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui/dropdown-menu")>();
  return {
    ...actual,
    DropdownMenuItem: ({ children, onClick, disabled, title }: any) => (
      <button type="button" onClick={onClick} disabled={disabled} title={title}>
        {children}
      </button>
    ),
  };
});
vi.mock("@/components/GomoRichEditor", () => ({
  GomoRichEditor: ({ legacyContent, onChange }: any) => (
    <textarea
      data-testid="thread-edit-input"
      defaultValue={legacyContent || ""}
      onChange={(e) => onChange?.({ json: null, text: e.target.value })}
    />
  ),
}));
const mockWallAttachments = vi.fn();
vi.mock("@/components/WallAttachments", () => ({
  WallAttachments: (props: any) => {
    mockWallAttachments(props);
    return null;
  },
}));
vi.mock("@/components/share/ShareSheet", () => ({ ShareSheet: () => null }));
vi.mock("@/components/thread/ThreadCommentTree", () => ({
  ThreadCommentTree: ({ currentUserId }: any) => (
    <div data-testid="thread-comment-tree" data-can-post={!!currentUserId} />
  ),
}));

const mockNavigate = vi.fn();
const mockLocation: { pathname: string; state: unknown } = {
  pathname: "/test-board/thread/thread-1",
  state: null,
};
vi.mock("react-router-dom", async () => {
  const actual = await import("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useParams: () => ({ slug: "test-board", threadId: "thread-1" }),
    useLocation: () => mockLocation,
  };
});

let ThreadComponent: any;
let useThread: any;
let useThreadSubscription: any;

// ─── Fixtures ────────────────────────────────────────────────────────────────

const mockThread = (overrides?: Record<string, unknown>) => ({
  id: "thread-1", board_id: "board-1", user_id: "author-1",
  title: "Test Thread", content: "Hello world",
  created_at: "2025-01-01T00:00:00Z", updated_at: "2025-01-01T00:00:00Z",
  post_count: 3,
  boards: { slug: "test-board", name: "Test Board", is_gomosub: false, is_rules_board: false },
  profiles: { username: "author", avatar_url: null, is_anonymous: false },
  ...overrides,
});

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>{ui}</BrowserRouter>
    </QueryClientProvider>
  );
}

/**
 * Click an element and let the async chain it starts settle inside ONE `act`
 * scope. `userEvent.click` only wraps its own interaction — the mutation's
 * promise continuations (pending → settled, then the invalidation refetch) run
 * after it returns, and without the outer scope React logs "not wrapped in act".
 */
const clickAndSettle = async (element: HTMLElement) => {
  await act(async () => {
    await userEvent.click(element);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Thread", () => {
  beforeAll(async () => {
    const mod = await import("./Thread");
    ThreadComponent = mod.default;
    const queries = await import("@/hooks/queries");
    useThread = queries.useThread;
    useThreadSubscription = queries.useThreadSubscription;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockLocation.state = null;
    const session = { user: { id: "user-1" }, access_token: "token-abc" };
    mockAuth.getSession.mockResolvedValue({ data: { session }, error: null });
    mockAuth.getUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
    mockAuth.onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } }, error: null });
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ data: [] }) });

    pinnedIds = [];
    // The mock mirrors the server: a write changes the list the next read returns,
    // so a test can assert on the settled UI instead of racing the refetch.
    mockPinInsert.mockImplementation((row: { thread_id: string }) => {
      pinnedIds = [...pinnedIds, row.thread_id];
      return Promise.resolve({ data: [row], error: null });
    });
    mockPinDelete.mockImplementation((_column: string, value: string) => {
      pinnedIds = pinnedIds.filter((id) => id !== value);
      return Promise.resolve({ data: [], error: null });
    });
    installPinApi();
  });

  it("shows pentagram loader when thread is still loading", async () => {
    useThread.mockReturnValue({ data: null, isLoading: true } as any);
    useThreadSubscription.mockReturnValue({ data: false } as any);
    renderWithProviders(<ThreadComponent />);
    await waitFor(() => {
      expect(screen.getByTestId("pentagram-loader")).toBeInTheDocument();
    });
  });

  it("renders back button when thread is loaded", async () => {
    useThread.mockReturnValue({ data: mockThread(), isLoading: false } as any);
    useThreadSubscription.mockReturnValue({ data: false } as any);

    renderWithProviders(<ThreadComponent />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /назад/i })).toBeInTheDocument();
    });
  });

  it("autoplays the thread video when opened via a feed video tap", async () => {
    mockLocation.state = { autoplayVideo: true };
    useThread.mockReturnValue({
      data: mockThread({ attachments: [{ url: "clip.mp4", type: "video", mime: "video/mp4", name: "clip", size: 0 }] }),
      isLoading: false,
    } as any);
    useThreadSubscription.mockReturnValue({ data: false } as any);

    renderWithProviders(<ThreadComponent />);
    await waitFor(() => {
      expect(mockWallAttachments).toHaveBeenCalledWith(
        expect.objectContaining({ autoPlayVideo: true }),
      );
    });
  });

  it("renders thread attachments without autoplay when opened normally", async () => {
    useThread.mockReturnValue({
      data: mockThread({ attachments: [{ url: "clip.mp4", type: "video", mime: "video/mp4", name: "clip", size: 0 }] }),
      isLoading: false,
    } as any);
    useThreadSubscription.mockReturnValue({ data: false } as any);

    renderWithProviders(<ThreadComponent />);
    await waitFor(() => {
      expect(mockWallAttachments).toHaveBeenCalledWith(
        expect.objectContaining({ autoPlayVideo: false }),
      );
    });
  });

  it("goes back in history when the thread was opened from another page", async () => {
    useThread.mockReturnValue({ data: mockThread(), isLoading: false } as any);
    useThreadSubscription.mockReturnValue({ data: false } as any);
    Object.defineProperty(window.history, "length", { configurable: true, get: () => 5 });

    renderWithProviders(<ThreadComponent />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /назад/i })).toBeInTheDocument();
    });
    await clickAndSettle(screen.getByRole("button", { name: /назад/i }));
    expect(mockNavigate).toHaveBeenCalledWith(-1);
  });

  it("falls back to the board when the thread was opened directly", async () => {
    useThread.mockReturnValue({ data: mockThread(), isLoading: false } as any);
    useThreadSubscription.mockReturnValue({ data: false } as any);
    Object.defineProperty(window.history, "length", { configurable: true, get: () => 1 });

    renderWithProviders(<ThreadComponent />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /назад/i })).toBeInTheDocument();
    });
    await clickAndSettle(screen.getByRole("button", { name: /назад/i }));
    expect(mockNavigate).toHaveBeenCalledWith("/test-board", { replace: true });
  });

  it("renders the thread card: title, author and content", async () => {
    useThread.mockReturnValue({ data: mockThread({ title: "My Awesome Thread" }), isLoading: false } as any);
    useThreadSubscription.mockReturnValue({ data: false } as any);

    renderWithProviders(<ThreadComponent />);
    await waitFor(() => {
      expect(screen.getByText("My Awesome Thread")).toBeInTheDocument();
      expect(screen.getByTestId("processed-content")).toHaveTextContent("Hello world");
      expect(screen.getByTestId("user-badge")).toBeInTheDocument();
    });
  });

  it("renders the comment tree with posting enabled for a logged-in user", async () => {
    useThread.mockReturnValue({ data: mockThread(), isLoading: false } as any);
    useThreadSubscription.mockReturnValue({ data: false } as any);

    renderWithProviders(<ThreadComponent />);
    await waitFor(() => {
      expect(screen.getByTestId("thread-comment-tree")).toHaveAttribute("data-can-post", "true");
    });
  });

  it("hides the comment composer for guests", async () => {
    mockAuth.getSession.mockResolvedValue({ data: { session: null }, error: null });
    useThread.mockReturnValue({ data: mockThread(), isLoading: false } as any);
    useThreadSubscription.mockReturnValue({ data: false } as any);

    renderWithProviders(<ThreadComponent />);
    await waitFor(() => {
      expect(screen.getByTestId("thread-comment-tree")).toHaveAttribute("data-can-post", "false");
    });
  });

  it("shows the post count from the thread", async () => {
    useThread.mockReturnValue({ data: mockThread({ post_count: 7 }), isLoading: false } as any);
    useThreadSubscription.mockReturnValue({ data: false } as any);

    renderWithProviders(<ThreadComponent />);
    await waitFor(() => {
      expect(screen.getByText("7")).toBeInTheDocument();
    });
  });

  it("lets the author edit the thread", async () => {
    useThread.mockReturnValue({
      data: mockThread({ user_id: "user-1" }),
      isLoading: false,
    } as any);
    useThreadSubscription.mockReturnValue({ data: false } as any);

    renderWithProviders(<ThreadComponent />);
    await waitFor(() => {
      expect(screen.getByTestId("post-actions-menu")).toBeInTheDocument();
    });
    // The edit handler lives behind PostActionsMenu (mocked) — the card itself renders.
    expect(screen.getByText("Test Thread")).toBeInTheDocument();
  });

  // ─── «Закрепить в профиле» (issue #518) ────────────────────────────────────

  it("offers «Закрепить в профиле» to any signed-in user and pins on click", async () => {
    useThread.mockReturnValue({ data: mockThread(), isLoading: false } as any);
    useThreadSubscription.mockReturnValue({ data: false } as any);

    renderWithProviders(<ThreadComponent />);

    const item = await screen.findByRole("button", { name: "Закрепить в профиле" });
    await clickAndSettle(item);

    // The write lands, the list refetches and the item flips to «Открепить» —
    // waiting for that settled state is what proves the whole round trip.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Открепить из профиля" })).toBeInTheDocument(),
    );
    expect(mockPinInsert).toHaveBeenCalledWith({ thread_id: "thread-1" });
    expect(toastSuccess).toHaveBeenCalledWith("Тема закреплена в профиле");
  });

  it("switches to «Открепить из профиля» for a thread the user already pinned", async () => {
    pinnedIds = ["thread-1"];
    useThread.mockReturnValue({ data: mockThread(), isLoading: false } as any);
    useThreadSubscription.mockReturnValue({ data: false } as any);

    renderWithProviders(<ThreadComponent />);

    const item = await screen.findByRole("button", { name: "Открепить из профиля" });
    await clickAndSettle(item);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Закрепить в профиле" })).toBeInTheDocument(),
    );
    expect(mockPinDelete).toHaveBeenCalledWith("thread_id", "thread-1");
    expect(toastSuccess).toHaveBeenCalledWith("Тема откреплена из профиля");
  });

  it("disables the pin item once three threads are already pinned", async () => {
    pinnedIds = ["a", "b", "c"];
    useThread.mockReturnValue({ data: mockThread(), isLoading: false } as any);
    useThreadSubscription.mockReturnValue({ data: false } as any);

    renderWithProviders(<ThreadComponent />);

    const item = await screen.findByRole("button", { name: "Закрепить в профиле" });
    // The item renders as soon as the viewer is known, but the cap can only be
    // derived once the pin list has loaded — wait for the settled state.
    await waitFor(() => expect(item).toBeDisabled());
    expect(item).toHaveAttribute("title", "В профиле уже 3 закреплённые темы");
  });

  it("explains the cap when the server rejects a fourth pin, and self-heals", async () => {
    // The client's cached list is stale (it shows nothing pinned), so the item is
    // offered — the click is what discovers the truth from the server.
    pinnedIds = [];
    mockPinInsert.mockImplementation(() => {
      pinnedIds = ["a", "b", "c"];
      return Promise.reject(Object.assign(new Error("Pinned threads limit reached"), { status: 409 }));
    });
    useThread.mockReturnValue({ data: mockThread(), isLoading: false } as any);
    useThreadSubscription.mockReturnValue({ data: false } as any);

    renderWithProviders(<ThreadComponent />);

    const item = await screen.findByRole("button", { name: "Закрепить в профиле" });
    await clickAndSettle(item);

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("В профиле уже 3 закреплённые темы"));
    // …and the rejected pin refreshes the list, so the item corrects itself.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Закрепить в профиле" })).toBeDisabled(),
    );
  });

  it("reports a generic failure for any other pin error", async () => {
    mockPinInsert.mockImplementation(() =>
      Promise.reject(Object.assign(new Error("boom"), { status: 500 })),
    );
    useThread.mockReturnValue({ data: mockThread(), isLoading: false } as any);
    useThreadSubscription.mockReturnValue({ data: false } as any);

    renderWithProviders(<ThreadComponent />);

    const item = await screen.findByRole("button", { name: "Закрепить в профиле" });
    await clickAndSettle(item);

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Не удалось изменить закрепление"));
  });

  it("hides the pin item from guests", async () => {
    mockAuth.getSession.mockResolvedValue({ data: { session: null }, error: null });
    useThread.mockReturnValue({ data: mockThread(), isLoading: false } as any);
    useThreadSubscription.mockReturnValue({ data: false } as any);

    renderWithProviders(<ThreadComponent />);

    await waitFor(() => {
      expect(screen.getByTestId("thread-comment-tree")).toHaveAttribute("data-can-post", "false");
    });
    expect(
      screen.queryByRole("button", { name: /Закрепить в профиле|Открепить из профиля/ }),
    ).not.toBeInTheDocument();
  });
});
