import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { MotionConfig } from "motion/react";
import { InkBar } from "./ink-bar";

function renderBar() {
  return render(
    <MotionConfig reducedMotion="always">
      <InkBar>
        <button type="button" data-testid="btn-a" data-ink>
          a
        </button>
        <span data-testid="gap">gap</span>
        <button type="button" data-testid="btn-b" data-ink>
          b
        </button>
      </InkBar>
    </MotionConfig>,
  );
}

function blobOpacity(container: HTMLElement): string {
  const blob = container.querySelector('div > span[aria-hidden="true"]');
  return (blob as HTMLElement | null)?.style.opacity ?? "";
}

describe("InkBar", () => {
  it("lights the blob under the hovered button", async () => {
    const { container } = renderBar();
    fireEvent.mouseOver(screen.getByTestId("btn-a"));
    await waitFor(() => expect(blobOpacity(container)).toBe("1"));
  });

  it("drops the blob when the pointer rests on a gap", async () => {
    const { container } = renderBar();
    fireEvent.mouseOver(screen.getByTestId("btn-a"));
    await waitFor(() => expect(blobOpacity(container)).toBe("1"));

    fireEvent.mouseOver(screen.getByTestId("gap"));
    // Still lit right away (debounced) …
    expect(blobOpacity(container)).toBe("1");
    // … but gone after the rest delay.
    await waitFor(() => expect(blobOpacity(container)).toBe("0"), { timeout: 2000 });
  });

  it("keeps gliding when crossing a gap fast", async () => {
    const { container } = renderBar();
    fireEvent.mouseOver(screen.getByTestId("btn-a"));
    await waitFor(() => expect(blobOpacity(container)).toBe("1"));

    fireEvent.mouseOver(screen.getByTestId("gap"));
    fireEvent.mouseOver(screen.getByTestId("btn-b"));
    await new Promise((r) => setTimeout(r, 250));
    expect(blobOpacity(container)).toBe("1");
  });

  it("hides the blob at once when the pointer leaves the row", async () => {
    const { container } = renderBar();
    fireEvent.mouseOver(screen.getByTestId("btn-a"));
    await waitFor(() => expect(blobOpacity(container)).toBe("1"));

    fireEvent.mouseLeave(container.firstElementChild as Element);
    await waitFor(() => expect(blobOpacity(container)).toBe("0"));
  });
});
