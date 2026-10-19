import { memo } from "react";
import { hapticTick } from "@/lib/haptics";
import type { ReactionSummary } from "./types";
import { describeChip, describeReactors } from "./reactions";

// ─── Reaction chips under a message ────────────────────────────────────────
// One chip per emoji, sized by the count (two digits at most: a group chat
// never shows "123" on a messenger chip). The row is a sibling of the bubble in
// the row's column, so it sits on the chat background like Telegram's, and it
// lives inside `.bubble-row-inner` — which means a swipe-to-reply carries the
// chips along with the message.
//
// The container stops pointer/touch events: a tap on a chip must not count as a
// tap on the message (double-tap → reaction, long-press → menu would otherwise
// fire from the chips themselves).

interface Props {
  chips: ReactionSummary[];
  viewerId: string;
  onToggle: (emoji: string) => void;
}

export const ReactionChips = memo(function ReactionChips({ chips, viewerId, onToggle }: Props) {
  if (chips.length === 0) return null;

  return (
    <div
      className="msg-reactions"
      role="group"
      aria-label="Реакции"
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onPointerCancel={(event) => event.stopPropagation()}
      onTouchStart={(event) => event.stopPropagation()}
      onTouchMove={(event) => event.stopPropagation()}
      onTouchEnd={(event) => event.stopPropagation()}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {chips.map((chip) => (
        <button
          key={chip.emoji}
          type="button"
          className={`msg-reaction-chip${chip.mine ? " is-mine" : ""}`}
          onClick={(event) => {
            event.stopPropagation();
            hapticTick(6);
            onToggle(chip.emoji);
          }}
          aria-pressed={chip.mine}
          aria-label={describeChip(chip, viewerId)}
          title={describeReactors(chip, viewerId)}
        >
          <span className="msg-reaction-emoji" aria-hidden="true">{chip.emoji}</span>
          {chip.count > 1 && <span className="msg-reaction-count">{chip.count}</span>}
        </button>
      ))}
    </div>
  );
});
