// Раздел picker for creating a topic — a floating glass panel in the
// Telegram motion language (docs/wiki/MOTION_DESIGN.md):
//
// * The shell enters as one physical object (OverlayMotion: scale + defocus
//   from the trigger point, geometry on SPRING.standard, light on
//   EASE_OUT_EXPO) and the theme's own `surface-panel` glass stays in charge
//   of translucency — the float comes from width, radius and elevation.
// * Rows arrive with the app-wide whisper entrance (a breath of lift, ~25ms
//   stagger, self-driven per row) and compress on press (pressFeedback).
// * Sections with подразделы expand inline like the sidebar; tapping a leaf
//   (or «Весь раздел») selects immediately — there is no second screen.

import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Check, ChevronRight } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PentagramLoader } from "@/components/PentagramLoader";
import { SectionIcon } from "@/components/topic/sectionIcons";
import { pressFeedback, whisperRowVariants } from "@/lib/motion";
import type { SectionWithSubsections, ThreadSection, ThreadSubsection } from "@/hooks/useThreadSections";

interface SectionPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sections: SectionWithSubsections[];
  loading: boolean;
  /** Currently chosen placement, if the user is changing it. */
  currentSectionId?: string;
  currentSubsectionId?: string;
  onSelect: (section: ThreadSection, subsection: ThreadSubsection | null) => void;
}

export const SectionPicker = ({
  open,
  onOpenChange,
  sections,
  loading,
  currentSectionId,
  currentSubsectionId,
  onSelect,
}: SectionPickerProps) => {
  const reduceMotion = useReducedMotion();
  const [expandedId, setExpandedId] = useState<string | null>(currentSectionId ?? null);

  // Reopen at the current placement when changing, otherwise collapsed.
  useEffect(() => {
    if (open) setExpandedId(currentSectionId ?? null);
  }, [open, currentSectionId]);

  const choose = (section: ThreadSection, subsection: ThreadSubsection | null) => {
    onSelect(section, subsection);
    onOpenChange(false);
  };

  const toggleSection = (section: SectionWithSubsections) => {
    // A раздел without подразделы is a leaf — it selects straight away.
    if (section.subsections.length === 0) {
      choose(section, null);
      return;
    }
    setExpandedId((prev) => (prev === section.id ? null : section.id));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-sm w-[calc(100%-2rem)] p-0 overflow-hidden rounded-2xl sm:rounded-2xl shadow-2xl z-[80]"
        overlayClassName="z-[75]"
      >
        <DialogHeader className="px-5 pt-5 pb-1 text-left">
          <DialogTitle className="text-base">Выберите раздел</DialogTitle>
          <DialogDescription>Тема попадёт в раздел — подраздел выбирать необязательно.</DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] overflow-y-auto px-3 pb-4 pt-2">
          {loading && sections.length === 0 ? (
            <div className="flex justify-center py-10">
              <PentagramLoader size="sm" />
            </div>
          ) : sections.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Разделы пока не настроены</p>
          ) : (
            <div className="space-y-1">
              {sections.map((section, index) => {
                const isCurrent = section.id === currentSectionId && !currentSubsectionId;
                const expanded = expandedId === section.id;
                return (
                  <div key={section.id}>
                    <motion.button
                      type="button"
                      initial="hidden"
                      animate="show"
                      variants={whisperRowVariants(index)}
                      {...pressFeedback(reduceMotion)}
                      onClick={() => toggleSection(section)}
                      className={`flex w-full items-center gap-3 rounded-2xl border px-3.5 py-3 text-left transition-colors ${
                        isCurrent
                          ? "border-primary/30 bg-primary/10 font-semibold text-primary"
                          : "border-border/50 bg-foreground/[0.02] hover:bg-foreground/[0.05]"
                      }`}
                    >
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary ring-1 ring-inset ring-primary/15">
                        <SectionIcon name={section.icon} className="h-4 w-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2 text-sm font-semibold">
                          <span className="truncate">{section.name}</span>
                          {section.is_nsfw && (
                            <span className="shrink-0 rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] font-semibold text-destructive">
                              18+
                            </span>
                          )}
                        </span>
                        {section.description && (
                          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                            {section.description}
                          </span>
                        )}
                      </span>
                      {isCurrent && <Check className="h-4 w-4 shrink-0 text-primary" />}
                      {section.subsections.length > 0 && (
                        <ChevronRight
                          className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 ${
                            expanded ? "rotate-90" : ""
                          }`}
                        />
                      )}
                    </motion.button>
                    {expanded && section.subsections.length > 0 && (
                      <div className="ml-[26px] space-y-1 border-l border-border/60 py-1 pl-2">
                        {section.subsections.map((sub, subIndex) => {
                          const subCurrent = section.id === currentSectionId && sub.id === currentSubsectionId;
                          return (
                            <motion.button
                              key={sub.id}
                              type="button"
                              initial="hidden"
                              animate="show"
                              variants={whisperRowVariants(subIndex)}
                              {...pressFeedback(reduceMotion)}
                              onClick={() => choose(section, sub)}
                              className={`flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-left text-[13px] transition-colors ${
                                subCurrent
                                  ? "border-primary/30 bg-primary/10 font-semibold text-primary"
                                  : "border-border/40 bg-foreground/[0.02] text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground"
                              }`}
                            >
                              <span className="min-w-0 flex-1 truncate">{sub.name}</span>
                              {subCurrent && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
                            </motion.button>
                          );
                        })}
                        <motion.button
                          type="button"
                          initial="hidden"
                          animate="show"
                          variants={whisperRowVariants(section.subsections.length)}
                          {...pressFeedback(reduceMotion)}
                          onClick={() => choose(section, null)}
                          className={`flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-left text-[13px] transition-colors ${
                            isCurrent
                              ? "border-primary/30 bg-primary/10 font-semibold text-primary"
                              : "border-border/40 bg-foreground/[0.02] text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground"
                          }`}
                        >
                          <span className="min-w-0 flex-1 truncate">Весь раздел</span>
                          {isCurrent && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
                        </motion.button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};
