/**
 * Global mobile virtual-keyboard handling — minimal core (iOS Safari /
 * Android Chrome / Android Firefox / tablets), built on the native Visual
 * Viewport API.
 *
 * One rule, one writer: the published geometry (`--kb-inset` / `--app-vh` on
 * <html>, plus the `kb-open` class) ALWAYS equals the latest live
 * visual-viewport measurement. Nothing here resizes, pins, or animates
 * anything in JS — smoothness comes from a single CSS `transition: translate`
 * on the chat panel (see messenger.css), which turns both the choppy
 * open-steps and the late close event into one continuous glide.
 *
 * Standard behavior, no resistance: the WHOLE chat panel — topbar included —
 * rides up with the keyboard and glides back down when it leaves, exactly
 * like a native page. Pinning the header while the body moved is what used
 * to read as flicker (two competing motions on the first open); now there is
 * only one motion and nothing to fight it.
 *
 * Two WebKit quirks are absorbed without timers:
 *  • the keyboard-open animation can end with ONE transient resize reporting
 *    the pre-keyboard geometry (false close while an editable still has
 *    focus) — close reports that arrive while focus is live are ignored up to
 *    a few frames; a close that persists is accepted (a real close whose blur
 *    hasn't been delivered yet);
 *  • right after a committed close, one stale "open" transient can arrive
 *    while the keyboard is actually gone — opens without live focus are
 *    suppressed for a moment after each close.
 *
 * The document itself is made unscrollable while a chat is open
 * (`body.messenger-mobile-chat-active`), so Safari cannot pan it to "reveal"
 * the focused input — no scroll pinning needed.
 *
 * On Android (interactive-widget=resizes-content, set in index.html) the
 * layout viewport shrinks natively: the delta is ~0 and the fixed panel moves
 * with the layout — no translate is applied.
 *
 * Only touch devices ((pointer: coarse)) get keyboard handling; desktop is
 * untouched.
 */

export interface MobileKeyboardState {
  /** True while a software keyboard covers part of the viewport (touch only). */
  isOpen: boolean;
  /** Height in px of the area covered by the keyboard (0 when closed / non-touch). */
  keyboardInset: number;
  /** Current visual viewport height in px (screen minus URL bar/keyboard). */
  viewportHeight: number;
  /** True on touch devices — keyboard handling is active there. */
  isTouch: boolean;
}

type Listener = () => void;

const TOUCH_QUERY = "(pointer: coarse)";
/** Below this height difference the resize is URL-bar noise, not a keyboard. */
const OPEN_THRESHOLD_PX = 60;
/** After a committed close, stale "open" transients without live focus are
 *  ignored for this long — the keyboard cannot genuinely come back with no
 *  editable owner. */
const POST_CLOSE_SUPPRESS_MS = 300;
/** Close reports arriving while an editable still has focus are ignored for up
 *  to this many follow-loop frames (the one-frame WebKit false-close); a close
 *  that persists longer is accepted as real. */
const FOCUSED_CLOSE_TOLERANCE_FRAMES = 8;

const listeners = new Set<Listener>();
let initialized = false;
let state: MobileKeyboardState = {
  isOpen: false,
  keyboardInset: 0,
  viewportHeight: typeof window === "undefined" ? 0 : window.innerHeight,
  isTouch: false,
};
// Last published geometry (equality guard: skip redundant DOM writes so the
// CSS transition is never pointlessly retargeted).
let lastInset = -1;
let lastVh = -1;
// Until this timestamp, "open" reports without live focus are stale
// post-close transients and are ignored.
let suppressOpenUntil = 0;
// Consecutive close reports ignored while an editable still has focus.
let focusedCloseFrames = 0;
// The per-frame geometry follow (see startFollowLoop).
let followRaf: number | null = null;
let followActive = false;

// ── Public API ───────────────────────────────────────────────────────────────

export function getMobileKeyboardState(): MobileKeyboardState {
  return state;
}

/** Subscribe to state changes (used by useSyncExternalStore). Returns unsubscribe. */
export function subscribeMobileKeyboard(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Idempotent. Call once from the app entry point. Returns a dispose fn. */
export function initMobileKeyboard(): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => undefined;
  }
  if (initialized) return () => undefined;
  initialized = true;

  const vv = window.visualViewport;
  if (vv) {
    vv.addEventListener("resize", handleMetricsChanged);
    vv.addEventListener("scroll", handleMetricsChanged);
  }
  window.addEventListener("resize", handleMetricsChanged);
  window.addEventListener("orientationchange", handleMetricsChanged);
  window.addEventListener("pageshow", handleMetricsChanged);
  document.addEventListener("focusin", handleFocusIn);

  // Seed the CSS variables immediately so full-screen surfaces are sized
  // correctly before the first user interaction. Reset everything first: a
  // previous (e.g. hot-reload) session must not resurrect its geometry — a
  // leftover open state would arm the stale-open suppression in the seed
  // itself, swallowing the next genuine open. The sentinel (-1) forces the
  // seed write through the equality guard.
  state = {
    isOpen: false,
    keyboardInset: 0,
    viewportHeight: typeof window === "undefined" ? 0 : window.innerHeight,
    isTouch: state.isTouch,
  };
  lastInset = -1;
  lastVh = -1;
  suppressOpenUntil = 0;
  focusedCloseFrames = 0;
  applyState(computeRaw());

  return () => {
    initialized = false;
    if (vv) {
      vv.removeEventListener("resize", handleMetricsChanged);
      vv.removeEventListener("scroll", handleMetricsChanged);
    }
    window.removeEventListener("resize", handleMetricsChanged);
    window.removeEventListener("orientationchange", handleMetricsChanged);
    window.removeEventListener("pageshow", handleMetricsChanged);
    document.removeEventListener("focusin", handleFocusIn);
    suppressOpenUntil = 0;
    focusedCloseFrames = 0;
    if (followRaf !== null) cancelAnimationFrame(followRaf);
    followRaf = null;
    followActive = false;
  };
}

// ── Pure helpers (exported for tests and the composer-sheet writer) ─────────

export function computeKeyboardMetrics(input: {
  innerHeight: number;
  visualViewportHeight: number | null;
  /** iOS: the visual viewport is pushed down by the expanded URL bar
   *  (visualViewport.offsetTop ≈ URL-bar height, 0 when collapsed). */
  visualViewportOffsetTop?: number;
  isTouch: boolean;
}): Pick<MobileKeyboardState, "isOpen" | "keyboardInset" | "viewportHeight"> {
  const { innerHeight, visualViewportHeight, visualViewportOffsetTop = 0, isTouch } = input;
  if (visualViewportHeight === null) {
    return { isOpen: false, keyboardInset: 0, viewportHeight: innerHeight };
  }
  const delta = innerHeight - visualViewportHeight;
  const isOpen = isTouch && delta >= OPEN_THRESHOLD_PX;
  return {
    isOpen,
    // The delta covers everything below the visual viewport — on iOS that is
    // the keyboard PLUS the expanded URL bar (visualViewport.offsetTop), which
    // sits at the TOP of the screen. A bottom-anchored bar must only clear the
    // real keyboard height; including the URL bar makes it float up by that
    // amount whenever the keyboard opens mid-page (URL bar expanded).
    keyboardInset: isOpen ? Math.max(0, Math.round(delta - visualViewportOffsetTop)) : 0,
    viewportHeight: Math.round(visualViewportHeight),
  };
}

/**
 * Decision of the composer-sheet writer for one visualViewport snapshot
 * (RichComposer sheet: the sheet owns one inline `bottom` writer).
 * One viewport event is never trusted on its own: WebKit emits a stale
 * "open" transient mid-close, and honouring it snaps the bar back up in the
 * middle of the close glide. The arbiter is focus — the keyboard cannot
 * genuinely come back without an editable owning it.
 */
export type SheetBottomAction =
  | "track" // follow the live keyboard height exactly (open / genuine re-open)
  | "begin-close" // keyboard really gone while focus stayed: glide down
  | "settle-zero" // closed and idle: glide to zero
  | "ignore"; // stale event: the close-glide transition owns `bottom`

export function resolveSheetBottomAction(input: {
  viewportOpen: boolean;
  closing: boolean;
  focusedInSheet: boolean;
}): SheetBottomAction {
  if (input.viewportOpen) {
    return input.focusedInSheet || !input.closing ? "track" : "ignore";
  }
  if (input.closing) return "ignore";
  return input.focusedInSheet ? "begin-close" : "settle-zero";
}

/**
 * Stale-upward-jump gate (composer sheet only, see RichComposer).
 * Mid-hide iOS goes silent, then emits one transient with the stale OPEN
 * geometry. Three tells separate it from a genuine rise, and all must hold:
 *  • it reverses the applied direction (live > applied);
 *  • it ends a silence (a gap with no viewport events);
 *  • it reverses a FRESH fall with no user intent after the fall started.
 */
export function isStaleUpwardJump(input: {
  appliedBottom: number;
  liveInset: number;
  /** ms since the previous viewport event (the freeze gap). */
  msSinceLastEvent: number;
  /** ms since the last applied downward move (the fall start). */
  msSinceFallStart: number;
  /** a tap/focus landed after the fall started. */
  intentAfterFallStart: boolean;
}): boolean {
  if (input.liveInset <= input.appliedBottom + 2) return false;
  if (input.intentAfterFallStart) return false;
  return input.msSinceLastEvent > 150 && input.msSinceFallStart < 1500;
}

/** Whether the element accepts text input (input/textarea/select/contenteditable). */
export function isEditableElement(el: Element | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  // Attribute check covers jsdom (which never reports isContentEditable) and
  // contenteditable="false" subtrees.
  const contentEditable = el.getAttribute("contenteditable");
  if (contentEditable !== null && contentEditable !== "false") return true;
  return el.matches("input, textarea, select");
}

// ── Internal wiring ──────────────────────────────────────────────────────────

function computeRaw(): MobileKeyboardState {
  const isTouch = isTouchDevice();
  const innerHeight = typeof window === "undefined" ? 0 : window.innerHeight;
  const vv = typeof window !== "undefined" ? window.visualViewport : null;
  return {
    isTouch,
    ...computeKeyboardMetrics({
      innerHeight,
      visualViewportHeight: vv ? vv.height : null,
      visualViewportOffsetTop: vv ? vv.offsetTop : 0,
      isTouch,
    }),
  };
}

function isTouchDevice(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(TOUCH_QUERY).matches
  );
}

function activeEditable(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const el = document.activeElement;
  return el && isEditableElement(el) ? (el as HTMLElement) : null;
}

/** Instant write; skips the DOM when nothing changed (fewer style recalcs, and
 *  the CSS transition is never pointlessly retargeted). */
function writeGeometryVars(inset: number, vh: number): void {
  if (inset === lastInset && vh === lastVh) return;
  lastInset = inset;
  lastVh = vh;
  const root = document.documentElement;
  root.style.setProperty("--kb-inset", `${inset}px`);
  root.style.setProperty("--app-vh", `${vh}px`);
}

function applyState(next: MobileKeyboardState): void {
  const focusLive = activeEditable() !== null;

  // A swallowed transient changes NOTHING — not vars, not state, not class —
  // so no listener ever observes the phantom geometry.
  if (next.isOpen) {
    if (!focusLive && Date.now() < suppressOpenUntil) {
      return; // stale post-close "open" with no focus owner
    }
    focusedCloseFrames = 0;
    writeGeometryVars(next.keyboardInset, next.viewportHeight);
  } else if (focusLive) {
    // Close report while an editable still has focus: usually the one-frame
    // WebKit false-close at the end of the open animation. Tolerate a few
    // frames; a close that persists is real (its blur is just late).
    focusedCloseFrames += 1;
    if (focusedCloseFrames <= FOCUSED_CLOSE_TOLERANCE_FRAMES) return;
    focusedCloseFrames = 0;
    if (state.isOpen) suppressOpenUntil = Date.now() + POST_CLOSE_SUPPRESS_MS;
    writeGeometryVars(next.keyboardInset, next.viewportHeight);
  } else {
    focusedCloseFrames = 0;
    // A genuine open→closed transition arms the stale-open suppression so a
    // trailing transient can't bounce the panel back up mid-glide.
    if (state.isOpen) suppressOpenUntil = Date.now() + POST_CLOSE_SUPPRESS_MS;
    writeGeometryVars(next.keyboardInset, next.viewportHeight);
  }

  const changed =
    next.isOpen !== state.isOpen ||
    next.keyboardInset !== state.keyboardInset ||
    next.viewportHeight !== state.viewportHeight ||
    next.isTouch !== state.isTouch;
  state = next;

  if (typeof document !== "undefined") {
    document.documentElement.classList.toggle("kb-open", next.isOpen);
  }
  if (changed) {
    for (const listener of listeners) listener();
  }
  startFollowLoop();
}

/**
 * Per-frame geometry follow. visualViewport.height is a LIVE property, so
 * this loop tracks the keyboard's true position every frame: it covers
 * keyboards that open without firing any visual-viewport event (iOS re-focus)
 * and keeps the panel glued between choppy events. The CSS transition turns
 * the stepwise writes into one smooth glide.
 */
function startFollowLoop(): void {
  // Guards against re-entrant chains: applyState runs INSIDE a step and calls
  // startFollowLoop — without the flag every frame would spawn an extra chain
  // that multiplies exponentially.
  if (followActive) return;
  followActive = true;
  const step = () => {
    const focused = activeEditable();
    applyState(computeRaw());
    if (focused || state.isOpen || state.keyboardInset > 0) {
      followRaf = requestAnimationFrame(step);
    } else {
      followActive = false;
    }
  };
  followRaf = requestAnimationFrame(step);
}

function handleMetricsChanged(): void {
  applyState(computeRaw());
}

function handleFocusIn(): void {
  if (!state.isTouch) return;
  // Fresh focus re-arms everything: a real re-open always arrives with a live
  // focus owner, so any pending stale-open suppression is dropped and the
  // follow loop picks the live geometry up again.
  suppressOpenUntil = 0;
  focusedCloseFrames = 0;
  startFollowLoop();
}
