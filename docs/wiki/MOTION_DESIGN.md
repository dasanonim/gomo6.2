# Motion design (язык движения gomo6)

**Status:** design sheet + P1/P8 implemented (`feat/animations`).
Reference: Telegram iOS concept video (75 s, 1080×1080@60) — the "profile" reel.
Owner taste notes (what was signed off / rejected, with locked parameters):
[MOTION_TASTE.md](MOTION_TASTE.md). Read it before changing any animation.
This file is the direction, not a spec of what exists.

Purpose: keep motion **one language**, sourced from a real reference instead of
per-screen improvisation. Anything that animates in this app should be
traceable to a rule below, or it does not ship.

---

## 1. What the reference actually does

Timestamps are from the reel, at 60 fps.

| # | Transition | Frames | What moves |
|---|-----------|--------|------------|
| 1 | Chat list → chat | `0.9–1.4s` | Classic push: incoming screen slides in from the right over a dimmed, slightly receding list. The list keeps its horizontal position and only dims — no cross-fade. |
| 2 | Chat → profile | `3.1–3.7s` | **Container transform.** The 28 px avatar in the chat nav bar lifts out and becomes the 64 px avatar of the profile; the profile itself is a *card* that grows from that avatar's rect, not a page push. The chat stays visible underneath, dimmed, and slides back ~15%. |
| 3 | Profile → chat | `71.0–72.0s` | Exact reverse: the card slides right and shrinks back into the nav-bar avatar, the chat slides in from the left. Nothing cross-fades — the same card is followed all the way. |
| 4 | Profile → avatar photo | `7.4–8.1s` | The round avatar grows into a **full-screen rounded rectangle** (~0.7 s). Page content fades out under it; the back chevron and `Edit` stay pinned and do not move. Photo pixels scale, they do not fade. |
| 5 | Photo → profile | `9.6–10.2s` | Reverse, same geometry, into the same circle. |
| 6 | Theme change | `12.0–12.6s` | A colour **flood from the avatar downward**: the background washes in from the top edge, text and controls re-tint behind it, the avatar ring picks up the accent. Not a cross-fade of two screenshots. |
| 7 | Gift bubbles | `13–70s` (idle loop) | Translucent, softly glowing orbs with stickers around/over the avatar. Idle animation is *slow* (a 6–8 s drift + shimmer), and the big centre orb settles in with a small overshoot, then keeps breathing. |
| 8 | Gesture continuity | throughout | Everything can be grabbed mid-flight. Drag back during the profile open and the same card follows the finger, then settles on release with the finger's velocity. No restart, no jump. |

### Why it reads as "божественно" — the seven rules

1. **Continuity.** Nothing appears from nothing. Every surface is the *same
   object* you touched, at a different scale: avatar → card → photo. The eye
   never has to re-find the thing it was looking at.
2. **Depth, not replacement.** The outgoing screen does not disappear, it
   *recedes* (dim + slight scale-down) under the incoming one. On the web the
   cheapest honest version of this is View Transitions with a `::view-transition-old`
   that scales to 0.96 and dims while the new one rises.
3. **Physics.** Overshoot is small but velocity is inherited. Duration-only
   curves cannot do rule 8 (interrupts) — that is why everything here is a
   spring.
4. **The moving object is the only bright one.** Everything else loses contrast
   while the transition runs. This is what makes the motion readable on a busy
   profile.
5. **Animated corners and shadow.** A card that grows gets a mask radius that
   animates with it and a shadow that deepens as it lifts. Without that it looks
   like a resize, not an object.
6. **Stagger with a price.** Children arrive 20–40 ms apart, and only the touched
   element moves fast; the rest follows. Nothing animates "everything at once".
7. **Restraint.** 90 % of frames are static. Motion is spent on meaning
   (open / close / send / confirm / arrive), never on decoration. A profile that
   animates constantly is a toy — the reel is impressive *because* it is calm
   between the three big moves.

---

## 2. What we already have

| Primitive | Where | State |
|---|---|---|
| Spring presets `snappy / standard / soft / sheet / pop` + reduced-motion collapse | `apps/web/src/lib/motion.ts` | done |
| View Transitions runner (`runTransition`, `startViewTransition`, single-flight queue, direction flag) | `apps/web/src/lib/viewTransitions.ts` | done — used only for route swaps |
| Shared-element names | `sectionTransitionName()` | done — used for один раздел title |
| CSS keyframes `gomo-vt-*` / `gomo-view-*` | `apps/web/src/index.css` | done |
| Tab pill with `layoutId` spring | `pages/profile/ProfileTabs.tsx` | done |
| Directed tab-body entrance | `pages/profile/ProfileTabs.tsx` | done (this branch) |
| Spring forum panel + container | `pages/Profile.tsx` | done (this branch) |
| `MotionConfig` / app-level defaults | — | **missing**: no global reduced-motion wiring, every component repeats it |

## 3. Gap on the profile page

- The profile has **no shared element with its origin**. Opening `/profile/:id`
  from the messenger, the feed or a wall post is a plain route swap
  (`fade`/`rise`/`slide` depending on the viewer's setting). The avatar you
  clicked has nothing to do with the avatar that appears.
- **Avatar gallery** (`AvatarGalleryDialog`) opens as a modal box; the avatar
  does not grow into it. This is rule 1 violated on the one screen where it is
  most obvious.
- **Edit mode** swaps `ProfileHeader` for `ProfileEditPanel` by unmounting —
  a hard cut in the middle of the page the user is looking at.
- **Stats** (`ProfileStats`) appear with their final numbers; no arrival.
- **One background variant fits all**: `card` / `banner` / `page` / `page_dim`
  have no motion at all, so the profile's most personal surface is static.
- The **wall** (`ProfileWall`) mounts as one block: posts do not arrive, they
  are just suddenly there.
- `prefers-reduced-motion` is honoured per component by hand; a component that
  forgets is a bug we cannot test for.

---

## 4. Proposals — pick from this list

Sizes: **S** ≤ half a day, **M** 1–2 days, **L** ≥ 3 days.

### P1. Avatar → gallery, shared-element morph (S/M)
`AvatarGalleryDialog` stops fading in: the avatar's rect is captured, the dialog
runs a `startViewTransition` with `view-transition-name: profile-avatar` moving
from the header avatar to the gallery image; the backdrop dims, the header does
not move. Closing reverses into the exact same circle. **Rule 1+4.** Cheapest
real "Telegram" moment on the page.

**Done — as a flying element, not a View Transition** (`components/profile/AvatarMorph.tsx`
+ `toViewportRect` in `utils/domRect.ts`, wired in `pages/Profile.tsx`; `Lightbox`
takes an opt-in `hideActiveMedia`). Measured in the browser:
- **radius** `50% → 0` in ~170 ms (crisp ease-out, front-loaded: 3 % by 130 ms);
- **size** 80 px → 512 px on the `soft` spring, ~490 ms.

So the shape settles long before the window finishes opening — by the time the
photo is shown the image has been square for ~250 ms, and the last thing the eye
registers is the box expanding, not a shape changing. Closing is symmetric
(50 % by 170 ms, avatar at ~300 ms). The same element is on screen the whole way,
so there is no dissolve and nothing to hand over at the end except the real photo
in the identical box.

Notes:
- the tap opens the **story viewer** when the profile has live stories, so the
  gallery (and this morph) is reachable only on profiles without stories;
- the photo is `decode()`d before the gallery mounts — an `<img>` without an
  intrinsic size has no box, and the morph would have nothing to land on;
- geometry is scale-based (the element is laid out at its end size, the start is
  a translate + scale) — animating `width`/`height` would reflow every frame.

**Dead end, do not repeat:** doing this with View Transitions
(`view-transition-name` on the avatar + animated `border-radius`/`overflow: clip`
on the group) cross-fades acceptably but cannot MASK-morph: with the group clipped,
Chrome paints the whole incoming page clipped to a wrong box — the dark viewer
shows up as a smaller rectangle with the profile visible around and below it.
Tried: disabling the root cross-fade, disabling the lightbox `backdrop-filter`,
freezing the animation at 6 s — the clipped incoming snapshot persists, so it is
the snapshot, not our CSS. **View Transitions can only cross-fade two snapshots
for this pair.**

### P2. Profile opens from its origin (M/L)
`/profile/:id` opened from a wall post / message / feed card morphs that card's
avatar into the profile header instead of a route swap. Needs an origin handoff
(`view-transition-name` injected on the source avatar + matching name on the
target), plus a fallback for direct URL entry. **Rule 1+2+3.** This is the video's
hero transition (frames 2/3) and the hardest piece; it also touches routing, so
it wants its own branch.

### P3. Edit mode as a layout morph (M)
Entering edit no longer unmounts the header: the identity block stays mounted and
the fields *become* inputs (`layout` animation on the container, height/opacity
spring); leaving collapses back. Stats and tabs slide out instead of blinking.
**Rule 1+6.**

### P4. Stats arrival + counters (S)
Counters roll from 0 to value on first paint (spring, ~700 ms, `tabular-nums` so
nothing jitters), each stat 40 ms after the previous. Garma ring draws itself.
**Rule 6.**

### P5. Wall posts arrive in a stagger (S/M)
The first page of `ProfileWall` enters as a short cascade (40 ms apart, 10 px
rise, `standard` spring) on the *first* load only — not on every re-render, not
on pagination. **Rule 6.**

### P6. Avatar → full-screen photo (M)
The reel's frame 4/5: tap the avatar → it grows into a full-width rounded
rectangle over the page, back/Edit stay pinned; tap/scroll back to shrink into
the circle. Overlaps with the existing gallery dialog — one of them has to absorb
the other, so decide the direction before building.

### P7. Profile background that moves (M)
Owner's background gets a slow, GPU-cheap life: a 12–20 s parallax drift on the
`page`/`page_dim` variants and a breathing blur on the `card` variant, plus
fade-in on load instead of a hard pop. Disabled under `perf-lite` and reduced
motion. **Rule 7** (it must stay slow — this is ambience, not an effect).

### P8. Global `MotionConfig` + guard test (S)
Wrap the app in `MotionConfig reducedMotion="user"` so no component can forget,
and add a test that fails when a `duration:` transition appears on a transform
property in `pages/` or `components/`. **Enabler for everything above**, and it
is what stops the language from rotting.

**Done.** `MotionConfig reducedMotion="user"` at the app root; the guard
(`lib/motion.contract.test.ts`) forbids inline `stiffness`/`damping` and raw
`type: "spring"` outside `lib/motion.ts`; the nine pre-existing inline springs
(ink bar, friend button, panel toggle, swipe-back ×3, tab pill ×2) were migrated
to presets. The guard checks *provenance*, not duration: a `duration` on a fade is
legitimate, so the rule is "physics comes from the presets file".

---

## 5. Non-goals (deliberately not doing)

- **No confetti / gift rain on profiles.** The reel's bubbles are Telegram's
  paid-gift product, not motion design; porting them means inventing a feature
  we do not have. We have gifts and drops — if we ever animate them, it is one
  orb that arrives with the gift event, not a permanent ornament.
- **No scroll-linked parallax in the wall or the messenger.** The messenger
  scroll is a hand-tuned system (`MESSENGER_CHAT_SCROLL.md`); scroll-linked
  transforms there are how you reintroduce the iOS stutter.
- **No blur/backdrop-filter animation** — it is the most expensive thing a
  browser can animate and it drops frames on mobile. Blur may be *set*, never
  *tweened*.
- **No `width`/`height`/`top` animation** in lists; geometry on `transform` only.
- **No duration-based easing for transforms.** Opacity may keep a tween; every
  position/scale/rotation is a spring.

## 6. How we verify a transition

- 60 fps with DevTools Performance while the transition runs (no long tasks,
  no layout thrash).
- Grabbable: start the gesture, reverse mid-flight — it must follow, not restart.
- `prefers-reduced-motion: reduce` → instant, same end state, nothing lost.
- `perf-lite` tier → no View Transition, no ambient loops.
- Keyboard/screen-reader unaffected: focus lands on the same element before and
  after.
