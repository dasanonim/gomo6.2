import { useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { motion, useReducedMotion, useScroll, useTransform } from "motion/react";

export interface RecedeOnScrollProps {
  children: ReactNode;
  /** Extra classes for the measuring wrapper. */
  className?: string;
  /** How much of the block must pass the top edge for the pull-in to finish (0..1). */
  exitAt?: number;
  /** Start the pull-in this far before the block's top reaches the viewport top. */
  leadPx?: number;
  /** 0..1 strength multiplier — lower for secondary blocks. */
  intensity?: number;
}

/**
 * Pulls a block "into" the top edge as the page scrolls: the block scales down,
 * rises and loses contrast just before it leaves the viewport, then the next
 * block does the same. Every instance measures its own document box, so stacked
 * blocks (header → stats → bio) are drawn in one after another with no shared
 * timeline and no per-frame React state.
 *
 * The measuring wrapper never receives the transform — only the inner element
 * does — so `getBoundingClientRect` on the wrapper keeps returning the layout
 * box even while the content is scaled, and the range can be re-measured safely
 * after content grows.
 */
export function RecedeOnScroll({
  children,
  className,
  exitAt = 0.7,
  leadPx = 80,
  intensity = 1,
}: RecedeOnScrollProps) {
  const outerRef = useRef<HTMLDivElement | null>(null);
  const startRef = useRef(Number.POSITIVE_INFINITY);
  const spanRef = useRef(1);
  const reduce = useReducedMotion();
  const { scrollY } = useScroll();

  const measure = useCallback(() => {
    const el = outerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const top = rect.top + window.scrollY;
    const start = Math.max(0, top - leadPx);
    startRef.current = start;
    spanRef.current = Math.max(1, top + rect.height * exitAt - start);
  }, [exitAt, leadPx]);

  // Re-measure after every render (the bio and lazy lists can grow) and on
  // resize. Scrolling never triggers a React render, so this is not hot.
  useLayoutEffect(() => {
    measure();
  });
  useEffect(() => {
    const ro = new ResizeObserver(() => measure());
    if (outerRef.current) ro.observe(outerRef.current);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure]);

  const pull = (y: number) => {
    const p = Math.min(1, Math.max(0, (y - startRef.current) / spanRef.current));
    // Smoothstep: barely moves at first, then accelerates — reads as suction.
    return p * p * (3 - 2 * p);
  };

  const scale = useTransform(scrollY, (y) => 1 - 0.24 * intensity * pull(y));
  const lift = useTransform(scrollY, (y) => -44 * intensity * pull(y));
  const fade = useTransform(scrollY, (y) => 1 - 0.6 * intensity * pull(y));

  return (
    <div ref={outerRef} className={className}>
      <motion.div
        style={reduce ? undefined : { scale, y: lift, opacity: fade, transformOrigin: "50% 0%" }}
      >
        {children}
      </motion.div>
    </div>
  );
}
