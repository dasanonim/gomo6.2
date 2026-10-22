import { describe, expect, it } from "vitest";
import { getChatUnderlayFrame } from "./chatDepth";

describe("getChatUnderlayFrame", () => {
  it("leaves the conversation list settled when the chat is closed", () => {
    expect(getChatUnderlayFrame(400, 400, true)).toEqual({ x: 0, dim: 0 });
  });

  it("recedes and dims the list as the chat opens", () => {
    expect(getChatUnderlayFrame(0, 400, true)).toEqual({ x: -72, dim: 1 });
    expect(getChatUnderlayFrame(200, 400, true)).toEqual({ x: -36, dim: 0.5 });
  });

  it("clamps overshoot and ignores the depth effect on desktop", () => {
    expect(getChatUnderlayFrame(-10, 400, true)).toEqual({ x: -72, dim: 1 });
    expect(getChatUnderlayFrame(500, 400, true)).toEqual({ x: 0, dim: 0 });
    expect(getChatUnderlayFrame(0, 400, false)).toEqual({ x: 0, dim: 0 });
    expect(getChatUnderlayFrame(0, 0, true)).toEqual({ x: 0, dim: 0 });
  });
});
