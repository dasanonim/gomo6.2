import { useCallback, useRef, useState } from "react";

import { runViewTransition, transitionEnterClass, type TransitionStyle } from "@/lib/viewTransitions";

/**
 * Stale-view retention for URL-driven view switching.
 *
 * The view the URL asks for (`target`) is not shown until it reports ready;
 * meanwhile the view already on screen (`shown`) stays put. Progress is the
 * header's loading bar, so switching never flashes a skeleton. Views are
 * mounted while they are the target OR still on screen, and hidden otherwise.
 *
 * Usage:
 *   const view = usePendingView(targetMode, initialMode);
 *   {view.isRendered("feed") && (
 *     <div className={pendingViewClass(view.isShown("feed"))}>
 *       <ThreadFeed onReady={view.readyFor("feed")} />
 *     </div>
 *   )}
 */

export const pendingViewClass = (
  visible: boolean,
  style: TransitionStyle = "fade",
): string => {
  if (!visible) return "hidden";
  return transitionEnterClass(style);
};

export interface PendingView<K extends string> {
  /** The view currently on screen. */
  shown: K;
  /** Mount this view? True while it is the target or still the shown one. */
  isRendered: (view: K) => boolean;
  /** Is this view the one on screen? */
  isShown: (view: K) => boolean;
  /**
   * A STABLE `onReady` callback for this view — stable identity matters, since
   * views put it in effect deps and a fresh function every render would loop.
   */
  readyFor: (view: K) => () => void;
}

export const usePendingView = <K extends string>(
  target: K,
  initial: K,
): PendingView<K> => {
  const [shown, setShownState] = useState<K>(initial);
  const readyCache = useRef(new Map<K, () => void>());
  // Mirrors `shown` so the stable onReady callbacks can tell that their view is
  // already on screen. Swapping to the view that is already shown changes no
  // DOM — and the content of that view (e.g. another раздел in the same
  // component) may already have been swapped underneath by its own fetch.
  const shownRef = useRef<K>(initial);

  const setShown = useCallback((view: K) => {
    shownRef.current = view;
    setShownState(view);
  }, []);

  const readyFor = useCallback(
    (view: K) => {
      let fn = readyCache.current.get(view);
      if (!fn) {
        fn = () => {
          if (shownRef.current === view) return;
          runViewTransition(() => setShown(view));
        };
        readyCache.current.set(view, fn);
      }
      return fn;
    },
    [setShown],
  );

  return {
    shown,
    isRendered: (view: K) => target === view || shown === view,
    isShown: (view: K) => shown === view,
    readyFor,
  };
};
