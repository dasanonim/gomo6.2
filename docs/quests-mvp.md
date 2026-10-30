# Квесты MVP («геймификация, первые шаги»)

Статус: реализовано. Заменяет престиж-систему из `docs/achievements-awards.md`
(редкие вехи, ручные награды, проценты владельцев — всё выведено из UI;
таблицы `user_awards` и admin-API наград оставлены в БД как есть, но фронт их
больше не показывает).

## Модель

- **Каталог в Go** (`internal/achievements/default_catalog.go`) — источник правды.
  Таблица `achievements` — зеркало (`Sync`), читается прогресс-ручкой.
- **Треки:** `first_steps` (чеклист онбординга, свободный порядок) и `main`
  (прогрессивная лестница). Ничего скрытого: каждый квест виден с прогрессом.
- **Квест** = counter (`sourceCount`, сверка с живыми данными — self-healing)
  или один derived (`qs_complete`: число закрытых первых шагов).
- Уровень открывается движком (`user_achievements.current_level` только растёт),
  а награда движется **только через клейм**.

## Клейм и награды

- `POST /quests/claim {quest_key, level}` → `Engine.ClaimLevel`: проверка
  `current_level >= level`, вставка в `quest_claims` (`ON CONFLICT DO NOTHING` —
  повтор = 409 без побочных эффектов), выдача наград в той же транзакции.
- Типы наград (`RewardKind`): `gems` (`users.gems`), `drops`
  (`drops_transactions` тип `quest_reward`), `chest` (строка в `quest_chests`).
  Новый тип = ветка в `grantReward`, движок и таблицы клеймов не меняются.
- Правило экономики (реворк kvestikiref): мелкие уровни — скромные дропсы
  (анти-инфляция, ~500–1000 дропсов за активный первый месяц), топы жирнее,
  гемы — на финале каждого трека, сундуки — только верхние уровни сложных
  треков. Конвертации нет. Леджер отличает свежие клеймы (`quest`, типы
  `quest_reward`/`quest_reward_gems`) от доплат после реворка (`quest_recalc`).
- Пересчёт после смены каталога: `Engine.ReconcileUser` доплачивает
  `max(новая сумма − уже выдано, 0)` по каждому заслуженному уровню (без
  отката), `POST /quests/reconcile` — кнопка «Проверить награды», прогресс
  отдаёт `recalc_available` + `catalog_updated_at` для баннера «Квесты обновлены».
- Сундук: `POST /quests/chests/:id/open` играет полную сессию
  `gamification` на сервере (crypto/rand) и кредитует дропсы. Открытие
  идемпотентно (`opened_at`).

## Каталог (24 группы, реворк kvestikiref)

Первые шаги (one_time, по 8–12 дропсов): `qs_avatar`, `qs_bio`,
`qs_first_thread`, `qs_first_wall`, `qs_first_comment`, `qs_like_given`,
`qs_sub_join`, `qs_follow`, `qs_style`. Мета `qs_complete` (9/9): 80 дропсов +
5 гемов + сундук.

Лестницы: `entries` 1/10/25/100/500/1500, `comments` 1/15/60/250/1000,
`likes_given` 1/25/100/500/1500, `likes_received` 10/50/200/800/3000,
`media_uploads` 1/10/50/200, `subs_joined` 1/3/8/20, `sub_created` 1,
`follows` 1/5/20/80, `friends_mutual` 1/5/15, `gifts_sent` 1/5/25,
`gifts_received` 1/5/25, `visits_total` 3/10/30/100/365,
`visit_streak` 3/7/14/30, `tenure_days` 10/30/100/365.

Дейлики — только архитектура (хуки движка), без UI: следующим заходом.

## Фронт

- `/achievements/:userId`: чеклист первых шагов + лестница с барами
  (`progress_current/threshold`) + кнопки «Забрать» (только владелец) +
  сундуки с кнопкой «Открыть». Гемы и бейдж `unclaimed_count` в шапке.
- Тост на `achievement_unlock` по WS — только навигационный
  (`QuestToastListener`), без кнопки клейма. Незаклеймленное висит вечно.
- Ручные награды из UI убраны (профиль и страница их не рендерят).
