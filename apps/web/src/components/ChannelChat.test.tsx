import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import ChannelChat from "./ChannelChat";

const wsMock = vi.hoisted(() => {
  const handlers = new Map<string, Set<(m: unknown) => void>>();
  return {
    subs: [] as string[],
    unsubs: [] as string[],
    on: (type: string, fn: (m: unknown) => void) => {
      let set = handlers.get(type);
      if (!set) {
        set = new Set();
        handlers.set(type, set);
      }
      set.add(fn);
      return () => {
        set?.delete(fn);
      };
    },
    emit: (type: string, data: unknown) => {
      handlers.get(type)?.forEach((fn) =>
        fn({ type, data, timestamp: Date.now() })
      );
    },
    reset() {
      handlers.clear();
      this.subs.length = 0;
      this.unsubs.length = 0;
    },
  };
});

vi.mock("@/services/websocket", () => ({
  wsService: {
    subscribe: (room: string) => wsMock.subs.push(room),
    unsubscribe: (room: string) => wsMock.unsubs.push(room),
    on: wsMock.on,
  },
}));

vi.mock("@/integrations/api/client", () => ({
  apiClient: {
    getToken: vi.fn().mockReturnValue(null),
    getCSRFToken: vi.fn().mockReturnValue("csrf-token"),
  },
}));

vi.mock("@/i18n/dateLocale", () => ({
  useDateLocale: () => undefined,
}));

const CH = "10000000-0000-0000-0000-000000000001";
const ME = "20000000-0000-0000-0000-000000000002";

function jsonResponse(data: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => ({ success: true, data }),
  };
}

// ── Layout stand-in ────────────────────────────────────────────────────────
// The channel chat scrolls the document, so the geometry that matters is the
// scrolling element's. jsdom has none: without this every scroll decision sees
// a 0px viewport and "always at the bottom".
const ROW = 60;
const VIEWPORT = 600;
let scrollTopValue = 0;
const savedLayout: Array<[string, PropertyDescriptor | undefined]> = [];

function installLayout() {
  const proto = HTMLElement.prototype;
  for (const key of ["clientHeight", "scrollHeight", "scrollTop", "offsetTop", "offsetHeight"]) {
    savedLayout.push([key, Object.getOwnPropertyDescriptor(proto, key)]);
  }
  Object.defineProperty(proto, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this === document.documentElement ? VIEWPORT : 0;
    },
  });
  Object.defineProperty(proto, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      if (this !== document.documentElement) return 0;
      return document.querySelectorAll(".channel-message-row").length * ROW + 2;
    },
  });
  Object.defineProperty(proto, "scrollTop", {
    configurable: true,
    get(this: HTMLElement) {
      const max = Math.max(0, this.scrollHeight - this.clientHeight);
      if (scrollTopValue > max) scrollTopValue = max;
      return scrollTopValue;
    },
    set(this: HTMLElement, value: number) {
      const max = Math.max(0, this.scrollHeight - this.clientHeight);
      scrollTopValue = Number.isFinite(value) ? Math.max(0, Math.min(value, max)) : 0;
    },
  });
  Object.defineProperty(proto, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("channel-message-row") ? ROW : 0;
    },
  });
  Object.defineProperty(proto, "offsetTop", {
    configurable: true,
    get(this: HTMLElement) {
      if (!this.classList.contains("channel-message-row")) return 0;
      let top = 0;
      let sibling = this.previousElementSibling;
      while (sibling) {
        if (sibling.classList.contains("channel-message-row")) top += ROW;
        sibling = sibling.previousElementSibling;
      }
      return top;
    },
  });
}

function restoreLayout() {
  for (const [key, descriptor] of savedLayout.splice(0)) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
  }
}

beforeEach(() => {
  wsMock.reset();
  scrollTopValue = 0;
  installLayout();
});

afterEach(() => {
  restoreLayout();
  vi.unstubAllGlobals();
});

it("loads history, subscribes the room and renders oldest→newest", async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    jsonResponse([
      { id: 1, channel_id: CH, user_id: ME, username: "me", avatar_url: null, content: "первое", created_at: "2026-08-20T10:00:00Z" },
      { id: 2, channel_id: CH, user_id: "u9", username: "bob", avatar_url: null, content: "второе", created_at: "2026-08-20T10:01:00Z" },
    ])
  );
  vi.stubGlobal("fetch", fetchMock);

  render(<ChannelChat channelId={CH} currentUserId={ME} />);

  await waitFor(() => {
    expect(screen.getByText("первое")).toBeInTheDocument();
  });
  expect(screen.getByText("второе")).toBeInTheDocument();
  expect(wsMock.subs).toContain(`channel_${CH}`);
  expect(fetchMock).toHaveBeenCalledWith(
    `/api/v1/gomosubchat/channels/${CH}/messages?limit=50`,
    { credentials: "include" }
  );
});

it("unsubscribes the room when the component leaves", async () => {
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
  vi.stubGlobal("fetch", fetchMock);

  const { unmount } = render(<ChannelChat channelId={CH} currentUserId={ME} />);
  await waitFor(() => expect(screen.getByPlaceholderText(/Написать/i)).toBeInTheDocument());
  unmount();

  expect(wsMock.unsubs).toContain(`channel_${CH}`);
});

it("posts through REST and appends the returned message", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(jsonResponse([]))
    .mockResolvedValueOnce(
      jsonResponse({ id: 5, channel_id: CH, user_id: ME, username: "me", avatar_url: null, content: "мой месседж", created_at: "2026-08-20T11:00:00Z" })
    );
  vi.stubGlobal("fetch", fetchMock);

  render(<ChannelChat channelId={CH} currentUserId={ME} />);
  const input = await screen.findByPlaceholderText(/Написать/i);

  fireEvent.change(input, { target: { value: "мой месседж" } });
  fireEvent.submit(input.closest("form")!);

  await waitFor(() => expect(screen.getByText("мой месседж")).toBeInTheDocument());
  expect(fetchMock).toHaveBeenLastCalledWith(
    `/api/v1/gomosubchat/channels/${CH}/messages`,
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ content: "мой месседж" }),
    })
  );
  // Draft must be cleared after a successful send.
  expect((input as HTMLInputElement).value).toBe("");
  // CSRF header present (protected route).
  const [, init] = fetchMock.mock.calls[1];
  expect(init.headers["X-CSRF-Token"]).toBe("csrf-token");
});

it("appends realtime events and dedups the optimistic duplicate", async () => {
  const base = { id: 5, channel_id: CH, user_id: "u7", username: "rita", avatar_url: null, content: "по WS", created_at: "2026-08-20T12:00:00Z" };
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
  vi.stubGlobal("fetch", fetchMock);

  render(<ChannelChat channelId={CH} currentUserId={ME} />);
  await screen.findByPlaceholderText(/Написать/i);

  act(() => {
    wsMock.emit("new_channel_message", base);
    wsMock.emit("new_channel_message", base); // duplicate event
  });

  await waitFor(() => expect(screen.getByText("по WS")).toBeInTheDocument());
  // Exactly one instance despite the double emit.
  expect(screen.getAllByText("по WS")).toHaveLength(1);

  // Events of another channel must be ignored.
  act(() => {
    wsMock.emit("new_channel_message", { ...base, id: 6, channel_id: "99999999-9999-9999-9999-999999999999", content: "чужой канал" });
  });
  expect(screen.queryByText("чужой канал")).not.toBeInTheDocument();
});

it("renders a read-only notice without access instead of the composer", async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    (() => {
      return { ok: false, status: 403, json: async () => ({ success: false, error: "No access" }) };
    })()
  );
  vi.stubGlobal("fetch", fetchMock);

  render(<ChannelChat channelId={CH} currentUserId={ME} />);

  await waitFor(() => expect(screen.getByText(/Нет доступа/i)).toBeInTheDocument());
  expect(screen.queryByPlaceholderText(/Написать/i)).not.toBeInTheDocument();
});

it("loads an older history page on scroll-to-top", async () => {
  const mk = (id: number, content: string) => ({
    id,
    channel_id: CH,
    user_id: "u9",
    username: "bob",
    avatar_url: null,
    content,
    created_at: "2026-08-20T10:00:00Z",
  });
  const firstPage = Array.from({ length: 50 }, (_, i) => mk(i + 1, `msg-${i + 1}`));
  const olderPage = Array.from({ length: 50 }, (_, i) => mk(i - 49, `old-${i - 49}`));

  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(jsonResponse(firstPage)) // 50 → hasMore=true
    .mockResolvedValueOnce(jsonResponse(olderPage));
  vi.stubGlobal("fetch", fetchMock);

  render(<ChannelChat channelId={CH} currentUserId={ME} />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

  // The chat scrolls with the window (document.scrollingElement) — the
  // native-layout scroll. Simulate a user scroll-to-top via a window event.
  act(() => {
    document.documentElement.scrollTop = 0;
    window.dispatchEvent(new Event("scroll"));
  });

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(fetchMock).toHaveBeenLastCalledWith(
    `/api/v1/gomosubchat/channels/${CH}/messages?before=1&limit=50`,
    { credentials: "include" }
  );
  // The prepended page lands at the top of the virtual list.
  await waitFor(() => expect(screen.getByText("old--49")).toBeInTheDocument());
});

it("restores a runway of already-loaded rows when the reader scrolls up", async () => {
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
  vi.stubGlobal("fetch", fetchMock);
  render(<ChannelChat channelId={CH} currentUserId={ME} />);
  await screen.findByPlaceholderText(/Написать/i);

  act(() => {
    for (let id = 1; id <= 400; id += 1) {
      wsMock.emit("new_channel_message", {
        id,
        channel_id: CH,
        user_id: "u9",
        username: "bob",
        avatar_url: null,
        content: `msg-${id}`,
        created_at: "2026-08-20T10:00:00Z",
      });
    }
  });
  await waitFor(() => expect(screen.getByText("msg-400")).toBeInTheDocument());
  const before = document.querySelectorAll(".channel-message-row").length;

  // Scroll to the top of the mounted window: reading history.
  act(() => {
    document.documentElement.scrollTop = 0;
    window.dispatchEvent(new Event("scroll"));
  });

  // A whole fling's worth of already-loaded rows is mounted above the reader,
  // and the row that was at the top of the viewport did not move.
  await waitFor(
    () => expect(document.querySelectorAll(".channel-message-row").length).toBeGreaterThan(before),
    { timeout: 3000 },
  );
  const rows = Array.from(document.querySelectorAll<HTMLElement>(".channel-message-row"));
  const anchor = rows.find((row) => row.dataset.messageId === "251");
  expect(document.documentElement.scrollTop).toBeGreaterThanOrEqual(4000);
  expect(anchor?.offsetTop).toBe(document.documentElement.scrollTop);
});

it("mounts only the windowed slice for a long history", async () => {
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
  vi.stubGlobal("fetch", fetchMock);

  render(<ChannelChat channelId={CH} currentUserId={ME} />);
  await screen.findByPlaceholderText(/Написать/i);

  act(() => {
    for (let id = 1; id <= 400; id += 1) {
      wsMock.emit("new_channel_message", {
        id,
        channel_id: CH,
        user_id: "u9",
        username: "bob",
        avatar_url: null,
        content: `msg-${id}`,
        created_at: "2026-08-20T10:00:00Z",
      });
    }
  });

  await waitFor(() => expect(screen.getByText("msg-400")).toBeInTheDocument());

  // Native DOM slicing: a normal-flow row with the shared content-visibility
  // contract, and a mounted window bounded well below the history length.
  const mounted = document.querySelectorAll<HTMLElement>(".channel-message-row");
  expect(mounted.length).toBeGreaterThan(0);
  expect(mounted.length).toBeLessThanOrEqual(300);
  expect(mounted[0].className).toContain("chat-native-row");
  expect(mounted[0].style.position).toBe("");
  expect(document.querySelector(".chat-scroll-sentinel")).not.toBeNull();
});

it("marks deleted messages with a placeholder and blanks the text", async () => {  const msg = { id: 3, channel_id: CH, user_id: ME, username: "me", avatar_url: null, content: "привет", created_at: "2026-08-20T09:00:00Z" };
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(jsonResponse([msg]))
    .mockResolvedValueOnce(
      jsonResponse({ ...msg, content: "", deleted_at: "2026-08-27T00:00:00Z" })
    );
  vi.stubGlobal("fetch", fetchMock);

  render(<ChannelChat channelId={CH} currentUserId={ME} canDeleteOthers={false} />);

  expect(await screen.findByText("привет")).toBeInTheDocument();

  // Own message → hover actions show delete button.
  fireEvent.mouseEnter(screen.getByText("привет").closest("div.group")!);
  const delBtn = document.querySelector('button[title="Удалить"]') as HTMLButtonElement | null;
  expect(delBtn).not.toBeNull();

  await act(async () => {
    fireEvent.click(delBtn!);
  });

  await waitFor(() => {
    expect(screen.getByText(/Сообщение удалено/i)).toBeInTheDocument();
  });
  expect(screen.queryByText("привет")).not.toBeInTheDocument();
});
