import * as React from "react";
import { motion, useReducedMotion } from "motion/react";

import { morphTransition } from "@/lib/motion";

/**
 * The one entrance animation for every Radix overlay surface (dialog, alert
 * dialog, dropdown, popover).
 *
 * It must be a child of the primitive via `asChild`: Radix keeps its popper
 * positioning on a wrapper element, so animating `transform` on the content
 * itself is safe — but mounting the motion element *inside* the content would
 * add a layout box that panels do not expect. Used as the content itself, the
 * surface enters as one object: opacity + scale 0.88 + a short defocus, with
 * the transform origin supplied by the Radix CSS variable on the className.
 *
 * Exit is CSS (`gomo-overlay-surface[data-state="closed"]` in index.css):
 * Radix unmounts on `animationend`, so a script-driven exit would need
 * `forceMount` + AnimatePresence at every call site, which this app does not
 * have. The physical part users feel — the opening — stays a real spring.
 */
export const OverlayMotion = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof motion.div>
>(({ children, ...props }, ref) => {
  const reduce = useReducedMotion();
  return (
    <motion.div
      ref={ref}
      initial={reduce ? false : { opacity: 0, scale: 0.88, filter: "blur(6px)" }}
      animate={reduce ? undefined : { opacity: 1, scale: 1, filter: "blur(0px)" }}
      transition={morphTransition(reduce)}
      {...props}
    >
      {children}
    </motion.div>
  );
});
OverlayMotion.displayName = "OverlayMotion";
