import { describe, it, expect } from "vitest";
import {
  ANCHOR_REALIGN_EPSILON,
  AT_BOTTOM_SLACK,
  BOTTOM_GAP_HEIGHT,
  HISTORY_HEADER_HEIGHT,
  anchorScrollTop,
  bottomTarget,
  captureAnchor,
  isAtBottom,
  virtualContentHeight,
  type VirtualRow,
} from "./scrollEngine";

const rows = (count: number, size = 72): VirtualRow[] =>
  Array.from({ length: count }, (_, index) => ({
    index,
    start: index * size,
    end: (index + 1) * size,
  }));

const idAt = (index: number) => `m${index}`;

describe("constants", () => {
  it("match the css layout values they mirror", () => {
    expect(HISTORY_HEADER_HEIGHT).toBe(34);
    expect(BOTTOM_GAP_HEIGHT).toBe(12);
    expect(AT_BOTTOM_SLACK).toBe(12);
    expect(ANCHOR_REALIGN_EPSILON).toBe(2);
  });
});

describe("virtualContentHeight", () => {
  it("is header + virtual total + footer gap", () => {
    expect(virtualContentHeight(720)).toBe(34 + 720 + 12);
  });
});

describe("bottomTarget", () => {
  it("clamps to the real bottom", () => {
    // 34 + 10*72 + 12 = 766; viewport 400 → 366.
    expect(bottomTarget(766, 400, 720)).toBe(366);
  });

  it("uses the virtualizer height when the DOM is not caught up yet", () => {
    // DOM says 766, the virtualizer already knows 792 → bottom is 426.
    expect(bottomTarget(766, 400, 792)).toBe(34 + 792 + 12 - 400);
  });

  it("uses the DOM height when it is larger (an image outgrew its box)", () => {
    expect(bottomTarget(900, 400, 720)).toBe(500);
  });

  it("returns 0 for an un-laid-out (zero-height) viewport", () => {
    expect(bottomTarget(766, 0, 720)).toBe(0);
    expect(bottomTarget(0, 0, 0)).toBe(0);
  });

  it("never returns a negative target when the content is shorter than the viewport", () => {
    expect(bottomTarget(100, 400, 100)).toBe(0);
  });
});

describe("isAtBottom", () => {
  it("is true at the exact bottom", () => {
    expect(isAtBottom(766, 366, 400)).toBe(true);
  });

  it("is true within the slack", () => {
    expect(isAtBottom(766, 366 - AT_BOTTOM_SLACK, 400)).toBe(true);
  });

  it("is false beyond the slack", () => {
    expect(isAtBottom(766, 366 - AT_BOTTOM_SLACK - 1, 400)).toBe(false);
  });
});

describe("captureAnchor", () => {
  it("captures the top-most visible message and its offset", () => {
    // Row 0 spans 34..106 (header + 0..72) and still reaches the viewport top
    // at 100, so it is the top-most visible row; offset = 100 - 34.
    const anchor = captureAnchor(rows(5), 100, idAt);
    expect(anchor).toEqual({ messageId: "m0", offset: 100 - HISTORY_HEADER_HEIGHT });
  });

  it("moves to the next row once the previous one is fully above the top", () => {
    const anchor = captureAnchor(rows(5), 150, idAt);
    // Row 1 spans 106..178, still reaching 150 → it is the top-most visible.
    expect(anchor).toEqual({ messageId: "m1", offset: 150 - (HISTORY_HEADER_HEIGHT + 72) });
  });

  it("returns null when no row reaches the viewport top", () => {
    expect(captureAnchor([], 100, idAt)).toBeNull();
  });

  it("skips rows without a resolvable message id", () => {
    const anchor = captureAnchor(rows(3), 0, (index) => (index === 0 ? undefined : `m${index}`));
    expect(anchor?.messageId).toBe("m1");
  });
});

describe("anchorScrollTop", () => {
  it("restores a row to its captured offset", () => {
    expect(anchorScrollTop(72, 20)).toBe(34 + 72 + 20);
  });
});
