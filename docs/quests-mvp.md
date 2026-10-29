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
- Правило экономики MVP: обычные уровни — гемы по нарастающей, дропсы —
  только топ-уровни и мета-квест. Конвертации гемы→дропсы нет.
- Сундук: `POST /quests/chests/:id/open` играет полную сессию
  `gamification` на сервере (crypto/rand) и кредитует гемы. Открытие
  идемпотентно (`opened_at`).

## Каталог MVP (17 групп)

Первые шаги (one_time, по 10–20 гемов): `qs_avatar`, `qs_bio`,
`qs_first_thread`, `qs_first_wall`, `qs_first_comment`, `qs_like_given`,
`qs_sub_join`, `qs_follow`, `qs_style`. Мета `qs_complete` (9/9): 100 гемов +
5 дропсов + сундук.

Лестница: `entries` 1/10/50/250/1000, `comments` 1/25/150/750,
`likes_given` 1/50/300, `likes_received` 10/100/500/2000,
`subs_joined` 1/5, `sub_created` 1, `follows` 1/10/50.

## Фронт

- `/achievements/:userId`: чеклист первых шагов + лестница с барами
  (`progress_current/threshold`) + кнопки «Забрать» (только владелец) +
  сундуки с кнопкой «Открыть». Гемы и бейдж `unclaimed_count` в шапке.
- Тост на `achievement_unlock` по WS — только навигационный
  (`QuestToastListener`), без кнопки клейма. Незаклеймленное висит вечно.
- Ручные награды из UI убраны (профиль и страница их не рендерят).
