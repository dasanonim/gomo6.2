-- 143_public_id_no_reserve.sql
--
-- Убираем резервные полосы номеров (users с 10, threads со 100).
-- Решение из 128 (держать 1..9 и 1..99 под систему/редакционку/рынок) себя не
-- оправдало: первые ссылки сайта выглядели как баг (#10, #100), а рынок номеров
-- (129 + assign-хендлер) так и остался выключенным. Контента почти нет, ссылки
-- в дикой природе не разошлись — перенумеровываемся один раз и живём с 1.
--
-- Что делает:
--   1. users/threads/profile_wall_posts нумеруются заново с 1 по created_at.
--      Сервисная строка __system__ (00000000-...) из нумерации исключается —
--      у инфраструктуры нет человеческого номера, ей ставится NULL.
--   2. users.public_id становится NULLABLE: NULL = служебная строка без номера.
--      Резолвер и так отвергает всё неположительное, фронт падает в UUID-фолбэк.
--   3. Леджер трансферов public_id_transfers удаляется вместе с самой механикой
--      рынка (хендлер AssignPublicID удалён из кода тем же ченджем).
--   4. setval безусловный: пустая таблица → sequence на 0 → первый nextval = 1.
--
-- Idempotent — safe на любом состоянии (повторный прогон просто перенумерует
-- заново в том же порядке; порядок created_at стабилен через tiebreak по id).

-- ── 1. Перенумерация с 1 ───────────────────────────────────────────────────
-- users: пропускаем сервисную строку, ей ниже ставится NULL.
UPDATE users u SET public_id = s.rn
FROM (SELECT id, row_number() OVER (ORDER BY created_at, id) AS rn
      FROM users WHERE id <> '00000000-0000-0000-0000-000000000000') s
WHERE u.id = s.id;

UPDATE threads t SET public_id = s.rn
FROM (SELECT id, row_number() OVER (ORDER BY created_at, id) AS rn FROM threads) s
WHERE t.id = s.id;

UPDATE profile_wall_posts w SET public_id = s.rn
FROM (SELECT id, row_number() OVER (ORDER BY created_at, id) AS rn FROM profile_wall_posts) s
WHERE w.id = s.id;

-- ── 2. Сервисная строка без номера + NULLABLE ───────────────────────────────
ALTER TABLE users ALTER COLUMN public_id DROP NOT NULL;

UPDATE users SET public_id = NULL
WHERE id = '00000000-0000-0000-0000-000000000000';

-- ── 3. Долой леджер рынка ───────────────────────────────────────────────────
DROP TABLE IF EXISTS public_id_transfers;

-- ── 4. Sequences продолжают с MAX+1; на пустой таблице первый номер = 1 ────
SELECT setval('users_public_id_seq', COALESCE((SELECT MAX(public_id) FROM users), 0));
SELECT setval('threads_public_id_seq', COALESCE((SELECT MAX(public_id) FROM threads), 0));
SELECT setval('profile_wall_posts_public_id_seq', COALESCE((SELECT MAX(public_id) FROM profile_wall_posts), 0));
