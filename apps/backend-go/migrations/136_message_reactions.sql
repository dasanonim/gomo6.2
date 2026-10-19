-- Messenger message reactions (Unicode emoji, one row per user per emoji).
-- Migration: 136_message_reactions.sql
--
-- The conversation id is denormalized: a reaction event is fanned out to the
-- `chat_<conversation>` WebSocket room, and the hub routes by that key alone —
-- a reaction on a message the client no longer holds can then be ignored
-- without a second lookup.

CREATE TABLE IF NOT EXISTS message_reactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id UUID NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    conversation_id UUID NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT message_reactions_unique UNIQUE (message_id, user_id, emoji)
);

CREATE INDEX IF NOT EXISTS idx_message_reactions_message
    ON message_reactions (message_id, created_at);

CREATE INDEX IF NOT EXISTS idx_message_reactions_conversation
    ON message_reactions (conversation_id, created_at DESC);

-- RLS: a reaction is visible to the conversation's members, and only a member
-- may write their own row. Same shape as message_attachments (062).
ALTER TABLE message_reactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY reactions_select ON message_reactions FOR SELECT USING (
    EXISTS (
        SELECT 1 FROM chat_members cm
        WHERE cm.conversation_id = message_reactions.conversation_id
          AND cm.user_id = current_setting('app.current_user_id', true)::UUID
    )
);

CREATE POLICY reactions_insert ON message_reactions FOR INSERT WITH CHECK (
    user_id = current_setting('app.current_user_id', true)::UUID
    AND EXISTS (
        SELECT 1 FROM chat_members cm
        WHERE cm.conversation_id = message_reactions.conversation_id
          AND cm.user_id = current_setting('app.current_user_id', true)::UUID
    )
);

CREATE POLICY reactions_delete ON message_reactions FOR DELETE USING (
    user_id = current_setting('app.current_user_id', true)::UUID
);
