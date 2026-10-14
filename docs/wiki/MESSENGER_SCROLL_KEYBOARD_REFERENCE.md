# Скролл и клавиатура чата: эталонная схема (что делают большие)

Дата: 2026-10-14. Дополнение к [`MESSENGER_V3_RFC.md`](./MESSENGER_V3_RFC.md).

Цель — заменить самодельный движок скролла и клавиатурную хореографию на **отраслевые
стандарты** и то, что уже реализовано в библиотеке, которую проект и так использует.

---

## 0. Главный вывод (TL;DR)

1. **Скролл.** `@tanstack/react-virtual` — та же библиотека, что уже в проекте — с версии,
   которая **уже установлена** (`virtual-core@3.17.1`), имеет **first-class режим чата**:
   `anchorTo: 'end'`, `followOnAppend`, `scrollEndThreshold`, `scrollToEnd()`, `isAtEnd()`.
   Это заменяет почти весь наш `useStickToBottom` + `scrollEngine` (пин, живой якорь, рестор,
   самолечение измерений). Не нужно писать «свою физику скролла».
2. **Клавиатура.** `interactive-widget=resizes-content` в `viewport` **у нас уже стоит**
   (`apps/web/index.html:47`) — на Android Chromium/Firefox раскладка сама ужимается, и
   никаких костылей не нужно. Проблема остаётся **только на iOS Safari**, где этого свойства
   нет до сих пор; там стандарт — `visualViewport` + `dvh`, и **нельзя** использовать
   `position: fixed/sticky`-как-единственный механизм (он багует с клавиатурой).
3. **Telegram Web K (tweb)** не использует библиотеку виртуализации, но строит ровно те же
   концепции вручную: `isScrolledToEnd`, `ignoreNextScrollEvent`, `setScrollPositionSilently`,
   триггеры с порогом 300px и throttled-измерение. То есть «правильный» набор примитивов нам
   известен — и его даёт библиотека из коробки.

---

## 1. Что делают большие

### 1.1 TanStack Virtual — режим чата (рекомендация №1)

Официальная документация: <https://tanstack.com/virtual/latest/docs/chat>, анонс:
<https://tanstack.com/blog/tanstack-virtual-chat>.

```tsx
const virtualizer = useVirtualizer({
  count: messages.length,
  getScrollElement: () => parentRef.current,
  estimateSize: () => 72,
  getItemKey: (index) => messages[index]!.id,   // СТАБИЛЬНЫЙ ключ, не индекс
  anchorTo: 'end',            // конец — «стабильный» край
  followOnAppend: true,       // держать низ только если пользователь уже внизу
  scrollEndThreshold: 80,     // насколько близко к концу считается «внизу»
  overscan: 6,
})
```

Что это даёт (проверено в `node_modules/@tanstack/virtual-core/dist/esm/index.js`):
- **`anchorTo: 'end'`** — при **препенде** старой истории библиотека сама запоминает видимый
  элемент и после вставки сдвигает `scrollTop` так, чтобы он остался на месте. Никаких
  `scrollTop += delta`.
- **`followOnAppend`** — новое сообщение удерживает низ, только если пользователь был у низа;
  если он читает историю — не выдёргивает.
- **рост последнего элемента** (стриминг, поздние измерения картинок) — в end-режиме
  виртуализатор сам компенсирует дельту высоты, пока вьюпорт у конца. Это ровно наш
  «самолечащийся пин» из issue #508, но реализованный и протестированный библиотекой.
- **`isAtEnd()` / `getDistanceFromEnd()` / `scrollToEnd()`** — для кнопки «вниз» и пилюли
  «N новых».
- Значения по умолчанию: `anchorTo: 'start'`, `followOnAppend: false`, `scrollEndThreshold: 1`.
- Дополнительно доступны `initialOffset`, `initialMeasurementsCache` (рестор), `scrollMargin`
  (отступ контента от края скроллера), `cancelScroll`, `scrollToIndex`, а также
  **`directDomUpdates`** — виртуализатор сам пишет позиции элементов и высоту контейнера прямо
  в DOM и **не ре-рендерит React на скролл** (большая часть жалоб прошлого ревью на «ре-рендер
  на каждое движение» снимается этим флагом).

Ключевые требования (совпадают с тем, что у нас уже есть): стабильные `getItemKey`, обычный
скроллер с `overflow: auto`, `measureElement` для динамических высот, нормальный порядок
элементов (**не** `column-reverse` и **не** инвертированные трансформы).

### 1.2 Telegram Web K (`morethanwords/tweb`) — как делают они

Исходник: <https://github.com/morethanwords/tweb/blob/master/src/components/scrollable.ts>.

- Свой класс `Scrollable`/`ScrollableBase` с кастомным скроллбаром (`scrollable-thumb`), потому
  что им нужен единый вид скроллбара, а не физика.
- Примитивы «прилипания», которые нам и нужны:
  - `get isScrolledToEnd() { return this.getDistanceToEnd() <= 1; }` — «у низа»;
  - `setScrollPositionSilently(value)` + `ignoreNextScrollEvent()` — программный скролл **не**
    должен считаться пользовательским (иначе слетает «прилипание»);
  - `checkForTriggers()` с `onScrollOffset = 300` — подгрузка истории у края;
  - throttled измерение (`requestAnimationFrame` или `setTimeout(24)`) + `isHeavyAnimationInProgress`
    (во время анимаций скролл не трогают).
- Никакого «погони за геометрией клавиатуры по кадрам» в скроллере нет.

Вывод: наш набор примитивов был правильный, но написан вручную и разросся. Библиотека даёт
то же самое, плюс end-anchoring, который мы изобретали сами.

### 1.3 Telegram Mini Apps — про клавиатуру

Документация: <https://docs.telegram-mini-apps.com/packages/tma-js-sdk/features/viewport>.

Прямая цитата из их типов: значение живого `viewportHeight` **«не следует использовать, чтобы
прикреплять элементы интерфейса к низу видимой области; для этого правильнее использовать
`viewportStableHeight`»**. То есть даже Telegram советует: **для нижнего UI берите стабильную
высоту, а не живую**, чтобы не дёргаться на каждый кадр анимации клавиатуры.

### 1.4 Платформенные стандарты клавиатуры

- **`interactive-widget=resizes-content`** (CSS Viewport Module Level 1,
  <https://drafts.csswg.org/css-viewport-1/#interactive-widget-section>, MDN
  <https://developer.mozilla.org/en-US/docs/Web/HTML/Guides/Viewport_meta_element>).
  Значения: `resizes-visual` (дефолт), `resizes-content`, `overlays-content`. При
  `resizes-content` **initial viewport** ужимается под клавиатуру → `100dvh`/`100%` и обычный
  поток (в т.ч. `position: sticky`) сами держат композер над клавиатурой. Поддержка: Chrome
  Android, Firefox Android, Samsung Internet 21+, Opera Mobile (caniuse
  <https://caniuse.com/mdn-html_elements_meta_name_viewport_interactive-widget_resizes-content>).
  **У нас уже включено** (`apps/web/index.html:47`).
- **VirtualKeyboard API** (`navigator.virtualKeyboard.overlaysContent = true` +
  `env(keyboard-inset-height)`) — W3C, MDN
  <https://developer.mozilla.org/en-US/docs/Web/API/VirtualKeyboard_API>. Даёт декларативный
  грид `grid-template: "messages" 1fr "input" auto "keyboard" env(keyboard-inset-height, 0px)`.
  Поддержка: Chromium/Edge (caniuse 77.8% global), **нет в Firefox и нет в Safari/iOS**.
- **iOS Safari — особый случай.** `interactive-widget` там **не поддерживается** (WebKit bug
  <https://bugs.webkit.org/show_bug.cgi?id=259770>, открыт; подтверждено и в
  mdn/browser-compat-data#29011). Более того, `position: sticky/fixed` «низ» с клавиатурой
  багует: WebKit #202120 (sticky не прилипает), #292603 (лишний bottom-inset safe-area),
  регрессии в iOS 26 (visualViewport.offsetTop не сбрасывается). Поэтому на iOS:
  - `visualViewport` используют **только** как сигнал «клавиатура изменилась», а не как второй
    геометрический движок (см. <https://github.com/cameronapak/polyfill-virtual-keyboard-api/blob/main/docs/ios-composer.md>);
  - предпочтительная раскладка — **body-scroll + `position: sticky; bottom: 0`** для композера
    (это и есть актуальный рецепт, а не `fixed` + JS-транслейт);
  - `dvh` уже учитывает клавиатуру на современных iOS/Android без наблюдателей
    (<https://dev.to/franciscomoretti/fix-mobile-keyboard-overlap-with-visualviewport-3a4a>).

---

## 2. Референсная архитектура для gomo6

### 2.1 Скролл — отдать библиотеке

`MessageList`:
- `useVirtualizer({ count, getScrollElement, estimateSize, getItemKey: messageKey, anchorTo: 'end',
  followOnAppend: true, scrollEndThreshold: 80, overscan: 12, scrollMargin: HISTORY_HEADER_HEIGHT })`.
  `scrollMargin` — потому что над списком есть фиксированный `msg-history-header`.
- Убрать `useStickToBottom` (пин, живой якорь, settle) и большую часть `scrollEngine` — их роль
  теперь у `anchorTo: 'end'` + `followOnAppend`. Остаётся только:
  - read-line (read-receipts по видимости) — **остаётся нашим**;
  - триггер подгрузки истории у верха (`isAtEnd`/`getDistanceFromEnd` тут не нужны, нужен
    `scrollTop <= TOP_LOAD_ZONE`);
  - сессионный рестор — через `scrollToIndex(savedIndex, { align: 'start' })` после подгрузки
    (или `initialOffset`/`initialMeasurementsCache`).
- Открытие чата: `useLayoutEffect(() => virtualizer.scrollToEnd(), [virtualizer])`.
- «Внизу?» для пилюли/FAB: `virtualizer.isAtEnd()` в обработчике скролла (метод не реактивный —
  состояние держим сами, как сейчас).
- Удалить `estimateMessageHeight`-«угадайку» частично можно: end-anchoring сам компенсирует
  поздние измерения; оценочная высота остаётся только как первичная (для прыжка открытия), её
  можно упростить.

### 2.2 Клавиатура — оставить стандарты, убрать хореографию

- `interactive-widget=resizes-content` — **уже есть**, оставить.
- Android: с `resizes-content` раскладка ужимается → композер в обычном потоке, JS не нужен.
- iOS: раскладка «документ скроллится, композер `position: sticky; bottom: 0`», а
  `visualViewport` — только чтобы выставить `--kb-inset`/`--app-vh` и не бороться с паном.
  Держать **стабильную** высоту для позиционирования, живую — только для инсета.
- `MessageComposer` v2: вынести всю клавиатурную хореографию в `useKeyboardLift`, но по
  возможности **сократить** её до: (а) `resizes-content` путь, (б) `visualViewport`-инсет для
  iOS. Три копии rAF-цикла и per-frame геометрия — кандидаты на удаление.
- Опционально (Chromium): `navigator.virtualKeyboard.overlaysContent` + `env(keyboard-inset-height)`
  как единый декларативный путь.

### 2.3 Что удаляем / что добавляем

| Сейчас | Куда |
|---|---|
| `core/useStickToBottom.ts` (285 строк: пин, якорь, рестор, settle) | **удалить**, заменить опциями виртуализатора |
| `core/scrollEngine.ts` (bottomTarget/isAtBottom/captureAnchor/anchorScrollTop/константы) | оставить только `HISTORY_HEADER_HEIGHT`/`TOP_LOAD_ZONE`; остальное — не нужно |
| `MessageList` ручные рефы/эффекты пин/якорь | удалить; остаётся read-line + история + пилюля |
| `MessageComposer` 331-строчный эффект клавиатуры | `useKeyboardLift`, сокращённый под стандарты |
| `--app-vh` / `--kb-inset` | оставить для iOS, упростить (стабильная высота + инсет) |

---

## 3. Риски и обязательная проверка

- **Тесты.** 34 теста `MessageList` проверяют наш самодельный движок (записывают `scrollTop` через
  мок-виртуализатор). При переходе на end-anchoring их надо переписать: проверять конфиг
  виртуализатора (`anchorTo`, `followOnAppend`, `getItemKey`, `overscan`) и вызовы
  `scrollToEnd`/`isAtEnd`, а «физику» оставить библиотеке (её собственные тесты).
- **jsdom без layout.** End-anchoring реально проявляется только в браузере — нужна **проверка на
  устройстве** (iOS Safari + Chrome Android), headless это не воспроизводится.
- **Групповые чаты и «Заметки»** — тот же список, но с фильтром/пинами; проверить оба.
- **Порядок внедрения безопасный:** сначала скролл (библиотека), потом клавиатура (отдельным
  PR с проверкой на устройстве).

---

## 4. План

1. **Скролл → TanStack end-anchoring.** Заменить `useStickToBottom` опциями виртуализатора;
   переписать тесты `MessageList` под новый контракт. *(средний риск, проверка на устройстве)*
2. **`MessageComposer` v2 / `useKeyboardLift`.** Сократить хореографию до стандартов
   (`resizes-content` + `visualViewport`-инсет); проверить iOS Safari и Chrome Android. *(высокий
   риск, только с проверкой на устройстве)*
3. **Пилюля «N новых» + FAB** на `isAtEnd()`/`scrollToEnd()`.

---

## 5. Источники

- TanStack Virtual, чат-режим: <https://tanstack.com/virtual/latest/docs/chat> ·
  анонс <https://tanstack.com/blog/tanstack-virtual-chat>
- Telegram Web K, `scrollable.ts`: <https://github.com/morethanwords/tweb/blob/master/src/components/scrollable.ts>
- Telegram Mini Apps, viewport: <https://docs.telegram-mini-apps.com/packages/tma-js-sdk/features/viewport>
- CSS Viewport L1, `interactive-widget`: <https://drafts.csswg.org/css-viewport-1/#interactive-widget-section> ·
  MDN <https://developer.mozilla.org/en-US/docs/Web/HTML/Guides/Viewport_meta_element> ·
  caniuse <https://caniuse.com/mdn-html_elements_meta_name_viewport_interactive-widget_resizes-content>
- VirtualKeyboard API: <https://developer.mozilla.org/en-US/docs/Web/API/VirtualKeyboard_API>
- iOS Safari и клавиатура: WebKit #259770, #202120, #292603 ·
  <https://github.com/cameronapak/polyfill-virtual-keyboard-api/blob/main/docs/ios-composer.md>
- `dvh` без наблюдателей: <https://dev.to/franciscomoretti/fix-mobile-keyboard-overlap-with-visualviewport-3a4a>
