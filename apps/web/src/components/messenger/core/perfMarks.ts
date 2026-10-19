/**
 * Performance marks for the scroll engine, off unless asked for.
 *
 * Ported in spirit from Telegram Web's `IS_PERF` (`console.time('scrollTop')`
 * around the writer): the numbers a scroll engine lives on are how long a commit
 * takes and how much of it is reading versus writing. Here they are published as
 * `performance.mark` / `performance.measure` entries — visible in the browser's
 * Performance panel as real user-timing entries — and, with the flag on, logged
 * once per commit so they can be watched live.
 *
 * Enable in a dev build:
 *   http://localhost:8081/messages?perf=1
 *   localStorage.setItem("gomo6:perf", "1")  + reload
 *
 * When the flag is off every function here is a single boolean test: a production
 * session pays nothing for the instrumentation.
 */

export const PERF_STORAGE_KEY = "gomo6:perf";

export const PERF_COMMIT_START = "gomo6:commit:start";
export const PERF_COMMIT_READ = "gomo6:commit:read";
export const PERF_SCROLL_PASS_START = "gomo6:scroll-pass:start";

let enabled = false;

function readConfiguredFlag(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (new URLSearchParams(window.location.search).get("perf") === "1") return true;
    return window.localStorage.getItem(PERF_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Called once at boot (dev builds only). */
export function initPerfMarks(): boolean {
  enabled = readConfiguredFlag();
  return enabled;
}

export function isPerfEnabled(): boolean {
  return enabled;
}

export function perfMark(name: string): void {
  if (!enabled || typeof performance === "undefined") return;
  performance.mark(name);
}

/**
 * Close a measurement started by `perfMark(fromMark)` and return its duration in
 * milliseconds (undefined when the flag is off).
 */
export function perfMeasure(name: string, fromMark: string): number | undefined {
  if (!enabled || typeof performance === "undefined") return undefined;
  try {
    const measure = performance.measure(name, fromMark);
    return measure.duration;
  } catch {
    // A missing mark (a pass that never started one) is not worth an exception.
    return undefined;
  }
}

/** Log a commit's read/write split when the flag is on. */
export function logCommitTiming(readMs: number | undefined, writeMs: number | undefined): void {
  if (!enabled || readMs === undefined || writeMs === undefined) return;
  console.debug(`[perf] commit read ${readMs.toFixed(1)}ms · write ${writeMs.toFixed(1)}ms`);
}

/** Test-only hook. */
export function __setPerfMarksEnabledForTests(value: boolean): void {
  enabled = value;
}
