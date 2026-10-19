import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WaveformRenderer } from "./waveformRenderer";

// A recording 2D context: the renderer is pure drawing math, so the calls it
// makes are the thing worth asserting.
function fakeContext() {
  const calls: Array<{ alpha: number; x: number; y: number; w: number; h: number }> = [];
  const ctx = {
    globalAlpha: 1,
    fillStyle: "",
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(),
    roundRect: vi.fn((x: number, y: number, w: number, h: number) => {
      calls.push({ alpha: ctx.globalAlpha, x, y, w, h });
    }),
  };
  return { ctx, calls };
}

function fakeCanvas(ctx: unknown, width = 200, height = 26) {
  const element = {
    style: {} as CSSStyleDeclaration,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({}) }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  return element as unknown as HTMLCanvasElement;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 60));

beforeEach(() => {
  vi.stubGlobal("getComputedStyle", () => ({ color: "rgb(1, 2, 3)" }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WaveformRenderer", () => {
  it("draws one rounded bar per peak, centred on the canvas", async () => {
    const { ctx, calls } = fakeContext();
    const canvas = fakeCanvas(ctx);
    const renderer = new WaveformRenderer(canvas);
    renderer.handleResize(200, 26);
    await flush();

    renderer.setPeaks([0.2, 0.9, 0.5]);
    await flush();

    // 3px bars + 3px gaps; every bar is vertically centred on the canvas.
    expect(ctx.roundRect).toHaveBeenCalledTimes(3);
    calls.forEach((call) => {
      expect(call.w).toBe(3);
      expect(call.h).toBeGreaterThanOrEqual(3);
      // Within a device pixel: bars are snapped to the pixel grid for crisp caps.
      expect(Math.abs(call.y + call.h / 2 - 13)).toBeLessThanOrEqual(1);
    });
    renderer.destroy();
  });

  it("caps the loudest bar below the canvas edge and keeps silence a dot", async () => {
    const { ctx, calls } = fakeContext();
    const canvas = fakeCanvas(ctx, 200, 26);
    const renderer = new WaveformRenderer(canvas);
    renderer.handleResize(200, 26);
    await flush();

    renderer.setPeaks([0, 1]);
    await flush();

    const heights = calls.map((call) => call.h);
    expect(Math.min(...heights)).toBe(3); // a silent bar is a round dot
    expect(Math.max(...heights)).toBeLessThanOrEqual(26 * 0.8 + 0.5);
    renderer.destroy();
  });

  it("splits played and unplayed bars by opacity when progress is set", async () => {
    const { ctx, calls } = fakeContext();
    const canvas = fakeCanvas(ctx, 200, 26);
    const renderer = new WaveformRenderer(canvas);
    renderer.handleResize(200, 26);
    await flush();

    renderer.setPeaks([0.5, 0.5, 0.5, 0.5]);
    renderer.setProgress(0.5);
    await flush();

    const alphas = calls.map((call) => call.alpha);
    expect(alphas).toContain(1);
    expect(alphas).toContain(0.3);
    // The played half is the left one.
    const first = calls[0];
    const last = calls[calls.length - 1];
    expect(first.alpha).toBe(1);
    expect(last.alpha).toBe(0.3);
    renderer.destroy();
  });

  it("anchors the newest peaks to the right edge", async () => {
    const { ctx, calls } = fakeContext();
    const canvas = fakeCanvas(ctx, 200, 26);
    const renderer = new WaveformRenderer(canvas);
    renderer.handleResize(200, 26);
    await flush();

    renderer.pushPeak(0.5);
    renderer.pushPeak(0.6);
    await flush();

    const last = calls[calls.length - 1];
    expect(Math.round(last.x + last.w)).toBe(200);
    renderer.destroy();
  });
});
