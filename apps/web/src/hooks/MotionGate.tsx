import type { ReactNode } from "react";
import { MotionConfig } from "motion/react";

import { useMotionOff } from "@/hooks/useTransitionStyle";

/**
 * MotionConfig around the whole app with one live `reducedMotion` decision:
 * the OS's reduce stops transforms but keeps opacity; the user's own
 * «Без анимации» in Settings stops EVERYTHING.
 */
export const MotionGate = ({ children }: { children: ReactNode }) => {
  const motionOff = useMotionOff();
  return <MotionConfig reducedMotion={motionOff ? "always" : "user"}>{children}</MotionConfig>;
};
