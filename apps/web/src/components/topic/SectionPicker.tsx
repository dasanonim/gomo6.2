// Раздел picker for creating a topic. One list in the sidebar's row language:
// compact rows with a muted icon, the current placement highlighted, sections
// with подразделы expanding inline. Tapping a leaf (or «Весь раздел») selects
// immediately — there is no second screen.

import { useEffect, useState } from "react";
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
      <DialogContent className="max-w-md p-0 overflow-hidden z-[80]" overlayClassName="z-[75]">
        <DialogHeader className="px-4 pt-4 pb-2">
          <DialogTitle>Выберите раздел</DialogTitle>
          <DialogDescription>Тема попадёт в раздел — подраздел выбирать необязательно.</DialogDescription>
        </DialogHeader>

        <div className="mx-4 mb-4 max-h-[60vh] overflow-y-auto rounded-lg border border-border/70 p-1.5">
          {loading && sections.length === 0 ? (
            <div className="flex justify-center py-10">
              <PentagramLoader size="sm" />
            </div>
          ) : sections.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Разделы пока не настроены</p>
          ) : (
            sections.map((section) => {
              const isCurrent = section.id === currentSectionId && !currentSubsectionId;
              const expanded = expandedId === section.id;
              return (
                <div key={section.id}>
                  <button
                    type="button"
                    onClick={() => toggleSection(section)}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors ${
                      isCurrent
                        ? "bg-primary/10 font-semibold text-primary"
                        : "text-foreground/80 hover:bg-muted/60 hover:text-foreground"
                    }`}
                  >
                    <SectionIcon name={section.icon} className="h-4 w-4 shrink-0 text-muted-foreground/40" />
                    <span className="min-w-0 flex-1 truncate text-left">
                      {section.name}
                      {section.is_nsfw && (
                        <span className="ml-1.5 rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] font-semibold text-destructive">
                          18+
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
                  </button>
                  {expanded && section.subsections.length > 0 && (
                    <div className="mb-1 ml-[22px] border-l border-border/60 pl-2">
                      {section.subsections.map((sub) => {
                        const subCurrent = section.id === currentSectionId && sub.id === currentSubsectionId;
                        return (
                          <button
                            key={sub.id}
                            type="button"
                            onClick={() => choose(section, sub)}
                            className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] transition-colors ${
                              subCurrent
                                ? "bg-primary/10 font-semibold text-primary"
                                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                            }`}
                          >
                            <span className="min-w-0 flex-1 truncate text-left">{sub.name}</span>
                            {subCurrent && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
                          </button>
                        );
                      })}
                      <button
                        type="button"
                        onClick={() => choose(section, null)}
                        className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] transition-colors ${
                          isCurrent
                            ? "bg-primary/10 font-semibold text-primary"
                            : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                        }`}
                      >
                        <span className="min-w-0 flex-1 truncate text-left">Весь раздел</span>
                        {isCurrent && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
                      </button>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};
