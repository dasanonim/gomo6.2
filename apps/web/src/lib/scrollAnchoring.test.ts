import { describe, expect, it, afterEach } from "vitest";
import {
  detectScrollAnchoring,
  hasScrollAnchoring,
  initScrollAnchoringFlag,
} from "./scrollAnchoring";

afterEach(() => {
  document.documentElement.classList.remove("has-scroll-anchoring");
  document.body.innerHTML = "";
});

describe("scrollAnchoring", () => {
  it("reports no anchoring when the layout engine cannot anchor (jsdom)", () => {
    // jsdom has no layout: the probe cannot observe a scroll adjustment, and
    // "unknown" must resolve to the conservative branch (rows stay laid out).
    expect(detectScrollAnchoring()).toBe(false);
  });

  it("never throws and never leaves the probe element in the DOM", () => {
    expect(() => detectScrollAnchoring()).not.toThrow();
    expect(document.body.querySelectorAll("div[style*='-9999px']")).toHaveLength(0);
  });

  it("publishes the capability as a class on <html>", () => {
    const supported = initScrollAnchoringFlag();

    expect(supported).toBe(false); // jsdom
    expect(hasScrollAnchoring()).toBe(false);

    // And it is idempotent, in both directions.
    document.documentElement.classList.add("has-scroll-anchoring");
    expect(hasScrollAnchoring()).toBe(true);
    initScrollAnchoringFlag();
    expect(hasScrollAnchoring()).toBe(false);
  });
});
