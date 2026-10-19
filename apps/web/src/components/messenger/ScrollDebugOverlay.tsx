import { memo, useEffect, useState } from "react";
import {
  noteFrame,
  readScrollDiagnostics,
  resetScrollDiagnostics,
  subscribeScrollDiagnostics,
  type ScrollDiagnosticsSnapshot,
} from "./core/scrollDiagnostics";

/**
 * Dev-only readout for the chat scroll engine (see `core/scrollDiagnostics`).
 *
 * Rendered by `MessageList` only in a dev build with the flag on:
 * `?scrolldebug=1` in the URL, or
 * `localStorage.setItem("gomo6:scrolldebug", "1")` + reload.
 *
 * The line to watch is the first one. Scrolling must leave it at zero writes:
 * every write the engine makes belongs to a commit (a message arrived, a page
 * was mounted, the chrome resized), never to the reader's own gesture.
 */
export const ScrollDebugOverlay = memo(function ScrollDebugOverlay() {
  const [snapshot, setSnapshot] = useState<ScrollDiagnosticsSnapshot>(readScrollDiagnostics);

  useEffect(() => subscribeScrollDiagnostics(() => setSnapshot(readScrollDiagnostics())), []);

  // Long frames are only measured while the overlay is on the screen.
  useEffect(() => {
    let frame = 0;
    let last = performance.now();
    const tick = () => {
      const now = performance.now();
      noteFrame(now - last);
      last = now;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  const isClean = snapshot.writesDuringGesture === 0;

  return (
    <div className="scroll-debug" role="status" aria-live="off">
      <div className="scroll-debug-head">
        <span>scroll engine</span>
        <button type="button" onClick={() => resetScrollDiagnostics()}>reset</button>
      </div>
      <div className={`scroll-debug-row${isClean ? "" : " is-bad"}`}>
        <span>записей scrollTop за прокрутку</span>
        <b>{snapshot.writesDuringGesture}</b>
      </div>
      <div className="scroll-debug-row">
        <span>смонтировано / снято за прокрутку</span>
        <b>{snapshot.mountedDuringGesture} / {snapshot.droppedDuringGesture}</b>
      </div>
      {!isClean && (
        <div className="scroll-debug-note">
          запись внутри прокрутки — это и есть рывок{snapshot.lastWriteSource ? ` (${snapshot.lastWriteSource})` : ""}
          {snapshot.lastWriteSource?.startsWith("chrome:")
            ? " — это ресайз вьюпорта (панель Safari), а не скролл"
            : ""}
        </div>
      )}
      <div className="scroll-debug-row">
        <span>строк в окне</span>
        <b>{snapshot.mountedRows}</b>
      </div>
      <div className="scroll-debug-row">
        <span>коммит, последний / максимум</span>
        <b>{snapshot.lastCommitMs.toFixed(1)} / {snapshot.maxCommitMs.toFixed(1)} мс</b>
      </div>
      <div className="scroll-debug-row">
        <span>длинных кадров (&ge;{snapshot.longFrameMs} мс)</span>
        <b>{snapshot.longFrames}</b>
      </div>
      {snapshot.strictViolations > 0 && (
        <div className="scroll-debug-row is-bad">
          <span>чтений layout в мутирующей фазе</span>
          <b>{snapshot.strictViolations}{snapshot.lastStrictCause ? ` (${snapshot.lastStrictCause})` : ""}</b>
        </div>
      )}
      <div className="scroll-debug-row">
        <span>запросов истории / покоев</span>
        <b>{snapshot.pageRequests} / {snapshot.restPasses}</b>
      </div>
      <div className="scroll-debug-row">
        <span>записей всего, худший жест</span>
        <b>{snapshot.writesTotal}, {snapshot.worstGestureWrites}</b>
      </div>
    </div>
  );
});
