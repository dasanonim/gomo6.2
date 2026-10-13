import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ShareCard } from "./ShareCard";

vi.mock("@/utils/relativeTimeShort", () => ({
  formatShortRelativeTime: () => "2д",
}));

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockFrom = vi.fn();
const mockNavigate = vi.fn();

vi.mock("@/integrations/api/compat", () => ({
  api: {
    from: (...args: any[]) => mockFrom(...args),
    rpc: vi.fn(),
  },
}));

vi.mock("@/utils/storage", () => ({
  storageUrl: (_bucket: string, keyOrUrl?: string | null) => keyOrUrl || null,
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => mockNavigate,
}));

function chain(rows: unknown[]) {
  return {
    select: () => chain(rows),
    eq: () => chain(rows),
    limit: async () => ({ data: rows, error: null }),
    single: async () => ({ data: rows[0] ?? null, error: null }),
  };
}

function renderCard(target: { type: "thread" | "wall"; id: string }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ShareCard target={target} />
    </QueryClientProvider>,
  );
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("ShareCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders a thread card with a header of title + author handle and the snippet", async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === "threads") {
        return chain([{
          id: "t1",
          user_id: "u1",
          title: "Заголовок записи",
          content: "Текст записи для карточки",
          image_url: null,
          image_urls: null,
          attachments: null,
          boards: { slug: "games", name: "Игры", is_gomosub: false },
          section: { name: "Игры" },
          subsection: { name: "ПК" },
          created_at: "2026-10-01T02:54:38Z",
          username: "author",
          display_name: null,
          is_anonymous: false,
          avatar_url: null,
        }]);
      }
      return chain([]);
    });

    renderCard({ type: "thread", id: "t1" });

    expect(await screen.findByText("Заголовок записи")).toBeInTheDocument();
    expect(screen.getByText(/Текст записи для карточки/)).toBeInTheDocument();
    // The meta line shows the handle, the section · subsection and the date —
    // and no raw board label like the removed "/games" line.
    expect(screen.getByText("@author · Игры · ПК · 2д")).toBeInTheDocument();
    expect(screen.queryByText(/\/games/)).not.toBeInTheDocument();
    expect(screen.getByRole("button")).toBeInTheDocument();
  });

  it("renders an author avatar in the header", async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === "threads") {
        return chain([{
          id: "t1",
          user_id: "u1",
          title: "Запись",
          content: "",
          image_url: null,
          image_urls: null,
          attachments: null,
          boards: { slug: "gomo", name: "Gomo", is_gomosub: true },
          username: "author",
          display_name: "Автор",
          is_anonymous: false,
          avatar_url: "avatar.png",
        }]);
      }
      return chain([]);
    });

    const { container } = renderCard({ type: "thread", id: "t1" });
    await screen.findByText("Запись");
    const avatar = container.querySelector(".msg-share-card-head .msg-share-card-avatar");
    expect(avatar).toHaveAttribute("src", "avatar.png");
    // The card still resolves to the gomosub thread URL on click.
    await userEvent.click(screen.getByRole("button"));
    expect(mockNavigate).toHaveBeenCalledWith("/g/gomo/thread/t1");
  });

  it("renders a wall post card with author and content", async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === "profile_wall_posts") {
        return chain([{
          id: "w1",
          user_id: "u1",
          content: "Запись со стены",
          created_at: "2026-10-01T02:54:38Z",
          image_url: null,
          attachments: null,
          author: { username: "bob", display_name: null, is_anonymous: false, avatar_url: null },
        }]);
      }
      return chain([]);
    });

    renderCard({ type: "wall", id: "w1" });

    // Wall posts have no title and no section: the meta line is just the handle
    // and the date, and the body shows the content snippet.
    expect(await screen.findByText("Запись со стены")).toBeInTheDocument();
    expect(screen.getByText("@bob · 2д")).toBeInTheDocument();
  });

  it("renders the first image attachment as the card thumbnail", async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === "threads") {
        return chain([{
          id: "t1",
          title: "С фото",
          content: "",
          image_url: null,
          image_urls: null,
          attachments: [{ type: "image", url: "photo.jpg", mime: "image/jpeg", name: "photo", size: 1 }],
          boards: { slug: "b", name: "Board", is_gomosub: false },
          profiles: { username: "author", is_anonymous: false, avatar_url: null },
        }]);
      }
      return chain([]);
    });

    const { container } = renderCard({ type: "thread", id: "t1" });
    await screen.findByText("С фото");
    const img = container.querySelector(".msg-share-card-image img");
    expect(img).toHaveAttribute("src", "photo.jpg");
  });

  it("navigates to the thread on card click", async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === "threads") {
        return chain([{
          id: "t1",
          title: "Заголовок",
          content: "",
          image_url: null,
          image_urls: null,
          attachments: null,
          boards: { slug: "games", name: "Игры", is_gomosub: false },
          profiles: { username: "author", is_anonymous: false, avatar_url: null },
        }]);
      }
      return chain([]);
    });

    renderCard({ type: "thread", id: "t1" });
    await screen.findByText("Заголовок");
    await userEvent.click(screen.getByRole("button"));
    expect(mockNavigate).toHaveBeenCalledWith("/games/thread/t1");
  });

  it("navigates to the wall post on card click", async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === "profile_wall_posts") {
        return chain([{
          id: "w1",
          user_id: "u1",
          content: "Запись",
          image_url: null,
          attachments: null,
          author: { username: "bob", is_anonymous: false, avatar_url: null },
        }]);
      }
      return chain([]);
    });

    renderCard({ type: "wall", id: "w1" });
    await screen.findByText("Запись");
    await userEvent.click(screen.getByRole("button"));
    expect(mockNavigate).toHaveBeenCalledWith("/profile/u1/wall/w1");
  });

  it("falls back to a muted card when the entity is gone", async () => {
    mockFrom.mockImplementation(() => chain([]));
    renderCard({ type: "wall", id: "missing" });
    expect(await screen.findByText("Запись недоступна")).toBeInTheDocument();
  });

  it("shows a loading placeholder while the entity is fetched", () => {
    // A never-resolving promise keeps the query in the loading state.
    mockFrom.mockImplementation(() => ({
      select: () => ({ eq: () => ({ limit: () => new Promise(() => {}) }) }),
    }));

    renderCard({ type: "thread", id: "t1" });
    expect(screen.getByText("Загрузка...")).toBeInTheDocument();
  });
});
