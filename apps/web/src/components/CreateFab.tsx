import { motion, useReducedMotion } from "motion/react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { hoverLift, pressFeedback, springFor } from "@/lib/motion";

interface CreateFabProps {
  /** Click handler — navigate to the composer or toggle it open. */
  onClick: () => void;
  /** Accessible name + tooltip. */
  label: string;
  /** When true the plus rotates into a × (composer is open). */
  active?: boolean;
  /**
   * Distance from the viewport's right edge. Defaults to the content-column
   * anchor used on the profile page; `bottom` always comes from
   * MobileBottomNav.css so the button never slides under the bottom nav.
   */
  right?: string;
  className?: string;
}

/**
 * Floating «+» action — one place for the look and animation of every
 * create-button in the app (profile wall, feed, …). Behaviour (what the plus
 * does) stays at the call site via `onClick`.
 */
export const CreateFab = ({
  onClick,
  label,
  active = false,
  right = "max(1rem, calc(50vw - 388px))",
  className = "",
}: CreateFabProps) => {
  const prefersReducedMotion = useReducedMotion();

  return (
    <motion.div
      className={`create-fab profile-wall-fab fixed z-40 ${className}`.trim()}
      style={{ right }}
      {...hoverLift(prefersReducedMotion, 1.04)}
      {...pressFeedback(prefersReducedMotion, 0.9)}
      transition={springFor("snappy", prefersReducedMotion)}
    >
      <Button
        variant="default"
        size="icon"
        onClick={onClick}
        className="h-12 w-12 rounded-2xl shadow-lg"
        title={label}
        aria-label={label}
      >
        <motion.span
          className="inline-flex"
          animate={{ rotate: active ? 45 : 0 }}
          transition={springFor("snappy", prefersReducedMotion)}
        >
          <Plus className="h-5 w-5" />
        </motion.span>
      </Button>
    </motion.div>
  );
};
