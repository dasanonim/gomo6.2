-- 142_trim_sections_launch.sql
--
-- Launch trim: оставляем только 4 раздела для старта —
-- general (Общее), humor (Юмор и мемы), news (Новости и общество),
-- help (Помощь и вопросы). Всё остальное (games, tech, creative, nsfw)
-- вырезаем, чтобы пустой сайт не выглядел заброшенным.
--
-- Топики из удаляемых разделов переезжают в «Общее» (не удаляем контент),
-- подразделы удаляются каскадом вместе с разделом.
--
-- Idempotent — safe on any DB state.

-- 1. Переселить топики в «Общее».
WITH general AS (
    SELECT id FROM thread_sections WHERE slug = 'general'
)
UPDATE threads t
SET section_id    = (SELECT id FROM general),
    subsection_id = NULL
WHERE t.section_id IN (
    SELECT id FROM thread_sections
    WHERE slug IN ('games', 'tech', 'creative', 'nsfw')
);

-- 2. Удалить разделы (подразделы уйдут по ON DELETE CASCADE).
DELETE FROM thread_sections
WHERE slug IN ('games', 'tech', 'creative', 'nsfw');

-- 3. Подтянуть порядок, чтобы не было дыр 60/70.
UPDATE thread_sections SET sort_order = 10 WHERE slug = 'general';
UPDATE thread_sections SET sort_order = 20 WHERE slug = 'humor';
UPDATE thread_sections SET sort_order = 30 WHERE slug = 'news';
UPDATE thread_sections SET sort_order = 40 WHERE slug = 'help';
