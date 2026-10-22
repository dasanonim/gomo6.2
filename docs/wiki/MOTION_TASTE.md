# Motion taste — what the owner actually likes

Status: notes from the profile-motion pass (`feat/animations`). These are
subjective acceptance criteria collected by iterating live with the owner; the
numbers below are the configurations that survived that iteration. Treat this
file as "do not re-litigate without a direct request".

Reference feel: Telegram iOS / Telegram Web K. Everything is **physics** —
springs with velocity, interruptible, transform-only. If a change makes the UI
feel like "a web page with CSS transitions", it is wrong.

---

## 1. Signed off (keep exactly this character)

- **Profile header recede.** The identity block (and then stats, bio, pinned
  threads) is drawn into the top edge as it scrolls: scale to 0.76, lift −44px,
  fade to 0.4, smoothstep. Sequential per block, no shared timeline.
  Each block **latches** once it is past the edge; coming back up requires a
  deliberate pull (distance falls with velocity) and then the block **pops**
  with a tiny release overshoot.
- **Delayed pin of the tab bar.** The bar is sticky, but a negative offset
  cancels the stick while it arrives, so it genuinely scrolls under the header.
  At ~65% swallowed it is released and pops into place. After that, pure CSS
  sticky — **zero per-scroll JS**. Releases when the flow catches back up.
- **Composer sheet.** Opening, the drag return and the top bounce all feel
  right. It is a real sheet: drag by the header, 1:1 in the hand, elastic
  resistance, always springs back up; only a decisive downward flick closes.
- **Overlay language.** Dialog/alert/dropdown/popover/context menu enter as one
  physical object: opacity + scale + short defocus, anchored to the Radix
  transform origin. Backdrop is its own layer.
- **Tactile reactions.** Action buttons press on a spring; the icon snaps when
  state flips on; counters bump only when the value actually changes.
- **Stats.** Numbers are printed at their final value — no rolling, no count-up,
  no arrival of digits. Only the stat blocks themselves enter on the cascade.
  (Skipped under reduced motion and in tests.)
- **Glass.** Overlays and the pinned bar use the themed glass, never an opaque
  flash.

## 2. Explicitly rejected (do not bring back)

- `ease-in-out` / `linear` for spatial movement; duration-based slides.
- **Count-up / rolling numbers in the stats row.** A counter that ticks 0 → 47
  reads as "loading", not as motion — the value is data, not an event. It was
  removed from `ProfileStats`; do not bring back a `CountUp` there. Numbers
  change instantly (the only animated number left is the like counter's bump,
  which fires on a real like, not on paint).
- **Fade-outs on large panels.** The composer panel must leave by motion only.
  (The backdrop may fade; the panel may not.)
- An **independent fast backdrop fade** that brightens the page while a panel is
  still leaving — it made closing read as "dropped frames / cheap".
- Composer close **by distance**. Pulling it halfway and letting go must spring
  back up. Closing is a downward flick (>650px/s) or the X.
- Composer drag that is **1:1 with no elastic energy**, and the opposite
  extreme, **elastic from the first pixel**. The signed-off feel is the
  `composer` spring with the current `dragElastic` below.
- **Swipe-up from the FAB** to open the composer (removed; the plus is a tap).
- **Fullscreen toggle on mobile** in the composer (desktop only).
- Tab counters (achievements/gifts/subscribers), and the «Записи (N)» heading.
- The pinned identity strip (avatar + name) above the tabs — removed for good.
- Big release overshoots: 6–7% on the recede release looked cheap. **1–1.5%**
  is the ceiling for large surfaces.
- Re-firing the pin spring on every scroll tick at the pin edge (needs the
  animation-free measurement + hysteresis).
- Any change to the composer **opening** — it is signed off; only closing was
  still being tuned.

## 3. Current locked parameters

| Surface | Preset / value |
|---|---|
| Press / hover micro | `SPRING_SNAPPY` 500 / 32 / 0.8, tap 0.96 |
| Panels / layout / shared | `SPRING_SMOOTH` 380 / 30 / 1 |
| Micro icons / badges | `SPRING_BOUNCY` 600 / 20 / 0.7 |
| Fades only | `EASE_OUT_EXPO` `[0.16, 1, 0.3, 1]` |
| Width/height reveal | `reveal` 500 / 44 / 0.8, **no overshoot** |
| Recede release | `eject` 500 / 28 / 1 (~1–1.5% scale pop) |
| Composer open / drag return | `composer` 400 / 20 / 0.7 |
| Composer close | `composerClose` 320 / 26 / 0.9 |

Composer sheet in detail:
- header is the drag handle; `dragListener={false}`, `dragControls.start`.
- `dragConstraints` 0…0, `dragElastic` **0.22 up / 0.55 down**.
- close only at `velocity.y > 650`; no distance close.
- return: `composer` + release velocity; X/Escape: velocity **1000** down.
- panel has no opacity animation; the backdrop is a separate layer (0.22s fade).
- mobile: full-height sheet with an 8px top inset, rounded top, grip pill;
  a **background-coloured pad** sits behind it so an upward overshoot never
  shows the page under the bottom edge.
- desktop: centred glass card, scale entrance, no fullscreen on phones.

Profile recede (per block): `raw < 0.8` latches; release pull 130px at a crawl,
30px at a flick; `eject` release.

Tab bar pin: pin when ~65% of its height is under the header; set the offset to
`−0.65 × height` and spring it to 0 on `eject`; release at `flowTop ≥ pad + 8`;
flow position is derived from the non-sticky body wrapper so the transform
cannot feed back into the measurement.

## 4. How to change things

1. One parameter at a time. Show the owner; they test live and answer fast.
2. Never introduce a fade for a large surface as a shortcut for motion.
3. Never block or emulate scrolling; transforms only, no layout animation in
   scroll paths.
4. Honour `useReducedMotion` (instant, same end state) and keep the test-runner
   bypass for decorative number rolls.
5. Run `tsc`, the motion contract test and the profile/composer tests before
   handing off. The owner checks the feel in the browser themselves.
6. When in doubt, compare against the pinned bar, the recede blocks and the
   composer drag — those are the accepted reference points.
