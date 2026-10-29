-- 146_section_icons_round2.sql
--
-- Иконки разделов, выбранные вручную: Смешное — cat, Новостное — zap,
-- Вопросное — compass. Общее остаётся на hash.
--
-- Idempotent — safe on any DB state.

UPDATE thread_sections SET icon = 'cat' WHERE slug = 'humor' AND icon <> 'cat';
UPDATE thread_sections SET icon = 'zap' WHERE slug = 'news' AND icon <> 'zap';
UPDATE thread_sections SET icon = 'compass' WHERE slug = 'help' AND icon <> 'compass';
UPDATE thread_sections SET icon = 'hash' WHERE slug = 'general' AND icon <> 'hash';
