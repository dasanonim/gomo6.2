import { memo, useCallback, useRef } from "react";
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

/** A press longer than this, or a drag past this slop, is not a tap. */
const TAP_SLOP_PX = 10;

export const ReactionChips = memo(function ReactionChips({ chips, viewerId, onToggle }: Props) {
  // The tap is handled on `pointerup`, not on `click`: the row around the chips
  // owns a swipe gesture, and a click on a chip can be swallowed on its way to
  // React's root (a capture listener up the tree) — pointer events always reach
  // the button. The click handler stays for keyboard/assistive activation, with
  // this guard so a pointer tap is never applied twice.
  const pressRef = useRef<{ emoji: string; x: number; y: number } | null>(null);
  const handledRef = useRef<{ emoji: string; at: number } | null>(null);

  const apply = useCallback(
    (emoji: string) => {
      hapticTick(6);
      onToggle(emoji);
    },
    [onToggle],
  );

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLButtonElement>, emoji: string) => {
    event.stopPropagation();
    pressRef.current = { emoji, x: event.clientX, y: event.clientY };
  }, []);

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>, emoji: string) => {
      event.stopPropagation();
      const press = pressRef.current;
      pressRef.current = null;
      if (!press || press.emoji !== emoji) return;
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > TAP_SLOP_PX) return;
      handledRef.current = { emoji, at: Date.now() };
      apply(emoji);
    },
    [apply],
  );

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>, emoji: string) => {
      event.stopPropagation();
      const handled = handledRef.current;
      if (handled && handled.emoji === emoji && Date.now() - handled.at < 600) return;
      apply(emoji);
    },
    [apply],
  );

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
          onPointerDown={(event) => handlePointerDown(event, chip.emoji)}
          onPointerUp={(event) => handlePointerUp(event, chip.emoji)}
          onPointerCancel={() => {
            pressRef.current = null;
          }}
          onClick={(event) => handleClick(event, chip.emoji)}
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
