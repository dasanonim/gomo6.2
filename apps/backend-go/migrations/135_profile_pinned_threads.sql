-- Закреплённые темы на странице профиля («Закреплённые темы»).
--
-- Владелец профиля (user_id) закрепляет до трёх тем (thread_id) — своих или
-- чужих — и они показываются коротким списком между панелью информации и
-- табами. Лимит 3 держится на запись (crudengine preparePinnedThreadBody),
-- position задаёт порядок отображения.
--
-- Права: user_id всегда = вызывающий (OwnSingle в реестре crudengine), поэтому
-- закрепить тему можно только в свой профиль. Видимость самой темы (приватная
-- доска, приватный профиль владельца, скрытые разделы) проверяется на чтение —
-- и в handleProfilePinnedThreadsGet, и в GET /threads, которым фронтенд
-- достраивает строки, — так что закрепление не даёт доступа к скрытому
-- контенту.
--
-- Migration: 135_profile_pinned_threads.sql

CREATE TABLE IF NOT EXISTS profile_pinned_threads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    thread_id UUID NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, thread_id)
);

-- The profile block reads one owner's pins in display order.
CREATE INDEX IF NOT EXISTS idx_profile_pinned_threads_user_position
    ON profile_pinned_threads(user_id, position);
-- Thread deletion cascades; this index keeps the cascade and the "is this thread
-- pinned anywhere" lookups cheap.
CREATE INDEX IF NOT EXISTS idx_profile_pinned_threads_thread
    ON profile_pinned_threads(thread_id);
