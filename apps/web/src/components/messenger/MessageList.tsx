import { memo, type ReactNode } from "react";
import { useMessengerStore } from "@/stores/messengerStore";
import type { MessageView } from "./types";
import { isConsecutive, getDateSeparator } from "./messageListUtils";

export interface MessageRenderExtras {
  dateLabel: string | null;
  isConsecutive: boolean;
}

interface MessageListProps {
  renderMessage: (message: MessageView, prev: MessageView | null, extras: MessageRenderExtras) => ReactNode;
  /** Notes self-chat: a filtered view of the store messages (folder filter).
   *  When omitted the full store list is used. */
  messagesOverride?: MessageView[];
}

/**
 * Renders the messages of the open conversation.
 *
 * There is deliberately no scroll system here. The list is a plain column
 * inside a natively-scrolling container (`overflow-y: auto`): the browser owns
 * scrolling completely. No virtualizer, no bottom pin, no scroll anchor, no
 * session scroll restore, no history paging on scroll, no visible-message read
 * reporting, no "scroll to bottom" affordance — every message the store holds
 * is rendered in source order.
 *
 * It is mounted per conversation (`key={conversation.id}` in ChatView), so
 * switching chats naturally rebuilds the whole subtree.
 */
export const MessageList = memo(function MessageList({ renderMessage, messagesOverride }: MessageListProps) {
  const storeMessages = useMessengerStore((s) => s.messages);
  // Notes self-chat passes a folder-filtered view; regular chats use the full list.
  const messages = messagesOverride ?? storeMessages;

  if (messages.length === 0) return null;

  return (
    <div className="message-scroll-wrap">
      <div className="message-scroll" role="log" aria-label="Сообщения" aria-live="polite">
        <div className="message-list">
          {messages.map((message, index) => {
            const prev = index > 0 ? messages[index - 1] : null;
            return (
              // Identity key matches the store's dedup key (client_id || id), so a
              // temp message later replaced by its server twin keeps its slot.
              <div
                key={message.client_id ?? message.id}
                data-message-id={message.id}
                className="message-row"
              >
                {renderMessage(message, prev, {
                  dateLabel: getDateSeparator(prev, message),
                  isConsecutive: isConsecutive(prev, message),
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
});
