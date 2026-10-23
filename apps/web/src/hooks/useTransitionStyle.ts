import { useEffect, useState } from "react";

import { getTransitionStyle, prefersReducedMotion, TRANSITION_STYLE_EVENT, type TransitionStyle } from "@/lib/viewTransitions";

/** The current transition style, live-updating when Settings changes it. */
export const useTransitionStyle = (): TransitionStyle => {
  const [style, setStyle] = useState<TransitionStyle>(getTransitionStyle);
  useEffect(() => {
    const sync = () => setStyle(getTransitionStyle());
    window.addEventListener(TRANSITION_STYLE_EVENT, sync);
    return () => window.removeEventListener(TRANSITION_STYLE_EVENT, sync);
  }, []);
  // The `.view-fade-in` entrance keys off this flag on <html>, so containers
  // stop their one remaining animation exactly when the style is "none".
  useEffect(() => {
    document.documentElement.dataset.transitionStyle = style;
  }, [style]);
  return style;
};

/**
 * True when motion must NOT run anywhere: the user picked «Без анимации» or
 * the OS asks for reduced motion. Consumed by the root MotionConfig so every
 * framer spring in the app drops as one — no per-component fixes needed.
 */
export const useMotionOff = (): boolean => {
  const [off, setOff] = useState(() => getTransitionStyle() === "none" || prefersReducedMotion());
  useEffect(() => {
    const sync = () => setOff(getTransitionStyle() === "none" || prefersReducedMotion());
    window.addEventListener(TRANSITION_STYLE_EVENT, sync);
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    mq?.addEventListener?.("change", sync);
    return () => {
      window.removeEventListener(TRANSITION_STYLE_EVENT, sync);
      mq?.removeEventListener?.("change", sync);
    };
  }, []);
  return off;
};
