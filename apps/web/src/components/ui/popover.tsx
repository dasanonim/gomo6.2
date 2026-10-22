import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";

import { cn } from "@/lib/utils";
import { OverlayMotion } from "@/components/ui/overlay-motion";

const Popover = PopoverPrimitive.Root;

const PopoverTrigger = PopoverPrimitive.Trigger;

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, children, align = "center", sideOffset = 4, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content asChild align={align} sideOffset={sideOffset} {...props}>
      <OverlayMotion
        ref={ref}
        className={cn(
          "gomo-overlay-surface z-50 w-72 rounded-md border surface-panel p-4 text-popover-foreground shadow-md outline-none origin-[var(--radix-popover-content-transform-origin)]",
          className,
        )}
      >
        {children}
      </OverlayMotion>
    </PopoverPrimitive.Content>
  </PopoverPrimitive.Portal>
));
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

/** Like PopoverContent but with no default padding/width — panels style
    themselves. Entry/exit physics is shared with every other overlay. */
const PopoverPanel = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, children, align = "center", sideOffset = 6, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content asChild align={align} sideOffset={sideOffset} {...props}>
      <OverlayMotion
        ref={ref}
        className={cn(
          "gomo-overlay-surface z-50 overflow-hidden rounded-md border surface-panel text-popover-foreground shadow-md outline-none origin-[var(--radix-popover-content-transform-origin)]",
          className,
        )}
      >
        {children}
      </OverlayMotion>
    </PopoverPrimitive.Content>
  </PopoverPrimitive.Portal>
));
PopoverPanel.displayName = "PopoverPanel";

export { Popover, PopoverTrigger, PopoverContent, PopoverPanel };
