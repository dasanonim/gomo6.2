/**
 * DEV-only, on-device scroll diagnostics.
 *
 * The scroll physics cannot be reproduced headless, so the device reports its
 * own behaviour. Enable from the browser console (or the Web Inspector console
 * on the phone) and reload:
 *
 *   localStorage.setItem('gomo6:scroll-debug', '1')
 *
 * While a message list is mounted this samples every animation frame and logs
 * anything that can move the visible content, with a `[scroll]` prefix:
 *
 *   [scroll] content dsh=… st=… top=… y=…   scrollHeight changed (history was
 *                                            prepended, or an item was measured)
 *   [scroll] top  <oldId> -> <newId> y=…     the top-most visible message changed
 *   [scroll] loadMore start / done           an older page started/finished
 *
 * `y` is the top-most visible message's screen position: a `[scroll] content`
 * line whose `y` differs from the previous frame's `y` is a VISIBLE jump.
 *
 * Disable with `localStorage.removeItem('gomo6:scroll-debug')`.
 */

const FLAG = "gomo6:scroll-debug";

export function isScrollDebugEnabled(): boolean {
  if (!import.meta.env.DEV) return false;
  try {
    return localStorage.getItem(FLAG) === "1";
  } catch {
    return false;
  }
}

/** Log a one-off note (load start/finish, restore jump, …). */
export function scrollDebugNote(message: string): void {
  if (isScrollDebugEnabled()) {
    console.log(`[scroll] ${message}`);
  }
}

function topVisible(scroller: HTMLElement): { id: string | null; y: number } {
  for (const el of scroller.querySelectorAll(".message-virtual-item")) {
    const rect = el.getBoundingClientRect();
    if (rect.bottom > 0) {
      return { id: el.getAttribute("data-message-id"), y: Math.round(rect.top) };
    }
  }
  return { id: null, y: 0 };
}

/** Starts the per-frame sampler; returns a stop function. */
export function startScrollDebug(scroller: HTMLElement): () => void {
  let raf = 0;
  let lastHeight = scroller.scrollHeight;
  let lastTopId: string | null = null;
  let lastTopY = 0;

  const tick = () => {
    const { id, y } = topVisible(scroller);
    const height = scroller.scrollHeight;
    const st = Math.round(scroller.scrollTop);

    if (Math.abs(height - lastHeight) > 4) {
      console.log(`[scroll] content dsh=${height - lastHeight} st=${st} top=${id} y=${y} dy=${y - lastTopY}`);
    }
    if (id !== lastTopId) {
      console.log(`[scroll] top ${lastTopId ?? "—"} -> ${id ?? "—"} y=${y} st=${st}`);
    }
    lastHeight = height;
    lastTopId = id;
    lastTopY = y;
    raf = requestAnimationFrame(tick);
  };

  raf = requestAnimationFrame(tick);
  console.log("[scroll] debug on");
  return () => {
    cancelAnimationFrame(raf);
    console.log("[scroll] debug off");
  };
}
