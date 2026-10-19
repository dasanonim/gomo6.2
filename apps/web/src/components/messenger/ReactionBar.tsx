import { useCallback, useEffect, useRef, useState } from "react";
import { hapticTick } from "@/lib/haptics";
import type { ReactionSummary } from "./types";
import { QUICK_REACTIONS, REACTION_SET, describeChip } from "./reactions";

// ─── The reaction bar of the long-press panel ──────────────────────────────
// Telegram's model: the bar floats over the message's top edge while the action
// panel is open. The quick set is one row (the first entry is what a double-tap
// applies); "+" unfolds the rest of the set in place, so the whole gesture stays
// in the same overlay — no second sheet, no navigation, no lost position.
//
// The bar is real UI inside the floated layer (the message itself is a
// non-interactive clone there), which is why it can be pressed while the chat
// behind it is blurred.

interface Props {
  chips: ReactionSummary[];
  viewerId: string;
  onPick: (emoji: string) => void;
}

export function ReactionBar({ chips, viewerId, onPick }: Props) {
  const [expanded, setExpanded] = useState(false);
  const barRef = useRef<HTMLDivElement | null>(null);

  // A press inside the bar must never reach the overlay's outside-tap handler,
  // and Escape folds the grid back before it closes the panel.
  const stop = useCallback((event: React.SyntheticEvent) => event.stopPropagation(), []);

  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setExpanded(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [expanded]);

  const mine = new Set(chips.filter((chip) => chip.mine).map((chip) => chip.emoji));

  return (
    <div
      ref={barRef}
      className={`msg-reaction-bar${expanded ? " is-expanded" : ""}`}
      role="group"
      aria-label="Быстрые реакции"
      onPointerDown={stop}
      onPointerUp={stop}
      onTouchStart={stop}
      onTouchEnd={stop}
      onContextMenu={(event) => event.preventDefault()}
    >
      {expanded ? (
        <div className="msg-reaction-grid">
          {REACTION_SET.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className={`msg-reaction-pick${mine.has(emoji) ? " is-mine" : ""}`}
              onClick={() => {
                hapticTick(6);
                onPick(emoji);
              }}
              aria-pressed={mine.has(emoji)}
              aria-label={emoji}
            >
              {emoji}
            </button>
          ))}
        </div>
      ) : (
        <div className="msg-reaction-row">
          {QUICK_REACTIONS.map((emoji) => {
            const chip = chips.find((entry) => entry.emoji === emoji);
            return (
              <button
                key={emoji}
                type="button"
                className={`msg-reaction-pick${mine.has(emoji) ? " is-mine" : ""}`}
                onClick={() => {
                  hapticTick(6);
                  onPick(emoji);
                }}
                aria-pressed={mine.has(emoji)}
                aria-label={emoji}
                title={chip ? describeChip(chip, viewerId) : undefined}
              >
                {emoji}
              </button>
            );
          })}
          <button
            type="button"
            className="msg-reaction-pick msg-reaction-more"
            onClick={() => {
              hapticTick(4);
              setExpanded(true);
            }}
            aria-label="Ещё реакции"
            title="Ещё реакции"
          >
            +
          </button>
        </div>
      )}
    </div>
  );
}
