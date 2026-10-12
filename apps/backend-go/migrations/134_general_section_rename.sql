-- 134_general_section_rename.sql
--
-- Issue #506: «Общение» → «Общее», и без подразделов.
--
-- The catch-all section must be one flat place: «Знакомства» and «Встречи»
-- were just chats that belong in the section itself, so every topic that lived
-- in a «general» подраздел is lifted up to the section and the подраздел rows
-- are removed. Other разделы keep their подразделы untouched.
--
-- Idempotent — safe on any DB state (fresh installs already seed the final
-- shape in 114, so both steps are no-ops there).

-- 1. Rename. The description no longer advertises the removed подразделы.
UPDATE thread_sections
SET name        = 'Общее',
    description = 'Всё обо всём — общие темы и обсуждения'
WHERE slug = 'general';

-- 2. Lift topics out of every «general» подраздел, then drop those подразделы.
WITH general AS (
    SELECT id FROM thread_sections WHERE slug = 'general'
),
general_subs AS (
    SELECT ss.id
    FROM thread_subsections ss
    JOIN thread_sections s ON s.id = ss.section_id
    WHERE s.slug = 'general'
)
UPDATE threads t
SET section_id    = (SELECT id FROM general),
    subsection_id = NULL
WHERE t.subsection_id IN (SELECT id FROM general_subs);

DELETE FROM thread_subsections ss
USING thread_sections s
WHERE s.id = ss.section_id AND s.slug = 'general';
