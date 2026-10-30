// A reusable "ink" hover effect: a soft primary blob that springs under the
// hovered/focused child marked with `data-ink`. Wrap a row of buttons; the
// blob never intercepts pointer events.

import { forwardRef, useCallback, useEffect, useRef, useState, type FocusEvent, type ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { springFor } from "@/lib/motion";

/** Mark a child so the ink blob glides under it. */
export const INK_ATTR = "data-ink";

/**
 * Icon button for an InkBar: no flat hover tint (the blob is the hover
 * feedback), rounded, focus-ringed, marked with data-ink. `active` renders the
 * filled primary pill used by the formatting toolbar.
 */
/** Active state: frosted glass with a primary tint, not a hard fill. */
const glassActiveClass =
  "bg-gradient-to-b from-primary/25 to-primary/5 text-primary ring-1 ring-inset ring-primary/30 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.22)]";

/** Plain glass ghost button (no ink blob): used for the composer header. */
export const glassGhostButtonClass =
  "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export const inkButtonClass = (active = false, size: "sm" | "md" = "md") =>
  `relative z-10 inline-flex ${size === "sm" ? "h-8 w-8" : "h-9 w-9"} shrink-0 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 ${
    active ? glassActiveClass : "text-muted-foreground hover:text-foreground"
  }`;

export const InkButton = forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean; size?: "sm" | "md" }
>(({ active = false, size = "md", className = "", children, ...props }, ref) => (
  <button
    ref={ref}
    type="button"
    aria-pressed={props["aria-pressed"] ?? (active || undefined)}
    {...{ [INK_ATTR]: true }}
    className={`${inkButtonClass(active, size)} ${className}`}
    {...props}
  >
    {children}
  </button>
));
InkButton.displayName = "InkButton";

export const InkBar = ({
  children,
  className = "",
  blobClassName = "h-8 w-8",
}: {
  children: ReactNode;
  className?: string;
  /** Size of the blob — match the target buttons (e.g. "h-9 w-9"). */
  blobClassName?: string;
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const reduceMotion = useReducedMotion();
  const [ink, setInk] = useState({ x: 0, y: 0, visible: false });
  // mouseover bubbles from every child — gliding to the same element twice is
  // a wasted render, not motion.
  const lastTargetRef = useRef<HTMLElement | null>(null);
  // Hiding is debounced: sliding fast across a gap to the next button must
  // keep gliding, but resting on a gap (or anywhere off the buttons) has to
  // drop the blob — otherwise it stays stuck on the last button.
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelHide = useCallback(() => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  useEffect(() => cancelHide, [cancelHide]);

  const hideNow = useCallback(() => {
    cancelHide();
    lastTargetRef.current = null;
    setInk((prev) => (prev.visible ? { ...prev, visible: false } : prev));
  }, [cancelHide]);

  const scheduleHide = useCallback(() => {
    if (hideTimerRef.current) return;
    hideTimerRef.current = setTimeout(() => {
      hideTimerRef.current = null;
      lastTargetRef.current = null;
      setInk((prev) => (prev.visible ? { ...prev, visible: false } : prev));
    }, 90);
  }, []);

  const moveTo = useCallback(
    (element: HTMLElement | null) => {
      if (!element || lastTargetRef.current === element) return;
      cancelHide();
      lastTargetRef.current = element;
      // offsetLeft/Top are relative to the positioned container and scroll-safe.
      setInk({ x: element.offsetLeft, y: element.offsetTop, visible: true });
    },
    [cancelHide],
  );

  const findInkTarget = (target: EventTarget | null): HTMLElement | null => {
    if (!(target instanceof HTMLElement)) return null;
    const element = target.closest<HTMLElement>(`[${INK_ATTR}]`);
    return element && containerRef.current?.contains(element) ? element : null;
  };

  return (
    <div
      ref={containerRef}
      className={`relative ${className}`}
      onMouseLeave={hideNow}
      onMouseOver={(event) => {
        const element = findInkTarget(event.target);
        if (element) moveTo(element);
        else scheduleHide();
      }}
      onFocusCapture={(event) => moveTo(findInkTarget(event.target))}
      onBlurCapture={(event: FocusEvent<HTMLDivElement>) => {
        const next = event.relatedTarget;
        if (!(next instanceof HTMLElement) || !containerRef.current?.contains(next)) hideNow();
      }}
    >
      <motion.span
        aria-hidden="true"
        initial={false}
        animate={{ x: ink.x, y: ink.y, opacity: ink.visible ? 1 : 0, scale: ink.visible ? 1 : 0.55 }}
        transition={springFor("snappy", reduceMotion)}
        className={`pointer-events-none absolute left-0 top-0 z-0 rounded-full bg-primary/30 blur-[7px] ${blobClassName}`}
      />
      {children}
    </div>
  );
};
