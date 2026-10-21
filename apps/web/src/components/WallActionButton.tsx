import { useEffect, useRef, type ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { pressFeedback, springFor } from "@/lib/motion";

export interface ActionButtonProps {
  icon: ReactNode;
  label: string;
  count?: number | null;
  showLabel?: boolean;
  /**
   * Compact feed style: icon + count only, in a rounded-full pill that tints on
   * hover and on `active`. The label is still used as the accessible name.
   * Zero counts are omitted so the row stays clean.
   */
  minimal?: boolean;
  active?: boolean;
  disabled?: boolean;
  loading?: boolean;
  /** Accessible name for icon-only buttons (aria fallback). */
  title?: string;
  onClick: () => void;
}

export const ActionButton = ({
  icon,
  label,
  count = null,
  showLabel = true,
  minimal = false,
  active = false,
  disabled = false,
  loading = false,
  title,
  onClick,
}: ActionButtonProps) => {
  // Icon-only variants (minimal / showLabel=false) must keep a spoken name.
  const accessibleName = title ?? label;
  const reduceMotion = useReducedMotion();

  // The counter pops only when it actually changes — never on first paint (the
  // card itself is already arriving in a cascade).
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
  }, []);

  const countPop =
    mountedRef.current && !reduceMotion
      ? {
          initial: { scale: 1.35, opacity: 0.4 },
          animate: { scale: 1, opacity: 1 },
          transition: springFor("bouncy", reduceMotion),
        }
      : { initial: false as const };

  // The icon reacts to the state flipping ON: a squeezed-then-released glyph.
  // Toggling off simply returns to rest, which should not celebrate.
  const iconPop = {
    initial: active && !reduceMotion ? { scale: 0.55 } : (false as const),
    animate: { scale: 1 },
    transition: springFor("bouncy", reduceMotion),
  };

  return (
    <motion.div
      className="inline-flex"
      {...pressFeedback(reduceMotion, 0.9)}
      transition={springFor("snappy", reduceMotion)}
    >
      {minimal ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          title={accessibleName}
          aria-label={accessibleName}
          onClick={onClick}
          disabled={disabled || loading}
          className={`group h-8 gap-1 rounded-full px-2 text-xs font-medium transition-colors ${
            active
              ? "bg-primary/12 text-primary hover:bg-primary/18 hover:text-primary"
              : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          }`}
        >
          <motion.span
            key={active ? "active" : "rest"}
            {...iconPop}
            className="grid place-items-center transition-transform duration-200 group-hover:-translate-y-px group-hover:scale-110"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
          </motion.span>
          {typeof count === "number" && count > 0 && (
            <motion.span key={`count-${count}`} {...countPop} className="tabular-nums">
              {count}
            </motion.span>
          )}
        </Button>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          title={accessibleName}
          aria-label={accessibleName}
          onClick={onClick}
          disabled={disabled || loading}
          className={`h-8 gap-1.5 px-1.5 text-xs transition-colors sm:h-9 sm:px-2 sm:text-sm ${
            active ? "text-primary hover:text-primary" : "text-muted-foreground"
          }`}
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
          {showLabel && <span className="hidden sm:inline">{label}</span>}
          {typeof count === "number" && (
            <motion.span key={`count-${count}`} {...countPop} className="text-foreground/80">
              {count}
            </motion.span>
          )}
        </Button>
      )}
    </motion.div>
  );
};
