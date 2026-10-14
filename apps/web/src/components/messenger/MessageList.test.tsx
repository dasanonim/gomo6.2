import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { MessageList, type MessageRenderExtras } from "./MessageList";
import type { MessageView } from "./types";

// ── Hoisted shared state (accessible from vi.mock factories) ──────────────
const h = vi.hoisted(() => ({
  storeState: {
    messages: [] as unknown[],
  },
}));

vi.mock("@/stores/messengerStore", () => ({
  useMessengerStore: (selector: (state: typeof h.storeState) => unknown) => selector(h.storeState),
}));

const makeMessage = (id: string, overrides: Partial<MessageView> = {}): MessageView => ({
  id,
  conversation_id: "c1",
  sender_user_id: "u1",
  parent_message_id: null,
  content: `msg-${id}`,
  is_edited: false,
  is_deleted: false,
  edited_at: null,
  sent_at: "2026-08-08T12:00:00.000Z",
  client_id: id,
  ...overrides,
});

/** Captures every (message, prev, extras) tuple the list hands to the renderer. */
const captured: Array<{ id: string; prevId: string | null; extras: MessageRenderExtras }> = [];

const renderMessage = (message: MessageView, prev: MessageView | null, extras: MessageRenderExtras) => {
  captured.push({ id: message.id, prevId: prev?.id ?? null, extras });
  return <div data-testid={`msg-${message.id}`}>{message.content}</div>;
};

const mountList = (props: Partial<Parameters<typeof MessageList>[0]> = {}) =>
  render(<MessageList renderMessage={renderMessage} {...props} />);

beforeEach(() => {
  cleanup();
  captured.length = 0;
  h.storeState.messages = [];
});

describe("MessageList (plain list)", () => {
  it("renders every stored message in source order — no windowing", () => {
    h.storeState.messages = [makeMessage("a"), makeMessage("b"), makeMessage("c")];

    const { container } = mountList();

    expect(container.querySelectorAll(".message-row")).toHaveLength(3);
    expect(Array.from(container.querySelectorAll(".message-row")).map((row) => row.getAttribute("data-message-id")))
      .toEqual(["a", "b", "c"]);
    expect(captured.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    // Each row sees the message before it (null for the first).
    expect(captured.map((entry) => entry.prevId)).toEqual([null, "a", "b"]);
  });

  it("hands the renderer the grouping + date extras", () => {
    h.storeState.messages = [
      makeMessage("a", { sent_at: "2026-08-08T12:00:00.000Z" }),
      // Same sender within 2 minutes → consecutive, same day → no date label.
      makeMessage("b", { sent_at: "2026-08-08T12:01:00.000Z" }),
      // Next day → new date separator.
      makeMessage("c", { sent_at: "2026-08-09T09:00:00.000Z" }),
    ];

    mountList();

    expect(captured[0].extras.isConsecutive).toBe(false); // first message has no previous
    expect(captured[0].extras.dateLabel).toBeTruthy();
    expect(captured[1].extras.isConsecutive).toBe(true);
    expect(captured[1].extras.dateLabel).toBeNull();
    expect(captured[2].extras.isConsecutive).toBe(false); // more than 2 minutes apart
    expect(captured[2].extras.dateLabel).toBeTruthy();
  });

  it("prefers messagesOverride over the store list", () => {
    h.storeState.messages = [makeMessage("stored")];

    mountList({ messagesOverride: [makeMessage("notes-1"), makeMessage("notes-2")] });

    expect(captured.map((entry) => entry.id)).toEqual(["notes-1", "notes-2"]);
  });

  it("renders nothing when there are no messages", () => {
    const { container } = mountList();

    expect(container.querySelector(".message-scroll")).toBeNull();
    expect(captured).toHaveLength(0);
  });

  it("leaves no scroll-system surface behind", () => {
    h.storeState.messages = [makeMessage("a")];

    const { container } = mountList();

    // The scroller stays (native scrolling) …
    expect(container.querySelector(".message-scroll")).not.toBeNull();
    // … but none of the removed affordances come back.
    expect(container.querySelector(".scroll-to-bottom-btn")).toBeNull();
    expect(container.querySelector(".scroll-to-bottom-badge")).toBeNull();
    expect(container.querySelector(".msg-history-header")).toBeNull();
    expect(container.querySelector(".message-list-footer")).toBeNull();
    expect(container.querySelector(".message-virtual-list")).toBeNull();
  });
});
