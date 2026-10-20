# Contributing

Краткая памятка по конвенциям и процессу релизов. Подробности архитектуры — в `AGENTS.md`.

## Коммиты

Сообщения коммитов — в стиле [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(profile): profile studio — все настройки оформления в одном месте
fix(messenger): композер над клавиатурой на iOS
refactor(backend): вынести переводы в internal/translations
perf(cache): ...  |  security(auth): ...  |  test(...): ...  |  chore(...): ...
```

Это не бюрократия: типы кормят автоматическую классификацию изменений между релизами.

## Версионирование

SemVer, **одна версия на всё монорепо** (продукт деплоится одним стеком). Источник истины — тег `vX.Y.Z`; рабочая копия версии — единственный файл `VERSION` в корне (без дублей в package.json — они только ломают docker-кэш фронтендов).

Что означает каждый шаг для **продукта** (не библиотеки):

| Шаг | Когда |
|-----|-------|
| **MAJOR** | Пользователь видит ломку/новое поколение: кардинальный UX, удаление фич, смена внешних контрактов (URL, API, феды) |
| **MINOR** | Новая заметная фича (студия, переводы, достижения — «посмотрите на нас») |
| **PATCH** | Багфиксы, перф, мелочи — пользователь не видит ничего нового |

## Релизы (release-please, без ручного ритуала)

Версию, CHANGELOG и тег теперь ведёт [release-please](https://github.com/googleapis/release-please)
(`.github/workflows/release-please.yml`). Руками — только текст заметок.

1. Работа идёт через PR; merge — **Squash and merge**. Тема PR (`feat(scope): ...`,
   `fix: ...`) становится коммитом в `main` и именно её читает release-please.
2. После мержа бот сам открывает PR `chore: release vX.Y.Z`: правит `VERSION`,
   `.release-please-manifest.json` и дописывает секцию в `CHANGELOG.md`.
   Номер он считает по коммитам с прошлого тега: `feat` → minor, `fix`/`perf` → patch,
   `!`/`BREAKING CHANGE` → major; `ci`/`docs`/`chore`/`test`/`style` версию не двигают.
3. **Перед мержем Release PR — перепиши секцию CHANGELOG по-человечески** (русский текст,
   объяснение «что почувствует пользователь»). Бот даёт скелет, а не финальный текст.
4. Мерж Release PR → release-please ставит аннотированный тег `vX.Y.Z` и создаёт
   GitHub Release с этим текстом. Деплой подхватывается сам (VERSION изменился →
   пересобираются все сервисы, теги `:vX.Y.Z`, `:latest`, `:sha-<commit>`).
5. Проверить: `curl -s https://gomo6.wtf/health` и футер сайта.

Что важно знать:
- версия одна на всё монорепо, источник истины — файл `VERSION` (его читают Dockerfile'ы
  и `deploy.yml`), дублей в `package.json` нет намеренно;
- Release PR создаётся от `RELEASE_PLEASE_TOKEN` (fine-grained PAT), а не от `GITHUB_TOKEN`:
  иначе его PR не запускает CI и обязательный чек `CI · все проверки` не появится;
- если нужно выпустить релиз, не дожидаясь новой фичи (например, только важный фикс) —
  это делает тот же PR, ничего вручную подкручивать не надо.

## Откат прода

Каждый деплой оставляет образ `ghcr.io/elcrazycol/gomo6-<service>:sha-<commit>`. Откатить сервис к конкретному деплою:

```bash
ssh root@VPS "REG=ghcr.io/elcrazycol COMPOSE_NAMESPACE=ghcr.io/elcrazycol TAG=sha-<commit> bash /tmp/gomo6-restart-service.sh web"
```

(скрипт заново заберёт свежий `restart-service.sh` с mаина, так что тег `sha-<commit>` должен существовать в образе этого деплоя).