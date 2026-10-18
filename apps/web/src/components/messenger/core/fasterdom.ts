/**
 * Batched DOM read/write scheduler.
 *
 * Ported from Telegram Web (`telegram-tt/src/lib/fasterdom/fasterdom.ts`), which
 * is the reference implementation for this whole scroll stack. The rule it
 * enforces is the reason the Telegram list feels smooth and a naive one does
 * not: **layout is read in one batch and written in another**, so a pass never
 * interleaves `offsetTop` reads with DOM writes. One reflow per frame instead of
 * one per row.
 *
 * The pass runs in three stages, in this order:
 *
 *   1. `measure` tasks      — read geometry, compute.
 *   2. `mutate` tasks       — apply the writes the measure stage decided.
 *   3. forced reflows       — a task that must *read after writing* (an anchor
 *      restore: measure the new DOM, then write one `scrollTop`). Each task
 *      returns its own write function; every write is deferred until all reflow
 *      tasks have run, so a reflow loop costs exactly one extra reflow.
 *
 * A `mutate` task must never read layout and a `measure` task must never write,
 * or the batching is pointless. `forceMeasure` / `forceMutation` are the
 * deliberate escapes used inside a forced-reflow task, where the rules cannot
 * hold by construction (it both reads and writes, and that is the point).
 */

type Task = () => void;
type ReflowTask = () => Task | void;

let measureTasks: Task[] = [];
let mutationTasks: Task[] = [];
const reflowTasks: ReflowTask[] = [];

type Phase = "measure" | "mutate";
let phase: Phase = "measure";

let isPassScheduled = false;
let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

/** A rAF that never fires (hidden tab) must not stall a pending batch. */
const FAST_RAF_TIMEOUT_FALLBACK_MS = 35;

function schedulePass(): void {
  if (isPassScheduled) return;
  isPassScheduled = true;

  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(runPass);
  }
  if (fallbackTimer === null) {
    fallbackTimer = setTimeout(runPass, FAST_RAF_TIMEOUT_FALLBACK_MS);
  }
}

function clearFallbackTimer(): void {
  if (fallbackTimer !== null) {
    clearTimeout(fallbackTimer);
    fallbackTimer = null;
  }
}

function safeExec<T>(task: () => T): T | undefined {
  try {
    return task();
  } catch (error) {
    // One broken task must not swallow the rest of the batch.
    console.error(error);
    return undefined;
  }
}

function runPass(): void {
  if (!isPassScheduled) return;
  isPassScheduled = false;
  clearFallbackTimer();

  phase = "measure";
  const measures = measureTasks;
  measureTasks = [];
  for (const task of measures) safeExec(task);

  // The mutation stage is deferred to a microtask so it lands after the
  // microtasks the DOM itself queued for the mutations just made (Mutation
  // Observer callbacks), and still before the browser paints this frame.
  queueMicrotask(runMutationStage);
}

function runMutationStage(): void {
  phase = "mutate";
  const mutations = mutationTasks;
  mutationTasks = [];
  for (const task of mutations) safeExec(task);

  phase = "measure";
  const writes: Task[] = [];
  // Reflow tasks may register more reflow tasks; they all run before any write.
  while (reflowTasks.length > 0) {
    const task = reflowTasks.shift()!;
    const write = safeExec(task);
    if (typeof write === "function") writes.push(write);
  }

  if (writes.length > 0) {
    phase = "mutate";
    for (const write of writes) safeExec(write);
    phase = "measure";
  }
}

/** Reads layout. Runs before every mutation of the same frame. */
export function requestMeasure(cb: Task): void {
  measureTasks.push(cb);
  schedulePass();
}

/** Writes the DOM. Never reads layout. */
export function requestMutation(cb: Task): void {
  mutationTasks.push(cb);
  schedulePass();
}

/** A write that depends on a measurement taken right before it. */
export function requestNextMutation(cb: ReflowTask): void {
  requestMeasure(() => {
    requestMutation(() => {
      cb();
    });
  });
}

/**
 * Reads layout *inside* a mutation/reflow context and returns the write that
 * must follow the next reflow. This is the only sanctioned way to interleave
 * read and write, and it is what an anchor restore needs:
 *
 * ```ts
 * requestForcedReflow(() => {
 *   const delta = readAnchorDelta(container);   // read, after the DOM changed
 *   return () => { container.scrollTop += delta; };  // write, once
 * });
 * ```
 */
export function requestForcedReflow(cb: ReflowTask): void {
  reflowTasks.push(cb);
  schedulePass();
}

/** Temporarily allow reads while the phase is `mutate`. */
export function forceMeasure<T>(cb: () => T): T {
  const previous = phase;
  phase = "measure";
  try {
    return cb();
  } finally {
    phase = previous;
  }
}

/** Temporarily allow writes while the phase is `measure`. */
export function forceMutation<T>(cb: () => T): T {
  const previous = phase;
  phase = "mutate";
  try {
    return cb();
  } finally {
    phase = previous;
  }
}

/** Current phase — for assertions in tests, never for branching in app code. */
export function getPhase(): Phase {
  return phase;
}

/** Test-only: drop pending work so one test cannot leak into the next. */
export function __resetFasterdomForTests(): void {
  measureTasks = [];
  mutationTasks = [];
  reflowTasks.length = 0;
  phase = "measure";
  isPassScheduled = false;
  clearFallbackTimer();
}
