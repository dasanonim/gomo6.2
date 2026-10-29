-- 145_rename_sections_short.sql
--
-- Короткие имена разделов: Общее / Смешное / Новостное / Вопросное.
--
-- Idempotent — safe on any DB state.

UPDATE thread_sections SET name = 'Смешное' WHERE slug = 'humor' AND name <> 'Смешное';
UPDATE thread_sections SET name = 'Новостное' WHERE slug = 'news' AND name <> 'Новостное';
UPDATE thread_sections SET name = 'Вопросное' WHERE slug = 'help' AND name <> 'Вопросное';
UPDATE thread_sections SET name = 'Общее' WHERE slug = 'general' AND name <> 'Общее';
