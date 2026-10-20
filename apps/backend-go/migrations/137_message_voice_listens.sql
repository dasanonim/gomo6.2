-- Per-user "listened" state for voice messages.
-- Migration: 137_message_voice_listens.sql
--
-- The dot on a voice note is a fact about a PERSON, not about the message: an
-- incoming note is unheard until I play it, and my own note is "unheard" for the
-- sender until the peer plays it. A row here means "this user has listened".
-- No flag on chat_messages: in a group every member has their own answer.

CREATE TABLE IF NOT EXISTS message_voice_listens (
    message_id UUID NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    listened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (message_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_message_voice_listens_message
    ON message_voice_listens (message_id);

-- RLS: a member of the conversation sees who listened (that is the point of the
-- dot), and may only write their own row. Same shape as message_attachments.
ALTER TABLE message_voice_listens ENABLE ROW LEVEL SECURITY;

CREATE POLICY voice_listens_select ON message_voice_listens FOR SELECT USING (
    EXISTS (
        SELECT 1 FROM chat_messages m
        JOIN chat_members cm ON cm.conversation_id = m.conversation_id
        WHERE m.id = message_voice_listens.message_id
          AND cm.user_id = current_setting('app.current_user_id', true)::UUID
    )
);

CREATE POLICY voice_listens_insert ON message_voice_listens FOR INSERT WITH CHECK (
    user_id = current_setting('app.current_user_id', true)::UUID
    AND EXISTS (
        SELECT 1 FROM chat_messages m
        JOIN chat_members cm ON cm.conversation_id = m.conversation_id
        WHERE m.id = message_voice_listens.message_id
          AND cm.user_id = current_setting('app.current_user_id', true)::UUID
    )
);
