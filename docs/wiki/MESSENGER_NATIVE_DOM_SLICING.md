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

`overflow-anchor` is Chromium/Firefox only. The fallback is deliberately
derived from the **committed DOM**, not from a pre-commit snapshot, so it does
not depend on the order React flushes a store update and a window update:

1. the layout effect compares the committed slice with the previous one;
2. `previous.start - start > 0` means rows were added above the window;
3. the added height is measured from the DOM (`offsetTop` of the first kept row
   minus the first row);
4. if `scrollTop` did not already move by that much (native anchoring did not
   run), it is corrected — before paint, at rest.

The symmetric case (top GC) subtracts the measured removed height.

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
* **Still to do on a real device**: iOS Safari and Android Chrome — momentum
  scrolling, keyboard open/close, URL-bar resize, rotation.
