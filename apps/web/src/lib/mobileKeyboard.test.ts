import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeKeyboardMetrics,
  initMobileKeyboard,
  isEditableElement,
  isStaleUpwardJump,
  resolveSheetBottomAction,
  subscribeMobileKeyboard,
  getMobileKeyboardState,
} from "./mobileKeyboard";

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe("computeKeyboardMetrics", () => {
  it("passes values through verbatim with no visualViewport support", () => {
    const r = computeKeyboardMetrics({ innerHeight: 800, visualViewportHeight: null, isTouch: true });
    expect(r).toEqual({ isOpen: false, keyboardInset: 0, viewportHeight: 800 });
  });

  it("treats a delta below the threshold as URL-bar noise", () => {
    const r = computeKeyboardMetrics({ innerHeight: 800, visualViewportHeight: 780, isTouch: true });
    expect(r.isOpen).toBe(false);
    expect(r.keyboardInset).toBe(0);
    expect(r.viewportHeight).toBe(780);
  });

  it("reports the keyboard and subtracts the iOS URL-bar offsetTop", () => {
    const r = computeKeyboardMetrics({
      innerHeight: 800,
      visualViewportHeight: 450,
      visualViewportOffsetTop: 75,
      isTouch: true,
    });
    expect(r.isOpen).toBe(true);
    expect(r.keyboardInset).toBe(275); // (800 - 450) - 75
    expect(r.viewportHeight).toBe(450);
  });

  it("never opens on desktop", () => {
    const r = computeKeyboardMetrics({ innerHeight: 800, visualViewportHeight: 450, isTouch: false });
    expect(r).toEqual({ isOpen: false, keyboardInset: 0, viewportHeight: 450 });
  });
});

describe("resolveSheetBottomAction", () => {
  it("tracks live geometry while focus is in the sheet", () => {
    expect(resolveSheetBottomAction({ viewportOpen: true, closing: false, focusedInSheet: true })).toBe("track");
  });

  it("ignores a stale open once the close glide owns the bar", () => {
    expect(resolveSheetBottomAction({ viewportOpen: true, closing: true, focusedInSheet: false })).toBe("ignore");
  });

  it("begins the close when the keyboard left but focus stayed", () => {
    expect(resolveSheetBottomAction({ viewportOpen: false, closing: false, focusedInSheet: true })).toBe("begin-close");
  });

  it("settles to zero when closed and idle", () => {
    expect(resolveSheetBottomAction({ viewportOpen: false, closing: false, focusedInSheet: false })).toBe("settle-zero");
    expect(resolveSheetBottomAction({ viewportOpen: false, closing: true, focusedInSheet: true })).toBe("ignore");
  });
});

describe("isStaleUpwardJump", () => {
  const base = {
    appliedBottom: 200,
    liveInset: 300,
    msSinceLastEvent: 200,
    msSinceFallStart: 120,
    intentAfterFallStart: false,
  };

  it("fires for a silent upward transient reversing a fresh fall", () => {
    expect(isStaleUpwardJump(base)).toBe(true);
  });

  it("never fires without direction reversal, with intent, or without silence", () => {
    expect(isStaleUpwardJump({ ...base, liveInset: 200 })).toBe(false);
    expect(isStaleUpwardJump({ ...base, intentAfterFallStart: true })).toBe(false);
    expect(isStaleUpwardJump({ ...base, msSinceLastEvent: 100 })).toBe(false);
    expect(isStaleUpwardJump({ ...base, msSinceFallStart: 2000 })).toBe(false);
  });
});

describe("isEditableElement", () => {
  it("detects native editables and contenteditable", () => {
    expect(isEditableElement(document.createElement("input"))).toBe(true);
    expect(isEditableElement(document.createElement("textarea"))).toBe(true);
    const ce = document.createElement("div");
    ce.setAttribute("contenteditable", "true");
    expect(isEditableElement(ce)).toBe(true);
    expect(isEditableElement(document.createElement("div"))).toBe(false);
    expect(isEditableElement(null)).toBe(false);
  });
});

// ── Integration: the real wired module ───────────────────────────────────────

// initMobileKeyboard is module-global: dispose in afterEach (not just in
// try/finally) so a mid-test failure can never leak `initialized` into the
// other tests of this file.
let dispose: (() => void) | null = null;

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  dispose?.();
  dispose = null;
  vi.unstubAllGlobals();
  delete (window as any).visualViewport;
  delete (window as any).innerHeight;
  document.body.innerHTML = "";
  document.documentElement.style.removeProperty("--kb-inset");
  document.documentElement.style.removeProperty("--app-vh");
  document.documentElement.classList.remove("kb-open");
});

/** Touch device with a fully controlled visual viewport + innerHeight. */
const stubTouchViewport = () => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query === "(pointer: coarse)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
  const vv = {
    height: 800,
    offsetTop: 0,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
  return vv;
};

describe("initMobileKeyboard", () => {
  it("seeds the CSS variables from the initial geometry", () => {
    stubTouchViewport();
    expect((window as any).innerHeight).toBe(800);
    dispose = initMobileKeyboard();
    expect(document.documentElement.style.getPropertyValue("--app-vh")).toBe("800px");
    expect(document.documentElement.style.getPropertyValue("--kb-inset")).toBe("0px");
    expect(getMobileKeyboardState().isOpen).toBe(false);
  });

  it("publishes the keyboard geometry and notifies on open", async () => {
    const vv = stubTouchViewport();
    const seen: number[] = [];
    dispose = initMobileKeyboard();
    const unsubscribe = subscribeMobileKeyboard(() => {
      seen.push(getMobileKeyboardState().keyboardInset);
    });

    vv.height = 500; // keyboard covers 300px
    window.dispatchEvent(new Event("resize"));

    expect(getMobileKeyboardState().isOpen).toBe(true);
    expect(getMobileKeyboardState().keyboardInset).toBe(300);
    expect(document.documentElement.style.getPropertyValue("--kb-inset")).toBe("300px");
    expect(document.documentElement.style.getPropertyValue("--app-vh")).toBe("500px");
    expect(document.documentElement.classList.contains("kb-open")).toBe(true);
    expect(seen).toContain(300);
    unsubscribe();
  });

  it("tracks the live visual viewport with the follow loop while an editable is focused", async () => {
    vi.useFakeTimers();
    const vv = stubTouchViewport();
    dispose = initMobileKeyboard();

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    // The keyboard slides up WITHOUT any visual-viewport event (iOS re-focus
    // quirk): the per-frame loop still detects it via the live vv.height.
    vv.height = 500;
    await vi.advanceTimersByTimeAsync(120);
    expect(getMobileKeyboardState().isOpen).toBe(true);
    expect(document.documentElement.style.getPropertyValue("--kb-inset")).toBe("300px");
  });

  it("swallows the one-frame WebKit false close while focus stays live", async () => {
    vi.useFakeTimers();
    const vv = stubTouchViewport();
    dispose = initMobileKeyboard();

    vv.height = 500;
    window.dispatchEvent(new Event("resize"));
    expect(getMobileKeyboardState().isOpen).toBe(true);

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    // The bogus transient: reports the pre-keyboard geometry for one event.
    vv.height = 800;
    window.dispatchEvent(new Event("resize"));
    // Ignored: focus is live, the composer never moves.
    expect(document.documentElement.style.getPropertyValue("--kb-inset")).toBe("300px");

    // Reality takes over: the next live report says open again.
    vv.height = 500;
    window.dispatchEvent(new Event("resize"));
    expect(getMobileKeyboardState().isOpen).toBe(true);
    expect(document.documentElement.style.getPropertyValue("--kb-inset")).toBe("300px");

    // A close that persists for frames with focus live is real (late blur):
    // accepted after the tolerance window, exactly once.
    vv.height = 800;
    window.dispatchEvent(new Event("resize"));
    await vi.advanceTimersByTimeAsync(400);
    expect(getMobileKeyboardState().isOpen).toBe(false);
    expect(document.documentElement.style.getPropertyValue("--kb-inset")).toBe("0px");
  });

  it("commits the close in one instant step the moment the viewport reports it", async () => {
    vi.useFakeTimers();
    const vv = stubTouchViewport();
    dispose = initMobileKeyboard();

    vv.height = 500;
    window.dispatchEvent(new Event("resize"));
    expect(document.documentElement.style.getPropertyValue("--kb-inset")).toBe("300px");

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    input.blur();

    // No JS descent, no waiting: the close viewport event writes the closed
    // geometry immediately — the single CSS transition glides the panel down.
    vv.height = 800;
    window.dispatchEvent(new Event("resize"));
    expect(document.documentElement.style.getPropertyValue("--kb-inset")).toBe("0px");
    expect(document.documentElement.style.getPropertyValue("--app-vh")).toBe("800px");
    expect(document.documentElement.classList.contains("kb-open")).toBe(false);

    // Repeated closed events change nothing: the close never re-plays.
    window.dispatchEvent(new Event("resize"));
    await vi.advanceTimersByTimeAsync(500);
    expect(document.documentElement.style.getPropertyValue("--kb-inset")).toBe("0px");
    expect(document.documentElement.classList.contains("kb-open")).toBe(false);
  });

  it("swallows a stale post-close open transient, then honors a genuinely late open", async () => {
    vi.useFakeTimers();
    const vv = stubTouchViewport();
    dispose = initMobileKeyboard();

    vv.height = 500;
    window.dispatchEvent(new Event("resize"));

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    input.blur();
    // Run the descent to completion (blur frame + 240ms slide).
    await vi.advanceTimersByTimeAsync(40);
    vv.height = 800;
    window.dispatchEvent(new Event("resize"));
    await vi.advanceTimersByTimeAsync(260);
    expect(document.documentElement.style.getPropertyValue("--kb-inset")).toBe("0px");
    expect(document.documentElement.classList.contains("kb-open")).toBe(false);

    // A stale "open" transient with no focus owner, right after the descent:
    // swallowed — no second motion.
    vv.height = 500;
    window.dispatchEvent(new Event("resize"));
    await vi.advanceTimersByTimeAsync(60);
    expect(document.documentElement.style.getPropertyValue("--kb-inset")).toBe("0px");
    expect(document.documentElement.classList.contains("kb-open")).toBe(false);

    // Past the suppression window an open report is honored again.
    await vi.advanceTimersByTimeAsync(500);
    vv.height = 500;
    window.dispatchEvent(new Event("resize"));
    expect(document.documentElement.style.getPropertyValue("--kb-inset")).toBe("300px");
    expect(document.documentElement.classList.contains("kb-open")).toBe(true);
  });

  it("re-opens live on refocus after a close", async () => {
    vi.useFakeTimers();
    const vv = stubTouchViewport();
    dispose = initMobileKeyboard();

    vv.height = 500;
    window.dispatchEvent(new Event("resize"));

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    input.blur();
    vv.height = 800;
    window.dispatchEvent(new Event("resize"));
    expect(document.documentElement.style.getPropertyValue("--kb-inset")).toBe("0px");

    // Re-tap: fresh focus drops any suppression and the live geometry lifts
    // the panel again — one motion, no cancel dance.
    input.focus();
    vv.height = 500;
    window.dispatchEvent(new Event("resize"));
    await vi.advanceTimersByTimeAsync(80);
    expect(document.documentElement.style.getPropertyValue("--kb-inset")).toBe("300px");
    expect(document.documentElement.classList.contains("kb-open")).toBe(true);
  });
});
