import { render, screen, act, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { CompactThreadList, type ThreadLastPost } from "@/components/CompactThreadList";
import type { ThreadApiRow } from "@/utils/threadFeedItem";

// UserBadge pulls in ProfileHoverCard (react-query); a plain span keeps this
// test focused on the list itself.
vi.mock("@/components/UserBadge", () => ({
  UserBadge: ({ username }: any) => <span data-testid="user-badge">{username}</span>,
}));

const row: ThreadApiRow = {
  id: "t1",
  title: "Как дела",
  content: "Как дела что делаете",
  image_url: null,
  created_at: "2026-01-01T10:00:00Z",
  updated_at: "2026-01-01T10:00:00Z",
  user_id: "u1",
  username: "bob",
  is_anonymous: false,
  post_count: 7,
  boards: { slug: "", name: "", is_gomosub: false },
  section: null,
  subsection: null,
};

const renderList = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe("CompactThreadList", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // jsdom's polyfill reports hover: none — the component then disables the
    // hover preview. This suite exercises the desktop behaviour by default.
    vi.stubGlobal(
      "matchMedia",
      ((query: string) => ({
        matches: query.startsWith("(hover:"),
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      })) as unknown as typeof window.matchMedia,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does not show the preview on a touch device (hover: none), even on mouse events", () => {
    vi.stubGlobal(
      "matchMedia",
      ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      })) as unknown as typeof window.matchMedia,
    );
    renderList(<CompactThreadList rows={[row]} currentUserId="me" />);
    fireEvent.mouseOver(screen.getByRole("link"));
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("renders a dense row with replies, likes and the last poster", () => {
    renderList(
      <CompactThreadList
        rows={[row]}
        likes={new Map([["t1", { count: 2, isLiked: false }]])}
        lastPosts={
          new Map<string, ThreadLastPost>([
            [
              "t1",
              {
                user_id: "u2",
                username: "alice",
                avatar_url: null,
                created_at: "2026-01-02T10:00:00Z",
              },
            ],
          ])
        }
        currentUserId="me"
      />,
    );

    expect(screen.getByText("Как дела")).toBeInTheDocument();
    expect(screen.getByText("bob")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("alice")).toBeInTheDocument();
  });

  it("falls back to the thread author when there are no replies", () => {
    renderList(<CompactThreadList rows={[row]} currentUserId="me" />);
    // Author shows in both the meta line and the right column.
    expect(screen.getAllByText("bob").length).toBeGreaterThanOrEqual(1);
  });

  it("offers a bookmark action for the thread", () => {
    renderList(<CompactThreadList rows={[row]} currentUserId="me" />);
    expect(screen.getByRole("button", { name: "В избранное" })).toBeInTheDocument();
  });

  it("drops the whole last-poster column (and its bookmark) when asked", () => {
    renderList(
      <CompactThreadList
        rows={[row]}
        lastPosts={
          new Map<string, ThreadLastPost>([
            ["t1", { user_id: "u2", username: "alice", avatar_url: null, created_at: "2026-01-02T10:00:00Z" }],
          ])
        }
        currentUserId="me"
        hideLastPoster
        hideBookmark
      />,
    );

    expect(screen.queryByText("alice")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "В избранное" })).not.toBeInTheDocument();
    // The meta line keeps the thread author, so the row still identifies it.
    expect(screen.getByText("bob")).toBeInTheDocument();
  });

  it("can hide only the bookmark and keep the last-poster column", () => {
    renderList(<CompactThreadList rows={[row]} currentUserId="me" hideBookmark />);

    expect(screen.queryByRole("button", { name: "В избранное" })).not.toBeInTheDocument();
    // Author shows twice: the meta line and the last-poster column.
    expect(screen.getAllByText("bob").length).toBeGreaterThanOrEqual(2);
  });

  it("lets the caller replace the container surface", () => {
    const { container } = renderList(
      <CompactThreadList
        rows={[row]}
        currentUserId="me"
        containerClassName="surface-panel rounded-xl border border-border/60 shadow-sm"
      />,
    );

    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain("surface-panel");
    expect(root.className).toContain("rounded-xl");
    expect(root.className).not.toContain("bg-surface/40");
  });

  it("shows the mini preview on hover after the delay, and hides on leave", () => {
    renderList(<CompactThreadList rows={[row]} currentUserId="me" />);

    const link = screen.getByRole("link");
    fireEvent.mouseOver(link);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(250);
    });

    expect(screen.getByRole("tooltip")).toHaveTextContent("Как дела что делаете");

    fireEvent.mouseOut(link);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("opens the preview upward when the measured card fits above the row", () => {
    // jsdom has no layout engine, so stub the rects: a row near the top of the
    // viewport (top=150) with a short card (100px). The old fixed 240px estimate
    // would have refused to open upward and dropped the panel down instead.
    const rect = (top: number, height: number) =>
      ({
        top,
        bottom: top + height,
        left: 0,
        right: 300,
        width: 300,
        height,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;

    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.closest('[role="tooltip"]') ? rect(0, 100) : rect(150, 40);
    });

    renderList(<CompactThreadList rows={[row]} currentUserId="me" />);

    fireEvent.mouseOver(screen.getByRole("link"));
    act(() => {
      vi.advanceTimersByTime(250);
    });

    const tooltip = screen.getByRole("tooltip");
    // Anchored by `bottom` → it opened above the row.
    expect(tooltip.style.bottom).not.toBe("");
    expect(tooltip.style.top).toBe("");
  });

  it("still drops the preview below when the card does not fit above", () => {
    const rect = (top: number, height: number) =>
      ({
        top,
        bottom: top + height,
        left: 0,
        right: 300,
        width: 300,
        height,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;

    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.closest('[role="tooltip"]') ? rect(0, 400) : rect(150, 40);
    });

    renderList(<CompactThreadList rows={[row]} currentUserId="me" />);

    fireEvent.mouseOver(screen.getByRole("link"));
    act(() => {
      vi.advanceTimersByTime(250);
    });

    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.style.top).not.toBe("");
    expect(tooltip.style.bottom).toBe("");
  });
});
