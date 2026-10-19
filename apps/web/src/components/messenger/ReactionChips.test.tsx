import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ReactionChips } from "./ReactionChips";
import { ReactionBar } from "./ReactionBar";
import { QUICK_REACTIONS, REACTION_SET } from "./reactions";
import type { ReactionSummary } from "./types";

const { mockHaptics } = vi.hoisted(() => ({
  mockHaptics: { tick: vi.fn(), success: vi.fn() },
}));

vi.mock("@/lib/haptics", () => ({
  hapticTick: mockHaptics.tick,
  hapticSuccess: mockHaptics.success,
}));

beforeEach(() => {
  mockHaptics.tick.mockClear();
  localStorage.clear();
});

const chips: ReactionSummary[] = [
  { emoji: "🔥", count: 3, mine: true, users: [{ id: "me", username: "me" }, { id: "u2", username: "bob" }, { id: "u3", username: "carol" }] },
  { emoji: "😂", count: 1, mine: false, users: [{ id: "u2", username: "bob" }] },
];

describe("ReactionChips", () => {
  it("renders one chip per emoji with its count", () => {
    render(<ReactionChips chips={chips} viewerId="me" onToggle={vi.fn()} />);

    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(2);
    expect(buttons[0].textContent).toBe("🔥3");
    // A single reaction shows no counter (Telegram's rule).
    expect(buttons[1].textContent).toBe("😂");
  });

  it("marks the reader's chip and exposes it to assistive tech", () => {
    render(<ReactionChips chips={chips} viewerId="me" onToggle={vi.fn()} />);

    const mine = screen.getByRole("button", { name: /🔥 3: Вы, bob, carol \(ваша реакция\)/ });
    expect(mine.className).toContain("is-mine");
    expect(mine.getAttribute("aria-pressed")).toBe("true");
  });

  it("toggles the tapped emoji with a tactile tick", () => {
    const onToggle = vi.fn();
    render(<ReactionChips chips={chips} viewerId="me" onToggle={onToggle} />);

    fireEvent.click(screen.getByRole("button", { name: /😂/ }));

    expect(onToggle).toHaveBeenCalledWith("😂");
    expect(mockHaptics.tick).toHaveBeenCalledTimes(1);
  });

  it("renders nothing without reactions", () => {
    const { container } = render(<ReactionChips chips={[]} viewerId="me" onToggle={vi.fn()} />);

    expect(container.querySelector(".msg-reactions")).toBeNull();
  });
});

describe("ReactionBar", () => {
  it("shows the quick set and applies the picked emoji", () => {
    const onPick = vi.fn();
    render(<ReactionBar chips={[]} viewerId="me" onPick={onPick} />);

    expect(screen.getAllByRole("button")).toHaveLength(QUICK_REACTIONS.length + 1);
    fireEvent.click(screen.getByRole("button", { name: "🔥" }));

    expect(onPick).toHaveBeenCalledWith("🔥");
    expect(mockHaptics.tick).toHaveBeenCalledTimes(1);
  });

  it("marks the reactions the reader already chose", () => {
    render(<ReactionBar chips={[{ emoji: "❤️", count: 1, mine: true, users: [{ id: "me", username: "me" }] }]} viewerId="me" onPick={vi.fn()} />);

    expect(screen.getByRole("button", { name: "❤️" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "🔥" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("unfolds the full set behind «+»", () => {
    const onPick = vi.fn();
    render(<ReactionBar chips={[]} viewerId="me" onPick={onPick} />);

    fireEvent.click(screen.getByRole("button", { name: "Ещё реакции" }));

    expect(screen.getAllByRole("button")).toHaveLength(REACTION_SET.length);
    fireEvent.click(screen.getByRole("button", { name: "🫡" }));
    expect(onPick).toHaveBeenCalledWith("🫡");
  });
});
