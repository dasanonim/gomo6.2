import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChatView } from "./ChatView";
import { __resetDraftsForTests, readDraft } from "./core/drafts";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockStore } = vi.hoisted(() => {
  return {
    mockStore: {
      conversations: [] as any[],
      selectedConversationId: null,
      messages: [] as any[],
      isMessagesLoading: false,
      isSending: false,
      me: null,
      receipts: new Map(),
      error: null,
      setError: vi.fn(),
      sendMessage: vi.fn().mockResolvedValue("msg-1"),
      editMessage: vi.fn().mockResolvedValue(undefined),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
      togglePin: vi.fn().mockResolvedValue(undefined),
      toggleNotesPin: vi.fn().mockResolvedValue(undefined),
    },
  };
});

vi.mock("@/stores/messengerStore", () => ({
    getConversationReadThrough: () => null,
  useMessengerStore: (selector: any) => selector(mockStore),
  selectSelectedConversation: (s: any) =>
    s.conversations.find((c: any) => c.id === s.selectedConversationId) ?? null,
  queueMarkDelivered: vi.fn(),
}));

vi.mock("@/components/PentagramLoader", () => ({
  PentagramLoader: ({ size }: { size: string }) => (
    <span data-testid={`loader-${size}`}>Loading...</span>
  ),
}));

vi.mock("@/components/UserBadge", () => ({
  UserBadge: ({ username, displayName }: any) => (
    <span data-testid="user-badge">{displayName || username}</span>
  ),
}));

vi.mock("@/utils/storage", () => ({
  storageUrl: (_bucket: string, key?: string | null) => key || null,
}));

vi.mock("@/hooks/useFileDrop", () => ({
  useFileDrop: () => ({ isDragging: false, dragHandlers: {} }),
}));

vi.mock("@/utils/notesCrypto", () => ({
  hasNotesKey: () => false,
}));

vi.mock("./utils", () => ({
  formatPresence: (online: boolean | null, lastSeen: string | null) =>
    online ? "в сети" : lastSeen ? "был(а) недавно" : "не в сети",
  getInitials: (name: string) => name.slice(0, 2).toUpperCase(),
  getUserColorClass: () => "color-user",
}));

vi.mock("./MessageContent", () => ({
  parseGiftContent: () => null,
  GiftDetailDialog: () => <div data-testid="gift-detail">Gift detail</div>,
}));

vi.mock("./NotesSettingsDialog", () => ({
  NotesSettingsDialog: () => <div data-testid="notes-settings" />,
}));

vi.mock("./NotesOrganizeDialog", () => ({
  NotesOrganizeDialog: () => <div data-testid="notes-organize" />,
}));

vi.mock("./UserInfoPanel", () => ({
  UserInfoPanel: ({ open, onClose }: any) =>
    open ? (
      <div data-testid="user-info-panel">
        <button onClick={onClose}>close-panel</button>
      </div>
    ) : null,
}));

vi.mock("./MessageList", () => ({
  MessageList: ({ messagesOverride, renderMessage }: any) => (
    <div data-testid="message-list">
      {messagesOverride.map((msg: any, index: number) => (
        <div key={msg.id} data-testid="message-item">
          {renderMessage(
            msg,
            index > 0 ? messagesOverride[index - 1] : null,
            { dateLabel: null, isConsecutive: false }
          )}
        </div>
      ))}
    </div>
  ),
}));

// Composer mock exposes internal props for driving send/edit flows
const { mockComposerProps, mockComposerState } = vi.hoisted(() => ({
  mockComposerProps: {} as any,
  mockComposerState: { mounts: 0, drafts: [] as string[] },
}));

vi.mock("./MessageComposer", () => ({
  MessageComposer: (props: any) => {
    Object.assign(mockComposerProps, props);
    mockComposerState.mounts += 1;
    mockComposerState.drafts.push(props.draft);
    return (
      <div data-testid="composer">
        <span data-testid="composer-draft">{props.draft}</span>
        <button onClick={() => props.onSend()}>send</button>
        <button onClick={() => props.setDraft("hello")}>set-draft</button>
        <button onClick={() => props.onSaveEdit("m1", "edited")}>save-edit</button>
        <button onClick={() => props.onCancelEdit()}>cancel-edit</button>
      </div>
    );
  },
}));

// MessageBubble mock exposes callbacks
vi.mock("./MessageBubble", () => ({
  MessageBubble: ({ message, onReply, onEdit, onDelete }: any) => (
    <div data-testid="message-bubble">
      <span>{message.content}</span>
      <button onClick={() => onReply(message)}>reply</button>
      <button onClick={() => onEdit(message.id, message.content)}>edit</button>
      <button onClick={() => onDelete(message.id)}>delete</button>
    </div>
  ),
}));

vi.mock("./attachmentAlbum", () => ({
  chunkAttachments: (attachments: any[]) => [attachments],
  MAX_ALBUM_ATTACHMENTS: 6,
}));

vi.mock("./attachmentUpload", () => ({
  uploadFilesAsAttachments: vi.fn().mockResolvedValue([]),
}));

function mockConversation(overrides: Record<string, unknown> = {}) {
  return {
    id: "conv-1",
    last_message_at: "2025-06-01T12:00:00Z",
    last_message_preview: "Hello",
    unread_count: 0,
    other_user_id: "other-1",
    other_username: "alice",
    other_avatar_url: null,
    other_display_name: null,
    other_nickname_emoji_id: null,
    other_is_online: true,
    other_last_seen_at: null,
    is_notes: false,
    is_group: false,
    member_count: 1,
    pinned_message_id: null,
    ...overrides,
  };
}

function mockMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "m1",
    conversation_id: "conv-1",
    sender_user_id: "other-1",
    sender_username: "alice",
    content: "Привет",
    sent_at: "2025-06-01T12:00:00Z",
    is_edited: false,
    is_deleted: false,
    client_id: "c1",
    ...overrides,
  };
}

const defaultProps = {
  onBack: vi.fn(),
  composerRef: { current: null } as React.RefObject<{ focus: () => void; insertText: (text: string) => void; clear: () => void; insertEmoji: (data: unknown, opts?: { focus?: boolean }) => void; getEditor: () => null } | null>,
  typingUsername: null as string | null,
  onTyping: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockStore.conversations = [];
  mockStore.selectedConversationId = null;
  mockStore.messages = [];
  mockStore.isMessagesLoading = false;
  mockStore.me = null;
  mockStore.error = null;
  mockStore.receipts = new Map();
  Object.keys(mockComposerProps).forEach((k) => delete mockComposerProps[k]);
  mockComposerState.mounts = 0;
  mockComposerState.drafts = [];
  __resetDraftsForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ChatView", () => {
  describe("composer drafts", () => {
    beforeEach(() => {
      mockStore.me = { id: "me-1", username: "me" };
      mockStore.conversations = [mockConversation(), mockConversation({ id: "conv-2", other_username: "bob" })];
      mockStore.selectedConversationId = "conv-1";
    });

    it("does not let an edit overwrite the draft, and gives it back on cancel", async () => {
      mockStore.messages = [mockMessage()];
      render(<ChatView {...defaultProps} />);
      act(() => mockComposerProps.setDraft("мой черновик"));
      expect(readDraft("conv-1")).toBe("мой черновик");

      // Start editing a message: the composer shows the message body…
      fireEvent.click(screen.getByText("edit"));
      await waitFor(() => expect(mockComposerProps.draft).toBe("Привет"));
      // …and the reader's draft is untouched.
      expect(readDraft("conv-1")).toBe("мой черновик");

      // Cancelling the edit gives the draft back.
      fireEvent.click(screen.getByText("cancel-edit"));
      await waitFor(() => expect(mockComposerProps.draft).toBe("мой черновик"));
      expect(readDraft("conv-1")).toBe("мой черновик");
    });

    it("never hands one chat's draft to the composer of another", async () => {
      const { rerender } = render(<ChatView {...defaultProps} />);
      act(() => mockComposerProps.setDraft("черновик для alice"));
      expect(mockComposerProps.draft).toBe("черновик для alice");

      const mountsBefore = mockComposerState.mounts;
      mockComposerState.drafts = [];

      // Switch chats. The composer is keyed by the conversation, so it must be
      // mounted fresh — and never mounted or rendered with the text left behind.
      mockStore.selectedConversationId = "conv-2";
      rerender(<ChatView {...defaultProps} typingUsername="bob" />);
      await waitFor(() => expect(screen.getByTestId("composer-draft").textContent).toBe(""));

      expect(mockComposerState.mounts).toBeGreaterThan(mountsBefore);
      expect(mockComposerState.drafts).not.toContain("черновик для alice");
      expect(mockComposerProps.draft).toBe("");
      expect(readDraft("conv-1")).toBe("черновик для alice");
      expect(readDraft("conv-2")).toBe("");
    });

    it("keeps a draft per conversation instead of carrying it across chats", async () => {
      const { rerender } = render(<ChatView {...defaultProps} />);
      expect(screen.getByTestId("composer-draft").textContent).toBe("");

      // Type in the first chat, through the composer's own setter.
      act(() => mockComposerProps.setDraft("черновик для alice"));
      expect(screen.getByTestId("composer-draft").textContent).toBe("черновик для alice");

      // Switching chats must not carry the text into the next one.
      mockStore.selectedConversationId = "conv-2";
      rerender(<ChatView {...defaultProps} typingUsername="bob" />);
      await waitFor(() => expect(screen.getByTestId("composer-draft").textContent).toBe(""));

      act(() => mockComposerProps.setDraft("черновик для bob"));

      // …and coming back must not have lost the first one.
      mockStore.selectedConversationId = "conv-1";
      rerender(<ChatView {...defaultProps} />);
      await waitFor(() =>
        expect(screen.getByTestId("composer-draft").textContent).toBe("черновик для alice"),
      );
    });
  });

  it("shows the empty state when no conversation is selected", () => {
    render(<ChatView {...defaultProps} />);
    expect(screen.getByText("Выбери диалог")).toBeInTheDocument();
    expect(screen.queryByTestId("composer")).not.toBeInTheDocument();
  });

  it("shows empty state when user is not loaded", () => {
    mockStore.conversations = [mockConversation()];
    mockStore.selectedConversationId = "conv-1";
    render(<ChatView {...defaultProps} />);
    expect(screen.getByText("Выбери диалог")).toBeInTheDocument();
  });

  describe("rendering a conversation", () => {
    beforeEach(() => {
      mockStore.me = { id: "me-1", username: "me" };
      mockStore.conversations = [mockConversation()];
      mockStore.selectedConversationId = "conv-1";
    });

    it("renders the chat header with the peer username", () => {
      render(<ChatView {...defaultProps} />);
      expect(screen.getByText("alice")).toBeInTheDocument();
      expect(screen.getByText("в сети")).toBeInTheDocument();
    });

    it("shows typing indicator when the peer is typing", () => {
      render(<ChatView {...defaultProps} typingUsername="alice" />);
      expect(screen.getByText(/печатает/)).toBeInTheDocument();
    });

    it("renders messages via MessageList", () => {
      mockStore.messages = [mockMessage()];
      render(<ChatView {...defaultProps} />);
      expect(screen.getByTestId("message-list")).toBeInTheDocument();
      expect(screen.getByText("Привет")).toBeInTheDocument();
    });

    it("renders the composer", () => {
      render(<ChatView {...defaultProps} />);
      expect(screen.getByTestId("composer")).toBeInTheDocument();
    });

    it("renders the pinned message banner", () => {
      mockStore.messages = [mockMessage()];
      mockStore.conversations = [
        mockConversation({ pinned_message_id: "m1" }),
      ];
      render(<ChatView {...defaultProps} />);
      // "Привет" appears both in the message bubble and the pinned banner
      expect(screen.getAllByText("Привет").length).toBeGreaterThanOrEqual(2);
      // The banner is informational only — the "jump to the pinned message"
      // affordance went away with the scroll system.
      expect(screen.queryByRole("button", { name: "Перейти" })).not.toBeInTheDocument();
    });

    it("renders the error banner and dismisses it", () => {
      mockStore.error = "Ошибка сети";
      render(<ChatView {...defaultProps} />);
      expect(screen.getByText("Ошибка сети")).toBeInTheDocument();
      fireEvent.click(screen.getByText("×"));
      expect(mockStore.setError).toHaveBeenCalledWith(null);
    });

    it("opens the user info panel on header click", () => {
      render(<ChatView {...defaultProps} />);
      fireEvent.click(screen.getByText("alice"));
      expect(screen.getByTestId("user-info-panel")).toBeInTheDocument();
    });

    it("closes the user info panel", () => {
      render(<ChatView {...defaultProps} />);
      fireEvent.click(screen.getByText("alice"));
      fireEvent.click(screen.getByText("close-panel"));
      expect(screen.queryByTestId("user-info-panel")).not.toBeInTheDocument();
    });
  });

  describe("message actions", () => {
    beforeEach(() => {
      mockStore.me = { id: "me-1", username: "me" };
      mockStore.conversations = [mockConversation()];
      mockStore.selectedConversationId = "conv-1";
      mockStore.messages = [mockMessage()];
    });

    it("replies to a message", async () => {
      render(<ChatView {...defaultProps} />);
      fireEvent.click(screen.getAllByText("reply")[0]);
      await waitFor(() => {
        expect(mockComposerProps.replyToMessage).toBeTruthy();
      });
      expect(mockComposerProps.replyToMessage.id).toBe("m1");
    });

    it("starts editing a message", () => {
      render(<ChatView {...defaultProps} />);
      fireEvent.click(screen.getByText("edit"));
      expect(mockComposerProps.editingMessageId).toBe("m1");
      expect(mockComposerProps.editingContent).toBe("Привет");
    });

    it("focuses the composer when starting an edit so the keyboard opens", () => {
      const focus = vi.fn();
      render(
        <ChatView
          {...defaultProps}
          composerRef={{
            current: {
              focus,
              insertText: vi.fn(),
              clear: vi.fn(),
              insertEmoji: vi.fn(),
              getEditor: () => null,
            },
          }}
        />,
      );
      fireEvent.click(screen.getByText("edit"));
      expect(focus).toHaveBeenCalledOnce();
    });

    it("deletes a message", async () => {
      render(<ChatView {...defaultProps} />);
      fireEvent.click(screen.getByText("delete"));
      expect(mockStore.deleteMessage).toHaveBeenCalledWith("m1");
    });

    it("sends a new message via the composer", async () => {
      render(<ChatView {...defaultProps} />);
      fireEvent.click(screen.getByText("set-draft"));
      fireEvent.click(screen.getByText("send"));
      await waitFor(() => {
        expect(mockStore.sendMessage).toHaveBeenCalled();
      });
      expect(mockStore.sendMessage).toHaveBeenCalledWith(
        "hello",
        expect.any(String),
        undefined,
        undefined
      );
    });

    it("saves an edit via the composer", async () => {
      render(<ChatView {...defaultProps} />);
      fireEvent.click(screen.getByText("edit"));
      fireEvent.click(screen.getByText("save-edit"));
      await waitFor(() => {
        expect(mockStore.editMessage).toHaveBeenCalledWith("m1", "edited");
      });
    });

    it("does not send when draft is empty", async () => {
      render(<ChatView {...defaultProps} />);
      fireEvent.click(screen.getByText("send"));
      expect(mockStore.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe("notes chat", () => {
    beforeEach(() => {
      mockStore.me = { id: "me-1", username: "me" };
      mockStore.conversations = [
        mockConversation({ id: "notes-1", is_notes: true, other_username: null, member_count: 0 }),
      ];
      mockStore.selectedConversationId = "notes-1";
    });

    it("shows the notes header", () => {
      render(<ChatView {...defaultProps} />);
      expect(screen.getByText("Заметки")).toBeInTheDocument();
    });

    it("renders pinned notes in a dedicated section", () => {
      mockStore.messages = [
        mockMessage({ id: "n1", content: "Закреплённая заметка", notesPinned: true }),
        mockMessage({ id: "n2", content: "Обычная заметка", notesPinned: false }),
      ];
      render(<ChatView {...defaultProps} />);
      expect(screen.getByText("Закреплённые")).toBeInTheDocument();
      expect(screen.getByText("Закреплённая заметка")).toBeInTheDocument();
      expect(screen.getByText("Обычная заметка")).toBeInTheDocument();
    });

    it("filters notes by folder", async () => {
      mockStore.messages = [
        mockMessage({ id: "n1", content: "Рабочая", notesFolder: "Работа", notesPinned: false }),
        mockMessage({ id: "n2", content: "Личная", notesFolder: "Личное", notesPinned: false }),
      ];
      render(<ChatView {...defaultProps} />);

      fireEvent.click(screen.getByRole("button", { name: "Работа" }));

      await waitFor(() => {
        expect(screen.queryByText("Личная")).not.toBeInTheDocument();
        expect(screen.getByText("Рабочая")).toBeInTheDocument();
      });
    });

    it("shows empty notes state when there are no messages", () => {
      render(<ChatView {...defaultProps} />);
      expect(screen.getByText("Личные Заметки")).toBeInTheDocument();
    });

    it("opens notes settings dialog from the header", () => {
      render(<ChatView {...defaultProps} />);
      fireEvent.click(screen.getByText("Заметки"));
      expect(screen.getByTestId("notes-settings")).toBeInTheDocument();
    });
  });

  describe("escape key", () => {
    it("calls onBack when Escape is pressed", () => {
      mockStore.me = { id: "me-1", username: "me" };
      mockStore.conversations = [mockConversation()];
      mockStore.selectedConversationId = "conv-1";
      const onBack = vi.fn();
      render(<ChatView {...defaultProps} onBack={onBack} />);
      fireEvent.keyDown(window, { key: "Escape" });
      expect(onBack).toHaveBeenCalled();
    });

    it("does not navigate back while editing", () => {
      mockStore.me = { id: "me-1", username: "me" };
      mockStore.conversations = [mockConversation()];
      mockStore.selectedConversationId = "conv-1";
      mockStore.messages = [mockMessage()];
      const onBack = vi.fn();
      render(<ChatView {...defaultProps} onBack={onBack} />);
      fireEvent.click(screen.getByText("edit"));
      fireEvent.keyDown(window, { key: "Escape" });
      expect(onBack).not.toHaveBeenCalled();
    });
  });
});
