/**
 * The motion-off switch for URL-driven view switching (Settings → Внешний вид).
 *
 * Redesigned: exactly TWO modes, no custom choreography to pick:
 *
 *   "fade" — the app is animated (default). View swaps resolve plainly and let
 *            the containers' shared `.view-fade-in` entrance play.
 *   "none" — HARD OFF. Behaves like `prefers-reduced-motion: reduce` for the
 *            whole site: every CSS animation/transition (see the blanket rule
 *            in index.css) and every framer spring (`MotionConfig
 *            reducedMotion="always"` in App) stop. No half-measures.
 *
 * Stored in localStorage like the other appearance preferences. Legacy saved
 * values from the old five style picker ("rise" / "slide" / "view-transition")
 * map to "fade".
 */

export type TransitionStyle = "fade" | "none";

export const TRANSITION_STYLE_KEY = "transition-style";

export const DEFAULT_TRANSITION_STYLE: TransitionStyle = "fade";

export const TRANSITION_STYLES: { id: TransitionStyle; label: string; description: string }[] = [
  {
    id: "fade",
    label: "Есть анимации",
    description: "Экраны сменяются мягко — стандартное поведение сайта",
  },
  {
    id: "none",
    label: "Без анимации",
    description: "Движение выключено на весь сайт, мгновенно и статично",
  },
];

/** Broadcast so the main page picks up a change made on the Settings page. */
export const TRANSITION_STYLE_EVENT = "gomo6:transition-style";

const normalizeStyle = (saved: string | null): TransitionStyle =>
  saved === "none" ? "none" : "fade";

export const getTransitionStyle = (): TransitionStyle => {
  try {
    return normalizeStyle(localStorage.getItem(TRANSITION_STYLE_KEY));
  } catch {
    return DEFAULT_TRANSITION_STYLE;
  }
};

export const setTransitionStyle = (style: TransitionStyle): void => {
  try {
    localStorage.setItem(TRANSITION_STYLE_KEY, style);
  } catch {
    // ignore
  }
  window.dispatchEvent(new CustomEvent(TRANSITION_STYLE_EVENT, { detail: { style } }));
};

/**
 * The class the incoming view carries while the swap plays. Empty for "none":
 * an inner fade on a motion-off site would itself be an animation.
 */
export const transitionEnterClass = (style: TransitionStyle): string =>
  style === "fade" ? "view-fade-in" : "";

/**
 * True when motion must not run: the OS asks for it — or the user switched the
 * site's own «Без анимации» on, which means the same thing app-wide.
 */
export const prefersReducedMotion = (): boolean => {
  if (getTransitionStyle() === "none") return true;
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  } catch {
    return false;
  }
};

/**
 * The feed and раздел routes animate their own view switches
 * (hooks/usePendingView). Page-level transitions must skip these so the two
 * systems don't animate the same navigation twice.
 */
export const isFeedRoute = (pathname: string): boolean =>
  pathname === "/" || /^\/(feed|mine|history|favorites|c)(\/|$)/.test(pathname);

/**
 * Weak hardware is put on the cheap tier (utils/perfTier) — the always-on glass
 * header is dropped for the same reason transitions are: a device that cannot
 * hold a blur cannot hold a full-screen crossfade either.
 */
export const isPerfLite = (): boolean =>
  typeof document !== "undefined" && document.documentElement.classList.contains("perf-lite");

/**
 * Alias kept for the formerly View-Transitions-aware call sites (pending view,
 * section swaps): applies the update immediately — the plain `.view-fade-in`
 * entrance on the incoming container is the only animation left.
 */
export const runViewTransition = (update: () => void): void => {
  update();
};
