# Messenger / GomoSub: native DOM slicing for chat scrolling

**Status:** implemented (2026-10-17). Supersedes the TanStack-virtualizer
approach documented in [`MESSENGER_VIRTUAL_SCROLL_PLAN.md`](./MESSENGER_VIRTUAL_SCROLL_PLAN.md).

## Why the library approach was replaced

The virtualizer owned the scroll contract: it kept a positioned spacer of the
full content height and placed every row absolutely from its own height
estimate, then *corrected* that estimate once a row was measured. Every
correction moves content above the reader, and every correction has to be
written back as a `scrollTop` adjustment. On iOS, WebKit drops `scrollTop`
writes while a finger or a momentum scroll is live, so the virtualizer deferred
them and replayed the sum when the scroll settled — that batched write was the
visible jump, and the whole `offscreenMeasure`/estimate cascade existed only to
make that sum smaller.

The browser already has everything needed, and it runs it on the compositor
thread:

| Concern | Before | Now |
|---|---|---|
| Row placement | absolute + `translateY` in a spacer | normal flow |
| Row windowing | library range + `overscan` | `content-visibility: auto` + `contain-intrinsic-size: auto 64px` |
| Keeping the reader's place on prepend | `anchorTo: 'end'` + keyed items + measurement replay | native scroll anchoring (`overflow-anchor: auto`) + one pre-paint fallback |
| Height accuracy | estimate + measure + correction | the layout engine's own remembered size (`auto`) |
| DOM bound | library range | keyed sliding window (`<= MAX_DOM_MESSAGES` rows) |
| Scroll listeners | per-frame library tracking + deferred writes | one rAF-throttled passive pass + one settle pass |

## Architecture

```
MessageList / ChannelChat
  └─ core/slicing.ts          pure keyed-window math (no DOM)
       KeyWindow { first, last }        first: null = tail window, last: null = follow tail
       resolveKeyWindow(window, index, length) -> { start, end } | null
       trimBottom(...)                  bottom GC decision
```

* **The mounted window is expressed in message keys**, never in array indices.
  A prepended page shifts every index by its own length; a key survives the
  shift, the optimistic → server swap and an edit. Indices are derived per
  render from a `Map<key, index>`.
* **Bi-directional sentinels** (`.chat-scroll-sentinel`, `overflow-anchor: none`)
  with `rootMargin: 600px` slide the window: up into already-loaded rows first,
  then into a fetched page; down into rows that were garbage-collected below.
  The top sentinel only *fetches* — the insert always happens in the settle pass.
* **Early request, late insert.** The next page is requested from the per-frame
  scroll pass (`PREFETCH_PX = 6000`) and buffered by the store (up to two
  pages). The request touches no DOM, so it is safe under a live coast; the
  *insert* still waits for a verified rest. That takes the network out of the
  wait when the reader reaches the top of the mounted window, which is where the
  scrollable content really ends.
* **Garbage collection**: rows below the viewport are dropped immediately (they
  cannot move anything the reader sees). Rows above the viewport are dropped
  only when the scroller is at rest, and the removed height is subtracted from
  `scrollTop` in the same layout pass. Never mid-coast.
* **Arrivals**: while the reader is at the bottom the window follows the tail
  and the position is pinned; otherwise the window is frozen at the newest
  mounted row, the badge counts and the FAB re-seeds the window to the newest
  rows and snaps (no smooth scroll through thousands of pixels).
* **Row memoization**: a row re-renders only when its own message, its
  predecessor, its resolved quote / peer receipt or the ambient
  `renderVersion` (pinned id, group/notes flags, own id) changed. Appending 50
  messages renders exactly the 50 new rows.

## The anchoring fallback (Safari)

`overflow-anchor` is Chromium/Firefox only. The fallback is deliberately derived
from the **committed DOM**, so it does not depend on the order React flushes a
store update and a window update:

1. the layout effect compares the committed slice with the previous one;
2. `previous.start - start > 0` means rows were added above the window;
3. the added height is measured from the DOM (the `offsetTop` of the first kept
   row minus the first row);
4. if `scrollTop` did not already move by that much (native anchoring did not
   run), it is corrected — before paint, at a verified rest.

The symmetric case (top GC) subtracts the measured removed height.

## Device findings (iOS Safari)

Two WebKit-specific causes of jitter were found on a real iPhone after the first
round of testing. Both are fixed; the first one is the important one.

### 1. `content-visibility` without scroll anchoring = a stutter per message

Measured in the same conversation, same window, only the flag differing:

| | `content-visibility` | row heights of the mounted window | `scrollHeight` |
|---|---|---|---|
| Chromium (anchoring) | `auto` | 64, 64, 64, … (skipped) | 3202 |
| Safari (no anchoring) | `visible` | 111, 89, 69, 69, 69 … (real) | 3161 |

A skipped row occupies `contain-intrinsic-size` (64px). When it scrolls into
view its **real** height replaces that estimate, so everything below it moves by
the difference. Chromium/Firefox absorb that with native scroll anchoring;
WebKit has none, so the reader sees a small jump on *every* message while
scrolling up through a window that has not been rendered yet — and the
underestimated `scrollHeight` also ends a momentum fling early. Once every
mounted row has been rendered (sizes remembered) the jitter disappears, which is
exactly the "it only stutters until everything is loaded" symptom.

Fix: the capability is now **detected behaviourally** (a probe scroller:
insert 40px above the fold and see whether `scrollTop` follows —
`lib/scrollAnchoring.ts`), the result is published as `has-scroll-anchoring` on
`<html>` before the first paint, and `content-visibility` is gated on it:

```css
.chat-native-row { contain: layout style; overflow-anchor: auto; }
.has-scroll-anchoring .chat-native-row {
  content-visibility: auto;
  contain-intrinsic-size: auto 64px;
}
```

So Chromium/Firefox keep the native row-skipping optimization, and WebKit lays
out the mounted window (≤ 300 rows) completely — there the window itself is the
virtualization. `CSS.supports("overflow-anchor", …)` is deliberately NOT used:
an engine may parse the property without anchoring, which would put Safari back
on the broken branch.

### 2. A quiet event stream is not a rest — and a finger is not a rest either

The heavy pass (pin, insert above the viewport, top prune) writes `scrollTop`,
and WebKit drops such a write while a gesture is live. Two guards, both required:

* **The position must be unchanged** since the last observation, or the pass
  re-arms itself. `scroll` events can go quiet before the momentum has visually
  ended (iOS), so the timer alone is not proof.
* **No pointer may be on the list.** A finger that is simply resting is still a
  live gesture for WebKit: a mutation there moves the content under the finger
  (the reader ends up tapping or long-pressing a *different* message — observed
  on a device as "it replies to a random message while I scroll") and the
  deferred `scrollTop` write lands later as a second, visible jump ("it
  teleports me twice"). The list therefore tracks `pointerdown`…`pointerup`
  (window-level, so a flick that ends off-screen still clears it) and defers
  every mutation until the release — which also arms the settle, so the work
  happens immediately after the finger lifts.

The first implementation of this list had the same rule (`gestureRef`) and it was
dropped as "spaghetti" during the rewrite; the regressions above are what
reintroducing it fixed. Do not remove it.

### 3. Rolled back: the aggressive runway (2026-10-18)

An attempt to remove the "wall" added a runway floor restored at *every* rest
(mounting up to 200 rows), direction-aware ceiling enforcement and an
anchor-based compensation. On a real iPhone it produced strong jerks right after
the scroll stopped: the runway grew the window past the ceiling constantly, so
the ceiling enforcement fired (up to a hundred rows removed at once) at every
stop, and every stop also mounted a large block and rewrote `scrollTop` — a lot
of layout and position churn exactly when the momentum ends.

What survived the rollback: the pointer gate (above) and the early request
(`PREFETCH_PX`). The wall and the waiting at it are therefore still there. The
runway idea is sound but must be reintroduced incrementally with a device test
per step, and preferably as *spacer-absorbed mounting*: keep a rolling spacer
above the mounted window whose height shrinks by the **measured** height of the
rows being mounted, so the content above the reader never changes and mounting
costs no `scrollTop` write at all — which makes it safe even mid-momentum. That
is the only design that removes the wall without touching the position while a
gesture is live.

## Media: no late reflow

`getAttachmentDisplayStyle` always returns a `width` + `aspect-ratio` box, from
the payload's `width`/`height`, the remembered ratio
(`utils/attachmentRatioCache`) or a stable fallback (4/3 image, 16/9 video).
Images/videos render inside it with `object-fit: contain`; the album mosaic has
its own `--mosaic-ratio`. A late-arriving file therefore cannot change a row's
height. (`ShareCard` is the one asynchronous-content exception: its loading
skeleton is shorter than the resolved card, and a share card that resolves
above the viewport is compensated by the engine's anchoring — Chromium/Firefox
only.)

## Verification

* Unit: `core/slicing.test.ts` (pure math), `MessageList.test.tsx` (window,
  sentinels, prepend compensation, GC, unread, read line, memoization),
  `ChannelChat.test.tsx` (window bound, history paging).
* Manual (required, not a substitute for a device): open at the bottom, fling
  up, reach the top, come back, receive a message in both states, resize.
* Tuning knobs, all in `core/slicing.ts` / `MessageList.tsx`: `RUNWAY_PX` (how
  much content is kept above the reader), `PREFETCH_PX` (how early the next page
  is requested), `SCROLL_SETTLE_MS` (how long the scroller must be quiet before
  the heavy pass — the verified rest is the real gate), `MAX_DOM_MESSAGES`.
* **Still to do on a real device**: iOS Safari and Android Chrome — momentum
  scrolling, keyboard open/close, URL-bar resize, rotation.
