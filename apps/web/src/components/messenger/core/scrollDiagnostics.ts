/**
 * Smoothness counters for the chat list — dev only.
 *
 * "It feels janky" is not a bug report and "it feels smooth now" is not a fix.
 * The one number that separates the two is:
 *
 *   **`writesDuringGesture` — how many `scrollTop` writes happened between the
 *   first scroll event and the verified rest.** It must be 0.** A write in that
 *   window is what a reader feels as a jump (WebKit drops it and replays it
 *   later; Chromium paints it), and every rule in `MessageList.tsx` exists to
 *   keep it at 0.
 *
 *   A gesture therefore means *the reader is scrolling the content*: a tap (on
 *   the "to the newest message" button, on a message) is not one, and neither is
 *   the glide it starts — those writes are deliberate navigation. The one
 *   legitimate exception is `chrome:*`: Safari's collapsing toolbar resizes the
 *   scroller mid-scroll, and keeping the reader's place then costs one write.
 *
 * Everything here is a no-op unless the overlay is enabled, so the cost in a
 * normal session is one boolean test per call site.
 *
 * Enable with `?scrolldebug=1` in the URL or in the console:
 *
 * ```js
 * localStorage.setItem("gomo6:scrolldebug", "1"); location.reload();
 * ```
 */

export const SCROLL_DEBUG_STORAGE_KEY = "gomo6:scrolldebug";

export interface ScrollDiagnosticsSnapshot {
  /** Writes during the gesture in flight (the number that must stay 0). */
  writesDuringGesture: number;
  /** Rows mounted / dropped by the gesture in flight. */
  mountedDuringGesture: number;
  droppedDuringGesture: number;
  /** Where the last write inside a gesture came from (should stay empty). */
  lastWriteSource: string | null;
  /** Totals since the last reset. */
  writesTotal: number;
  commits: number;
  lastCommitMs: number;
  maxCommitMs: number;
  pageRequests: number;
  restPasses: number;
  /** Rows currently mounted, as reported by the last commit. */
  mountedRows: number;
  /** Worst gesture seen since the last reset. */
  worstGestureWrites: number;
  /** Frames longer than this in the overlay's own loop (set while visible). */
  longFrameMs: number;
  longFrames: number;
  /** Layout reads caught in the mutation phase by the strict pass (dev only). */
  strictViolations: number;
  lastStrictCause: string | null;
}

const state: ScrollDiagnosticsSnapshot = {
  writesDuringGesture: 0,
  mountedDuringGesture: 0,
  droppedDuringGesture: 0,
  lastWriteSource: null,
  writesTotal: 0,
  commits: 0,
  lastCommitMs: 0,
  maxCommitMs: 0,
  pageRequests: 0,
  restPasses: 0,
  mountedRows: 0,
  worstGestureWrites: 0,
  longFrameMs: 50,
  longFrames: 0,
  strictViolations: 0,
  lastStrictCause: null,
};

let enabled = false;
let gestureOpen = false;
const listeners = new Set<() => void>();
let notifyScheduled = false;

function notify(): void {
  if (listeners.size === 0 || notifyScheduled) return;
  notifyScheduled = true;
  // The counters change per commit and per write; the overlay only needs to keep
  // up with the eye, and this keeps the instrumentation itself out of the
  // frame budget.
  setTimeout(() => {
    notifyScheduled = false;
    for (const listener of listeners) listener();
  }, 120);
}

function readConfiguredFlag(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (new URLSearchParams(window.location.search).get("scrolldebug") === "1") return true;
    return window.localStorage.getItem(SCROLL_DEBUG_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function isScrollDiagnosticsEnabled(): boolean {
  return enabled;
}

/** Called once at module load; `__setScrollDiagnosticsEnabled` for tests. */
export function initScrollDiagnostics(): boolean {
  enabled = readConfiguredFlag();
  return enabled;
}

export function subscribeScrollDiagnostics(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function readScrollDiagnostics(): ScrollDiagnosticsSnapshot {
  return { ...state };
}

/** The first scroll event (or the first pointer down) opens a gesture. */
export function noteGestureStart(): void {
  if (!enabled || gestureOpen) return;
  gestureOpen = true;
  state.writesDuringGesture = 0;
  state.mountedDuringGesture = 0;
  state.droppedDuringGesture = 0;
  state.lastWriteSource = null;
  notify();
}

/**
 * The verified rest closes the gesture. The count of the gesture that just ended
 * deliberately STAYS on screen — that is the moment a reader or a developer
 * looks at it — and the next gesture clears it.
 */
export function noteGestureEnd(): void {
  if (!enabled) return;
  state.restPasses += 1;
  if (!gestureOpen) return;
  gestureOpen = false;
  state.worstGestureWrites = Math.max(state.worstGestureWrites, state.writesDuringGesture);
  notify();
}

/** Every programmatic position write, whatever the reason. */
export function noteScrollTopWrite(source: string): void {
  if (!enabled) return;
  state.writesTotal += 1;
  if (gestureOpen) {
    state.writesDuringGesture += 1;
    state.lastWriteSource = source;
  }
  notify();
}

/** Rows added / dropped and the size of the mounted window after a commit. */
export function noteMountedRows(added: number, dropped: number, mounted: number): void {
  if (!enabled) return;
  state.mountedRows = mounted;
  if (gestureOpen) {
    state.mountedDuringGesture += added;
    state.droppedDuringGesture += dropped;
  }
  notify();
}

export function noteCommitDuration(ms: number): void {
  if (!enabled) return;
  state.commits += 1;
  state.lastCommitMs = ms;
  state.maxCommitMs = Math.max(state.maxCommitMs, ms);
  notify();
}

/**
 * A layout read that happened while the mutation phase was running (the strict
 * pass in `core/fasterdom`). Counted and named here so the overlay can show it,
 * and warned once per cause — a repeated cause is one bug, not a stream.
 */
const reportedStrictCauses = new Set<string>();

export function noteStrictViolation(cause: string): void {
  if (!enabled) return;
  state.strictViolations += 1;
  state.lastStrictCause = cause;
  notify();

  if (reportedStrictCauses.has(cause)) return;
  reportedStrictCauses.add(cause);
  console.warn(
    `[scroll] layout read during the mutation phase: \`${cause}\` — ` +
    "move it to a measure pass or wrap it in forceMeasure()",
  );
}

export function notePageRequest(): void {
  if (!enabled) return;
  state.pageRequests += 1;
  notify();
}

export function noteFrame(durationMs: number): void {
  if (!enabled) return;
  if (durationMs >= state.longFrameMs) {
    state.longFrames += 1;
    notify();
  }
}

export function resetScrollDiagnostics(): void {
  state.writesDuringGesture = 0;
  state.mountedDuringGesture = 0;
  state.droppedDuringGesture = 0;
  state.lastWriteSource = null;
  state.writesTotal = 0;
  state.commits = 0;
  state.lastCommitMs = 0;
  state.maxCommitMs = 0;
  state.pageRequests = 0;
  state.restPasses = 0;
  state.mountedRows = 0;
  state.worstGestureWrites = 0;
  state.longFrames = 0;
  state.strictViolations = 0;
  state.lastStrictCause = null;
  reportedStrictCauses.clear();
  gestureOpen = false;
  notify();
}

/** Test hook: force the counters on without touching storage. */
export function __setScrollDiagnosticsEnabled(value: boolean): void {
  enabled = value;
  resetScrollDiagnostics();
}

/** Test hook: is a gesture currently open? */
export function __isGestureOpen(): boolean {
  return gestureOpen;
}
