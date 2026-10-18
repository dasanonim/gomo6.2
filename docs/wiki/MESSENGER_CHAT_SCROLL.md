# Messenger chat scrolling

**Status:** implemented (2026-10-18) on `refactor/messenger-telegram-scroll`.
Supersedes [native DOM slicing](./MESSENGER_VIRTUAL_SCROLL_PLAN.md) and, before
it, the TanStack-virtualizer approach
([plan](./MESSENGER_VIRTUAL_SCROLL_PLAN.md)).

The reference implementation is **Telegram Web** —
[github.com/Ajaxy/telegram-tt](https://github.com/Ajaxy/telegram-tt). Every rule
below is a port of something that client has tuned on real devices for years; the
comments in the code name the file it came from. Where gomo6 differs, the
difference is stated (`gomo6:` paragraphs) — the differences are real, not
simplifications.

---

## 1. The model in one paragraph

The browser owns the scroll. Rows are plain, normal-flow elements in one
`overflow-y: auto` box; no spacer, no absolutely positioned row, no transform, no
virtualizer. What the list owns is (a) **which slice of the history is mounted**
(a bounded window that slides like a page of a book), (b) **one** decision per
commit about where the scroll position should be, and (c) a **capability gate**
that decides when it is safe to change the DOM under the reader. Nothing else.

Two consequences do the actual work:

* **Nothing writes `scrollTop` while the reader is scrolling.** Every position
  change happens in a commit — the only moment the DOM changes anyway.
* **The engine's own scroll anchoring absorbs what the list cannot.** On
  Chromium/Firefox, content mounted *above* the viewport moves the reader's
  content by zero pixels, for free, on the compositor's terms. The list
  compensates only where that does not happen (WebKit).

## 2. Files

```
components/messenger/MessageList.tsx        the list: one writer, triggers, gate
components/messenger/core/fasterdom.ts      batched read/write pass (1 frame)
components/messenger/core/animateScroll.ts  the bounded, cancellable glide
components/messenger/core/scrollGeometry.ts position primitives (+ bottom sentinel)
components/messenger/core/slicing.ts        keyed mounted-window math (pure)
components/messenger/core/messageScrollAnchors.ts  session anchor per conversation
lib/scrollAnchoring.ts                      behavioural anchoring detection
```

Porting map, for anything that needs re-deriving later:

| gomo6 | telegram-tt |
|---|---|
| `core/fasterdom.ts` | `lib/fasterdom/fasterdom.ts` (+ `stricterdom.ts` phases) |
| `core/animateScroll.ts` | `util/animateScroll.ts` |
| `core/scrollGeometry.ts` | `components/middle/helpers/messageListReserves.ts` (constants, sentinel, snapping) |
| `core/slicing.ts` | `getViewportSlice` / `MESSAGE_LIST_VIEWPORT_LIMIT` in `global/actions/api/messages.ts` |
| the writer in `MessageList.tsx` | `useLayoutEffectWithPrevDeps` in `components/middle/MessageList.tsx` |
| trigger sentinels | `useScrollHooks` + `MessageListContent.tsx` (`backwards-trigger` / `forwards-trigger`) |
| read line | `useMessageObservers` (`markMessageListRead({ maxId })`) |

## 3. One writer

`MessageList.tsx` has exactly one `useLayoutEffect` that decides the position,
and it runs inside `requestForcedReflow` so the geometry it reads and the write
it returns never interleave with another task's reads or writes. Its decision
tree, in order:

1. **First placement** — the restored session anchor, else the newest row.
2. **A pending jump** — glide to the target, flash it.
3. **A new tail while following** — glide the arrival into view (the "message
   rises" feel). The glide target is the zero-height trigger *after* the content,
   so it lands on the real bottom, not one sentinel above it.
4. **The reader was at the bottom** — pin with the sentinel
   (`scrollTop = 1e7`, which the engine clamps to the new maximum). This single
   write keeps a growing list glued, whatever grew and on which side.
5. **Otherwise** — compensate the layout change above the reader's anchor, plus
   any movement of the scroller's own top edge (the pinned banner appearing above
   the messages pushes the content down; the composer growing below does not).

"Was the reader at the bottom" is derived, never stored:

```ts
// `scrollHeight - scrollTop` grew by exactly what was added BELOW while the
// reader did not move, so comparing it against the PREVIOUS viewport height
// judges the position as it was before this commit.
const wasAtBottom = (scrollHeight - scrollTop) - previousClientHeight <= 4;
```

A stored `scrollTop` would go stale the moment the reader scrolls between two
commits; this formula cannot, because it is re-derived from the live geometry.

### 3.1 The anchor invariant

The anchor is a mounted row — **one row below the fold**, deliberately
(Telegram anchors on `preservedItemElements[1]`). Its *scroll coordinate* is
`rect.top - scrollerRect.top + scrollTop`, which is **invariant under scrolling**:
the reader scrolling changes `rect.top` and `scrollTop` by exactly the same
amount. So the delta that coordinate moved by between two commits is *exactly*
the layout change above the reader's place, and:

```ts
scrollTop += anchorCoordNow - anchorCoordBefore;
```

is idempotent with the engine's own anchoring:

* Chromium/Firefox already moved `scrollTop` by that delta → the measured delta
  is `0` → nothing is written (no double compensation).
* WebKit did not → the delta is the real growth → one write fixes it.

One row below the fold rather than the first visible row, because the first row
can change height when older messages are mounted (a date separator moves to an
older message, a grouped bubble loses its header) — the reader must not be
compensated for a change inside the row they are looking at.

gomo6: unlike Telegram, the date separator is rendered *inside* a `.message-item`
(`ChatView.renderMessage` → `dateLabel`). That is why the one-row offset is
required here and merely advisable there.

## 4. "At the bottom" is native

While the reader is within a band around the bottom trigger the scroller is a
snap container (`with-bottom-snap`) and the zero-height `.fab-trigger` after the
content is its snap point:

```css
.message-scroll.with-bottom-snap { scroll-snap-type: y proximity; }
.message-list .fab-trigger { height: 0; scroll-snap-align: end; }
```

The class is armed and disarmed from the position (`syncBottomSnap`), so snapping
can never pull a reader who has left the band back down. `animateScroll` holds
snapping off through `scroll-snap-type: none` while a glide owns the position.

Why this matters: a list whose bottom edge grows no longer needs a JS write to
stay pinned. The scroll-snap position is honoured by the browser during layout,
which is precisely what a `scrollTop` write during a live scroll is not (WebKit
drops those).

## 5. The mounted window

Bounded in `core/slicing.ts`, expressed in **keys** (`messageKey` = `client_id ||
id`), so a prepend, an optimistic → server swap or an index shift never
re-anchors the reader to a different message:

* mounted on open: `INITIAL_WINDOW` (100);
* each slide step: `WINDOW_STEP` (50) rows, in the direction the reader is moving;
* hard ceiling: `MAX_DOM_MESSAGES` (220) — rows on the far side are dropped, and
  the far side is off screen by construction;
* a window that follows the tail (`last: null`) never drops from the bottom: it
  owns the newest rows.

`last: null` means "follow the tail"; the key is *not* derived from "the window
ends at the array end" — confusing those two was a real bug (a frozen window
would silently become a follower and stop trimming). Use
`enlargeWindow`/`flushBufferedPage` in `MessageList.tsx` for the two transitions;
everything else goes through `resolveKeyWindow`.

**No `content-visibility` on messenger rows.** A row the engine has not laid out
contributes an estimate; replacing the estimate with the real height moves
everything below it. Chromium/Firefox absorb that with scroll anchoring, WebKit
cannot — that is the per-message stutter documented in §7.1. The mounted window
is what bounds the cost instead. GomoSub's `ChannelChat` (document-scrolled,
much larger window) keeps `content-visibility`, gated on the behavioural flag.

## 6. Triggers, reads and the capability gate

**History triggers.** Two 1px sentinels with `rootMargin: 750px` *request* work
only; the mount itself happens in a commit. `prefetchOlder()` additionally
requests the next page from the per-frame scroll pass as soon as the position is
within `PREFETCH_PX` (6000) of the top: a request touches no DOM, so it is safe
mid-fling and it takes the network round trip out of the wait when the reader
arrives at the mounted top. The store's buffered page (`postpone: true` in
`loadMoreMessages`) is what makes request early / insert late possible.

**Capability gate.** Adding rows above the viewport is free where the engine
anchors. Where it does not (WebKit), the compensating write would be dropped
under a live gesture and the added rows would shift the reader's content — so
those mounts wait for a **verified rest**: the scroller must be quiet for
`REST_MS` (150) *and* its position must be the same as at the last observation.
A quiet event stream is not proof of a rest; the position is.

The pointer gate is a gate on the *mount path*, never on the rest pass itself: a
finger held on the list keeps `pointerDownRef` true and defers upward mounts, and
the release arms the rest so the deferred work happens immediately.

**Read line.** The newest fully visible message that is not the reader's own,
found by binary search over the mounted rows (`offsetTop` is monotonic in
document order) at a verified rest, and reported only when the answer changed.
No row-by-row scan, no IntersectionObserver per row.

**Following.** `FOLLOW_SLACK` (100px) decides whether the reader is "with" the
conversation: while following, the window follows the tail and arrivals glide in;
otherwise the window freezes (`last` materializes), the arrival is not mounted,
nothing moves and the badge counts it.

## 7. Device findings (keep these)

Carried over from the previous implementation; they are the reasons several rules
exist at all.

### 7.1 Why there is no `content-visibility` on messenger rows

Measured on a real iPhone, same conversation, same window, only the flag
differing:

| | `content-visibility` | row heights of the mounted window | `scrollHeight` |
|---|---|---|---|
| Chromium (anchoring) | `auto` | 64, 64, 64, … (skipped) | 3202 |
| Safari (no anchoring) | `visible` | 111, 89, 69, 69, 69 … (real) | 3161 |

A skipped row occupies `contain-intrinsic-size`. When it scrolls into view its
real height replaces the estimate, so everything below it moves by the
difference. Chromium/Firefox absorb that with native scroll anchoring; WebKit
has none, so the reader sees a small jump on *every* message while scrolling up
through rows that have not been rendered yet, and the underestimated
`scrollHeight` ends a momentum fling early. Once every row has been rendered the
jitter disappears — the classic "it only stutters until everything is loaded".

The capability is detected **behaviourally** (a probe scroller, see
`lib/scrollAnchoring.ts`) and published as `has-scroll-anchoring` on `<html>`
before the first paint. It must never be derived from
`CSS.supports("overflow-anchor", …)`: an engine may parse the property without
anchoring, which would put Safari on the broken branch.

### 7.2 A quiet event stream is not a rest — and a finger is not a rest either

The mount/compensation path writes `scrollTop`, and WebKit drops such a write
while a gesture is live. Two guards, both required:

* **The position must be unchanged** since the last observation, or the rest pass
  re-arms itself. `scroll` events can go quiet before the momentum has visually
  ended (iOS), so the timer alone is not proof.
* **No pointer may be on the list.** A finger that is simply resting is still a
  live gesture: a mutation there moves the content under the finger (the reader
  ends up acting on a *different* message) and the deferred write lands later as
  a second, visible jump ("it teleports me twice"). The list tracks
  `pointerdown`…`pointerup` window-level, so a flick that ends off-screen still
  clears it, and defers every upward mount until the release — which also arms
  the rest.

### 7.3 Rolled back: the aggressive runway (2026-10-18)

An attempt to remove the "wall" grew the mounted window past the ceiling at every
stop, then trimmed it back — a lot of layout and position churn exactly when the
momentum ends, which reads as a jerk right after the scroll stops. What survived:
the pointer gate and the early request. The lesson is now structural: the window
slides by one-sided steps, so mounting never has to be compensated on the far
side, and the same step never both mounts and trims more than the overflow.

## 8. Verification

* Unit — `core/fasterdom.test.ts` (measure/mutate ordering, forced reflow, the
  hidden-tab fallback), `core/animateScroll.test.ts` (target math, the 800px
  cap, duration, snap hold/release, cancellation), `core/scrollGeometry.test.ts`
  (bottom-relative offset, the sentinel pin, clamping),
  `core/slicing.test.ts` (keyed window math).
* Integration — `MessageList.test.tsx`: opens pinned; bounded window in source
  order; no spacer/absolute placement; snap armed at the bottom and disarmed in
  history; FAB/badge; arrival pins while following; arrival freezes the window
  and counts while in history; prepends are not counted as unread; FAB returns to
  the newest rows; a slide into loaded rows above compensates exactly
  (`WINDOW_STEP * ROW`); mounts wait for a verified rest without anchoring and
  are immediate with it; a buffered page is mounted above the reader; the ceiling
  holds; session-anchor restore; glide + flash on jump; paging for an unloaded
  jump target; the read line (own/deleted skipped, fold-aware, deduped).
  GomoSub's `ChannelChat.test.tsx` still covers its own window.
* Manual (a device is required, and is **not** a substitute for CI): open a
  long chat at the bottom, fling up through several pages, fling back down,
  receive a message while at the bottom and while deep in history, open a pinned
  message, send with the keyboard open, rotate. iOS Safari and Android Chrome are
  the two targets that matter.

Tuning knobs: `FOLLOW_SLACK`, `BOTTOM_SNAP_THRESHOLD`, `HISTORY_TRIGGER_MARGIN`,
`PREFETCH_PX`, `REST_MS` in `MessageList.tsx`; `INITIAL_WINDOW`, `WINDOW_STEP`,
`MAX_DOM_MESSAGES` in `core/slicing.ts`; `SCROLL_*` in `core/animateScroll.ts`.
None of them need a rebuild to tune locally — they are frontend constants.

## 9. Known gaps

Deliberately not in this pass (each is independent and additive):

1. **Sticky date pills.** Telegram keeps a floating date at the top of the list
   while scrolling (`useStickyDates`, `position: sticky` + `body.is-scrolling-
   messages`). gomo6's date separator is a centred rule inside the row, so this
   needs a visual decision, not just plumbing.
2. **GomoSub `ChannelChat` on the same engine.** It still runs its own copy of the
   old settle machinery (document-scrolled, window ≤ ceiling). The engine is now
   small and self-contained; extracting it into a hook and deleting the second
   copy is the natural next step.
3. **Store-level viewport.** The store keeps every loaded message; the list bounds
   the DOM instead. Telegram bounds the *store* (`MESSAGE_LIST_VIEWPORT_LIMIT`)
   and re-fetches a slice around the reader. gomo6's pagination is
   backward-only, so this needs a forward fetch (`since_event_id`) to be complete.
4. **Keyboard / visual viewport.** The composer is in flow, so no bottom inset is
   needed, but the mobile keyboard behaviour (`lib/mobileKeyboard.ts`) has not
   been re-checked against the new list.
5. **`scrollToMessage` for a very distant target** currently mounts the window
   around the target and glides; a dedicated "jump over N pages" animation would
   read better on slow networks.
