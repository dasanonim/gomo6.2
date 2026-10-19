import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PERF_COMMIT_READ,
  PERF_COMMIT_START,
  __setPerfMarksEnabledForTests,
  initPerfMarks,
  isPerfEnabled,
  logCommitTiming,
  perfMark,
  perfMeasure,
} from "./perfMarks";

describe("perfMarks", () => {
  beforeEach(() => {
    localStorage.clear();
    __setPerfMarksEnabledForTests(false);
  });

  afterEach(() => {
    __setPerfMarksEnabledForTests(false);
    localStorage.clear();
  });

  it("is off unless asked for, and costs nothing", () => {
    expect(initPerfMarks()).toBe(false);
    expect(isPerfEnabled()).toBe(false);

    // No mark, no measure, no log — one boolean test per call site.
    const measure = vi.spyOn(performance, "measure");
    const mark = vi.spyOn(performance, "mark");
    perfMark(PERF_COMMIT_START);
    expect(perfMeasure("commit", PERF_COMMIT_START)).toBeUndefined();
    expect(mark).not.toHaveBeenCalled();
    expect(measure).not.toHaveBeenCalled();
    mark.mockRestore();
    measure.mockRestore();
  });

  it("records a real measurement when enabled by the storage flag", () => {
    localStorage.setItem("gomo6:perf", "1");
    expect(initPerfMarks()).toBe(true);

    perfMark(PERF_COMMIT_START);
    perfMark(PERF_COMMIT_READ);
    const readMs = perfMeasure("gomo6:commit:read-ms", PERF_COMMIT_START);
    const writeMs = perfMeasure("gomo6:commit:write-ms", PERF_COMMIT_READ);

    expect(readMs).toBeTypeOf("number");
    expect(writeMs).toBeTypeOf("number");
    // Both are published as user-timing entries, which is what makes them visible
    // in the Performance panel.
    expect(performance.getEntriesByName("gomo6:commit:read-ms")).toHaveLength(1);
  });

  it("logs the commit split only when enabled", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);

    logCommitTiming(1, 2);
    expect(debug).not.toHaveBeenCalled();

    __setPerfMarksEnabledForTests(true);
    logCommitTiming(3.5, 1.25);
    expect(debug).toHaveBeenCalledTimes(1);
    expect(String(debug.mock.calls[0][0])).toContain("commit read 3.5ms");

    debug.mockRestore();
  });

  it("survives a measurement whose start mark never existed", () => {
    __setPerfMarksEnabledForTests(true);
    expect(() => perfMeasure("orphan", "gomo6:never-marked")).not.toThrow();
  });
});
