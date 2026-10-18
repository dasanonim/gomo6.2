import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installManualRaf, type ManualRaf } from "@/test/manualRaf";
import {
  __resetFasterdomForTests,
  forceMeasure,
  forceMutation,
  getPhase,
  requestForcedReflow,
  requestMeasure,
  requestMutation,
  requestNextMutation,
} from "./fasterdom";

describe("fasterdom", () => {
  let raf: ManualRaf;

  beforeEach(() => {
    vi.useFakeTimers();
    raf = installManualRaf();
    __resetFasterdomForTests();
  });

  afterEach(() => {
    __resetFasterdomForTests();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** Run one scheduled pass: its rAF plus the microtask it defers to. */
  function runPass() {
    return raf.frame();
  }

  it("runs every measure before any mutation of the same pass", async () => {
    const order: string[] = [];
    requestMutation(() => order.push("mutate-1"));
    requestMeasure(() => order.push("measure-1"));
    requestMutation(() => order.push("mutate-2"));
    requestMeasure(() => order.push("measure-2"));

    await runPass();

    expect(order).toEqual(["measure-1", "measure-2", "mutate-1", "mutate-2"]);
  });

  it("batches the whole frame into a single pass", async () => {
    const measure = vi.fn();
    const mutate = vi.fn();
    for (let i = 0; i < 50; i += 1) {
      requestMeasure(measure);
      requestMutation(mutate);
    }

    await runPass();

    expect(measure).toHaveBeenCalledTimes(50);
    expect(mutate).toHaveBeenCalledTimes(50);
  });

  it("runs a forced reflow after the mutations and writes only afterwards", async () => {
    const order: string[] = [];
    requestMutation(() => order.push("dom-write"));
    requestForcedReflow(() => {
      order.push("reflow-read");
      return () => order.push("reflow-write");
    });

    await runPass();

    expect(order).toEqual(["dom-write", "reflow-read", "reflow-write"]);
  });

  it("runs a reflow registered by another reflow before any write", async () => {
    const order: string[] = [];
    requestForcedReflow(() => {
      order.push("read-1");
      requestForcedReflow(() => {
        order.push("read-2");
        return () => order.push("write-2");
      });
      return () => order.push("write-1");
    });

    await runPass();

    expect(order).toEqual(["read-1", "read-2", "write-1", "write-2"]);
  });

  it("runs a reflow that returns nothing without a write", async () => {
    let ran = false;
    requestForcedReflow(() => {
      ran = true;
    });

    await runPass();

    expect(ran).toBe(true);
  });

  it("runs a next-mutation after this frame's measures", async () => {
    const order: string[] = [];
    requestMeasure(() => order.push("measure"));
    requestNextMutation(() => order.push("next-mutation"));

    await runPass();

    expect(order).toEqual(["measure", "next-mutation"]);
  });

  it("keeps running the rest of the batch when one task throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const done = vi.fn();
    requestMeasure(() => {
      throw new Error("boom");
    });
    requestMeasure(done);

    await runPass();

    expect(done).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it("exposes the phase and lets a task escape it deliberately", async () => {
    const seen: string[] = [];

    requestMutation(() => {
      seen.push(getPhase());
      seen.push(forceMeasure(() => getPhase()));
      seen.push(getPhase());
    });
    requestMeasure(() => {
      seen.push(getPhase());
      seen.push(forceMutation(() => getPhase()));
      seen.push(getPhase());
    });

    await runPass();

    expect(seen).toEqual(["measure", "mutate", "measure", "mutate", "measure", "mutate"]);
  });

  it("still runs the batch when the frame callback never fires", async () => {
    // A hidden tab: rAF is throttled to nothing, the timeout fallback owns it.
    vi.stubGlobal("requestAnimationFrame", () => 0);
    const done = vi.fn();
    requestMutation(done);

    await raf.frame(40);

    expect(done).toHaveBeenCalledTimes(1);
  });
});
