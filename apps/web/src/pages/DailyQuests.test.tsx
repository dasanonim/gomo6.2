import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MotionConfig } from "motion/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import DailyQuests from "./DailyQuests";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

vi.mock("react-router-dom", () => ({
  useParams: () => ({}),
  useNavigate: () => vi.fn(),
  Link: ({ to, children, className }: any) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

vi.mock("@/components/PentagramLoader", () => ({
  PentagramLoader: () => <div data-testid="pentagram-loader">Loading...</div>,
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "profile-user-1" } }),
}));

const QUEST = (over: Record<string, unknown> = {}) => ({
  key: "daily_likes",
  name_key: "achievements.daily.daily_likes.name",
  desc_key: "achievements.daily.daily_likes.description",
  threshold: 5,
  progress: 5,
  completed: true,
  claimed: false,
  can_claim: true,
  rewards: [{ kind: "drops", amount: 10 }],
  ...over,
});

const DAILY = {
  day: "2026-10-31",
  quests: [
    QUEST(),
    QUEST({
      key: "daily_comments",
      name_key: "achievements.daily.daily_comments.name",
      desc_key: "achievements.daily.daily_comments.description",
      threshold: 2,
      progress: 1,
      completed: false,
      claimed: false,
      can_claim: false,
      rewards: [{ kind: "drops", amount: 12 }],
    }),
  ],
  unclaimed_count: 1,
  full_claimed: false,
  streak: { current: 3, longest: 7 },
  chests: [],
  drops: 100,
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

function setupFetch(daily: unknown = DAILY) {
  mockFetch.mockImplementation((url: string, opts?: RequestInit) => {
    if (String(url).includes("/quests/daily/claim") && opts?.method === "POST") {
      return Promise.resolve(ok({ granted: [{ kind: "drops", amount: 10 }] }));
    }
    if (String(url).includes("/quests/daily/restore") && opts?.method === "POST") {
      return Promise.resolve(ok({ streak: 4, price: 80 }));
    }
    if (String(url).includes("/quests/daily/chests/") && opts?.method === "POST") {
      return Promise.resolve(ok({ rarity: "epic", drops: 60, rewards: [] }));
    }
    if (String(url).includes("/quests/daily")) {
      return Promise.resolve(ok(daily));
    }
    return Promise.resolve(ok([]));
  });
}

beforeEach(() => {
  mockFetch.mockReset();
});

function renderPage() {
  return render(
    <MotionConfig reducedMotion="always">
      <DailyQuests />
    </MotionConfig>,
  );
}

describe("DailyQuests page", () => {
  it("renders the day with the streak and the quests", async () => {
    setupFetch();
    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Ежедневные")).toBeInTheDocument();
    });
    expect(screen.getByText("Лайк-машина")).toBeInTheDocument();
    expect(screen.getByText("Собеседник")).toBeInTheDocument();
    // Streak chip shows the current series.
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("claims a quest with one POST and seals the row", async () => {
    setupFetch();
    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Лайк-машина")).toBeInTheDocument();
    });
    fireEvent.click(screen.getAllByText("Забрать")[0]);

    await waitFor(() => {
      const posts = mockFetch.mock.calls.filter(
        ([url, opts]: any[]) =>
          typeof url === "string" &&
          url.includes("/quests/daily/claim") &&
          (opts as RequestInit)?.method === "POST",
      );
      expect(posts.length).toBe(1);
    });
    expect(await screen.findByText("Забрано")).toBeInTheDocument();
  });

  it("offers the streak buy-back when yesterday was missed", async () => {
    setupFetch({
      ...DAILY,
      streak: { current: 4, longest: 9, restorable_day: "2026-10-30", restore_price: 80 },
    });
    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Серия прервалась")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Восстановить серию"));

    await waitFor(() => {
      const posts = mockFetch.mock.calls.filter(
        ([url, opts]: any[]) =>
          typeof url === "string" &&
          url.includes("/quests/daily/restore") &&
          (opts as RequestInit)?.method === "POST",
      );
      expect(posts.length).toBe(1);
    });
    await waitFor(() => {
      expect(screen.queryByText("Серия прервалась")).not.toBeInTheDocument();
    });
  });

  it("marks the day as seen so the quests button drops its «!»", async () => {
    const store: Record<string, string> = {};
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
    });
    setupFetch();
    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Лайк-машина")).toBeInTheDocument();
    });
    expect(store["daily:seen:profile-user-1"]).toBe("2026-10-31");
  });
});
