import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AdminBadge } from "./AdminBadge";

const mockGetCached = vi.fn();
const mockRequest = vi.fn();
const mockSubscribe = vi.fn(() => () => {});

vi.mock("@/utils/profileSummaryLoader", () => ({
  getCachedProfileSummary: (userId: unknown) => (mockGetCached as unknown as (id: unknown) => unknown)(userId),
  requestProfileSummary: (userId: unknown) => (mockRequest as unknown as (id: unknown) => unknown)(userId),
  subscribeProfileSummaries: (listener: unknown) =>
    (mockSubscribe as unknown as (l: unknown) => () => void)(listener),
}));

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: any) => <div>{children}</div>,
  Tooltip: ({ children }: any) => <div>{children}</div>,
  TooltipTrigger: ({ children }: any) => <div>{children}</div>,
  TooltipContent: ({ children }: any) => <div data-testid="tooltip">{children}</div>,
}));

describe("AdminBadge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders nothing when user is not admin", async () => {
    mockGetCached.mockReturnValue(null);
    mockRequest.mockResolvedValue(null);

    const { container } = render(<AdminBadge userId="user-1" />);
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith("user-1");
    });
    expect(container.innerHTML).toBe("");
  });

  it("renders admin icon when user is admin", async () => {
    mockGetCached.mockReturnValue(null);
    mockRequest.mockResolvedValue({ is_admin: true });

    render(<AdminBadge userId="user-1" />);
    await waitFor(() => {
      expect(screen.getByTestId("admin-badge")).toBeInTheDocument();
    });
    expect(screen.getByTestId("admin-badge").querySelector("[data-gomo6-mark]")).toBeInTheDocument();
  });

  it("labels the badge as the site team", async () => {
    mockGetCached.mockReturnValue({ is_admin: true });

    render(<AdminBadge userId="user-1" />);
    await waitFor(() => {
      expect(screen.getByTestId("admin-badge")).toHaveAttribute("aria-label", "команда сайта");
    });
    expect(screen.getByText("команда сайта")).toBeInTheDocument();
  });

  it("uses cached profile data", async () => {
    mockGetCached.mockReturnValue({ is_admin: true });

    render(<AdminBadge userId="user-1" />);
    await waitFor(() => {
      expect(screen.getByTestId("admin-badge")).toBeInTheDocument();
    });
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("loads profile when cache miss", async () => {
    mockGetCached.mockReturnValue(null);
    mockRequest.mockResolvedValue(null);

    render(<AdminBadge userId="user-1" />);
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith("user-1");
    });
  });
});
