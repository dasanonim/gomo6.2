import { describe, expect, it, beforeEach } from "vitest";
import {
  __isGestureOpen,
  __setScrollDiagnosticsEnabled,
  noteCommitDuration,
  noteGestureEnd,
  noteGestureStart,
  noteMountedRows,
  notePageRequest,
  noteScrollTopWrite,
  readScrollDiagnostics,
  resetScrollDiagnostics,
} from "./scrollDiagnostics";

describe("scrollDiagnostics", () => {
  beforeEach(() => {
    __setScrollDiagnosticsEnabled(true);
  });

  it("counts a write made inside a gesture, which is the number that matters", () => {
    noteGestureStart();
    noteScrollTopWrite("anchor");

    expect(readScrollDiagnostics().writesDuringGesture).toBe(1);
    expect(readScrollDiagnostics().lastWriteSource).toBe("anchor");
  });

  it("keeps the worst gesture and clears the current one at every rest", () => {
    noteGestureStart();
    noteScrollTopWrite("pin");
    noteScrollTopWrite("glide");
    noteGestureEnd();

    const afterFirst = readScrollDiagnostics();
    expect(afterFirst.worstGestureWrites).toBe(2);
    // The count of the gesture that just ended stays visible (that is when a
    // reader looks at it); the next gesture clears it.
    expect(afterFirst.writesDuringGesture).toBe(2);
    expect(afterFirst.restPasses).toBe(1);

    // A clean gesture must not lower the worst one seen.
    noteGestureStart();
    expect(readScrollDiagnostics().writesDuringGesture).toBe(0);
    noteGestureEnd();
    expect(readScrollDiagnostics().worstGestureWrites).toBe(2);
  });

  it("scopes mounts and drops to the open gesture", () => {
    noteMountedRows(50, 0, 130);
    expect(readScrollDiagnostics().mountedDuringGesture).toBe(0);

    noteGestureStart();
    noteMountedRows(50, 50, 130);
    expect(readScrollDiagnostics().mountedDuringGesture).toBe(50);
    expect(readScrollDiagnostics().droppedDuringGesture).toBe(50);
    expect(readScrollDiagnostics().mountedRows).toBe(130);
  });

  it("tracks commit cost, history requests and totals", () => {
    noteCommitDuration(3.5);
    noteCommitDuration(11.25);
    notePageRequest();
    notePageRequest();

    const snapshot = readScrollDiagnostics();
    expect(snapshot.lastCommitMs).toBe(11.25);
    expect(snapshot.maxCommitMs).toBe(11.25);
    expect(snapshot.commits).toBe(2);
    expect(snapshot.pageRequests).toBe(2);
  });

  it("opens a gesture only once", () => {
    noteGestureStart();
    noteGestureStart();
    expect(__isGestureOpen()).toBe(true);
    noteGestureEnd();
    expect(__isGestureOpen()).toBe(false);
  });

  it("is a no-op when disabled", () => {
    __setScrollDiagnosticsEnabled(false);
    noteGestureStart();
    noteScrollTopWrite("pin");
    noteMountedRows(10, 10, 90);

    const snapshot = readScrollDiagnostics();
    expect(snapshot.writesDuringGesture).toBe(0);
    expect(snapshot.writesTotal).toBe(0);
    expect(snapshot.mountedRows).toBe(0);
    expect(__isGestureOpen()).toBe(false);
  });

  it("resets every counter", () => {
    noteGestureStart();
    noteScrollTopWrite("pin");
    noteCommitDuration(9);
    notePageRequest();
    resetScrollDiagnostics();

    const snapshot = readScrollDiagnostics();
    expect(snapshot.writesTotal).toBe(0);
    expect(snapshot.commits).toBe(0);
    expect(snapshot.pageRequests).toBe(0);
    expect(snapshot.worstGestureWrites).toBe(0);
    expect(__isGestureOpen()).toBe(false);
  });
});
