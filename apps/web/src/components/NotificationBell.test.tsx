import { render, screen, fireEvent, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactNode } from "react";

import { NotificationBell } from "@/components/NotificationBell";

const { mockStore } = vi.hoisted(() => ({
  mockStore: {
    notifications: [] as Array<Record<string, unknown>>,
    unreadCount: 0,
    hasMore: false,
    isLoadingMore: false,
    init: vi.fn(),
    markAsRead: vi.fn(),
    fetchMore: vi.fn(),
  },
}));

vi.mock("@/stores/notificationStore", () => ({
  useNotificationStore: (selector: (state: typeof mockStore) => unknown) => selector(mockStore),
}));
vi.mock("@/components/NotificationItem", () => ({
  NotificationItem: ({ notification }: { notification: { id: string } }) => (
    <div data-testid="notif-row">{notification.id}</div>
  ),
}));
vi.mock("@/components/UnreadBadge", () => ({ UnreadBadge: () => null }));
vi.mock("@/components/PentagramLoader", () => ({ PentagramLoader: () => <span /> }));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, className }: { children: ReactNode; onClick?: () => void; className?: string }) => (
    <button type="button" onClick={onClick} className={className}>
      {children}
    </button>
  ),
}));

const renderBell = (initialPath = "/") =>
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <NotificationBell userId="user-1" />
    </MemoryRouter>,
  );

describe("NotificationBell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.notifications = [];
    // Pretend a fine pointer so the hover panel is enabled.
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stays open on leave for the grace delay, then closes — unless the cursor returns", () => {
    mockStore.notifications = Array.from({ length: 12 }, (_, i) => ({ id: `n${i}` }));
    vi.useFakeTimers();
    renderBell();

    const bell = screen.getByRole("button");
    fireEvent.mouseOver(bell);
    expect(screen.getAllByTestId("notif-row")).toHaveLength(12);

    // The cursor can trip over the edge / gap between button and panel: the
    // close is delayed, and re-entering cancels it.
    fireEvent.mouseLeave(bell.parentElement!);
    fireEvent.mouseOver(bell);
    act(() => { vi.advanceTimersByTime(500); });
    expect(screen.getAllByTestId("notif-row")).toHaveLength(12);

    // Leaving for real (no re-entry) closes the panel after the grace delay.
    fireEvent.mouseLeave(bell.parentElement!);
    act(() => { vi.advanceTimersByTime(100); });
    expect(screen.getAllByTestId("notif-row")).toHaveLength(12);
    act(() => { vi.advanceTimersByTime(200); });
    expect(screen.queryByTestId("notif-row")).not.toBeInTheDocument();

    vi.useRealTimers();
  });

  it("closes on an outside click", () => {
    mockStore.notifications = [{ id: "n1" }];
    renderBell();

    fireEvent.mouseOver(screen.getByRole("button"));
    expect(screen.getByTestId("notif-row")).toBeInTheDocument();

    act(() => {
      fireEvent.mouseDown(document.body);
    });
    expect(screen.queryByTestId("notif-row")).not.toBeInTheDocument();
  });

  it("initialises the store for the user", () => {
    renderBell();
    expect(mockStore.init).toHaveBeenCalledWith("user-1");
  });

  it("does not open the preview on the notifications page itself", () => {
    mockStore.notifications = [{ id: "n1" }];
    renderBell("/notify");

    fireEvent.mouseOver(screen.getByRole("button"));
    expect(screen.queryByTestId("notif-row")).not.toBeInTheDocument();
  });
});
