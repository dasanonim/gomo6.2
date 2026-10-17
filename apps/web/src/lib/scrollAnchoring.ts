/**
 * Scroll-anchoring capability, detected *behaviourally*.
 *
 * `overflow-anchor` cannot be trusted through `CSS.supports()`: an engine may
 * parse the property and still not anchor (or anchor only in some cases), and
 * the two engines that matter differ exactly here — Chromium and Firefox adjust
 * the scroll position when content is inserted or resized above the viewport,
 * WebKit (Safari, and every iOS browser) does not.
 *
 * The messenger list leans on that difference:
 *
 *  - **With anchoring** a mounted row may be skipped by `content-visibility`
 *    (`contain-intrinsic-size: auto 64px`). When it scrolls into view and its
 *    real height replaces the 64px estimate, the engine keeps the reader's
 *    content where it was — the whole list stays cheap.
 *  - **Without anchoring** that same height change moves everything below it.
 *    Scrolling up through rows that have not been rendered yet then reads as a
 *    stutter on *every* message, and the scrollable height is underestimated,
 *    so momentum ends early. There the mounted window itself is the
 *    virtualization and every row must stay laid out.
 *
 * The flag is set on `<html>` before the first paint (see main.tsx) and the
 * stylesheet gates `content-visibility` on it.
 */

const FLAG_CLASS = "has-scroll-anchoring";

/** Inserted-height probe: anchoring moves `scrollTop` by exactly this much. */
const INSERTED_PX = 40;

/**
 * True when inserting content above the viewport keeps the visible content in
 * place. Runs one forced layout in a detached, off-screen scroller and removes
 * it immediately; a failure (no DOM, no layout engine, sandboxed frame) is
 * reported as "no anchoring", which is the conservative branch.
 */
export function detectScrollAnchoring(): boolean {
  if (typeof document === "undefined" || !document.body) return false;
  try {
    const scroller = document.createElement("div");
    // `overflow-anchor: auto` is the default, but the property is written out
    // so an engine that needs it explicit still gets the chance to anchor.
    scroller.style.cssText =
      "position:absolute;top:-9999px;left:-9999px;width:120px;height:100px;" +
      "overflow-y:auto;overflow-anchor:auto;pointer-events:none;";
    const filler = document.createElement("div");
    filler.style.height = "200px";
    const marker = document.createElement("div");
    marker.style.height = "50px";
    scroller.append(filler, marker);
    document.body.appendChild(scroller);

    // Content is 250px tall in a 100px viewport, so the marker's top edge sits
    // exactly at the fold.
    scroller.scrollTop = 150;
    void scroller.offsetHeight;
    const before = scroller.scrollTop;

    const inserted = document.createElement("div");
    inserted.style.height = `${INSERTED_PX}px`;
    scroller.insertBefore(inserted, scroller.firstChild);
    void scroller.offsetHeight;
    const after = scroller.scrollTop;

    scroller.remove();

    return after - before >= INSERTED_PX - 1;
  } catch {
    return false;
  }
}

/**
 * Publishes the capability as a class on `<html>` so CSS can branch on it.
 * Idempotent; returns the decision for tests and diagnostics.
 */
export function initScrollAnchoringFlag(): boolean {
  const supported = detectScrollAnchoring();
  const root = document.documentElement;
  root.classList.toggle(FLAG_CLASS, supported);
  return supported;
}

/** Test/diagnostic helper: does the document currently advertise anchoring? */
export function hasScrollAnchoring(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.classList.contains(FLAG_CLASS);
}
