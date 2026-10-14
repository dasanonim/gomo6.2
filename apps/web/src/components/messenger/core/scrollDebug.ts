/**
 * DEV-only, on-device scroll diagnostics.
 *
 * The scroll physics cannot be reproduced headless, so the device reports its
 * own behaviour. Enable from the browser/Web Inspector console and reload:
 *
 *   localStorage.setItem('gomo6:scroll-debug', '1')
 *
 * While a message list is mounted it samples every animation frame and logs,
 * with a `[scroll]` prefix:
 *
 *   [scroll] JUMP shift=… id=… st=…   the TRACKED message moved on screen while
 *                                     it stayed rendered — a real visible jump
 *                                     (the only reliable jump signal; comparing
 *                                     "top-most" Ys across frames is noise
 *                                     because the top message changes)
 *   [scroll] FRAME …ms (long …)       a dropped frame (jank)
 *   [scroll] loadMore start/done      an older page started/finished
 *
 * `shift` is computed for ONE fixed message: its content position
 * (`screenY + scrollTop`) must change by exactly the same amount as `scrollTop`
 * for the screen to stay still — the difference is the visible jump in that
 * frame.
 *
 * Disable with `localStorage.removeItem('gomo6:scroll-debug')`.
 */

const FLAG = "gomo6:scroll-debug";
const LONG_FRAME_MS = 32;

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
  if (isScrollDebugEnabled()) console.log(`[scroll] ${message}`);
}

function topMostVisible(scroller: HTMLElement): HTMLElement | null {
  for (const el of scroller.querySelectorAll<HTMLElement>(".message-virtual-item")) {
    if (el.getBoundingClientRect().bottom > 0) return el;
  }
  return null;
}

/** Starts the per-frame sampler; returns a stop function. */
export function startScrollDebug(scroller: HTMLElement): () => void {
  let raf = 0;
  let trackedId: string | null = null;
  let lastContentPos = 0;
  let lastScrollTop = scroller.scrollTop;
  let lastFrameAt = performance.now();
  let frames = 0;
  let longFrames = 0;

  const tick = () => {
    const now = performance.now();
    const dt = now - lastFrameAt;
    lastFrameAt = now;
    frames += 1;
    if (dt > LONG_FRAME_MS) {
      longFrames += 1;
      console.log(`[scroll] FRAME ${Math.round(dt)}ms (long ${longFrames}/${frames})`);
    }

    let el = trackedId
      ? scroller.querySelector<HTMLElement>(`[data-message-id="${trackedId}"]`)
      : null;
    let switched = false;
    if (!el) {
      el = topMostVisible(scroller);
      trackedId = el?.getAttribute("data-message-id") ?? null;
      switched = true;
    }

    if (el) {
      const st = scroller.scrollTop;
      // The message's position in CONTENT coordinates. A normal scroll changes
      // `scrollTop` and the screen Y by opposite amounts, so this is constant;
      // any change here is the content moving under a still viewport — the
      // visible jump in this frame.
      const contentPos = el.getBoundingClientRect().top + st;
      if (!switched) {
        const shift = contentPos - lastContentPos;
        if (Math.abs(shift) > 2) {
          console.log(`[scroll] JUMP shift=${Math.round(shift)} id=${trackedId} st=${Math.round(st)}`);
        }
      }
      lastContentPos = contentPos;
      lastScrollTop = st;
    }

    raf = requestAnimationFrame(tick);
  };

  raf = requestAnimationFrame(tick);
  console.log("[scroll] debug on");
  return () => {
    cancelAnimationFrame(raf);
    console.log("[scroll] debug off");
  };
}
