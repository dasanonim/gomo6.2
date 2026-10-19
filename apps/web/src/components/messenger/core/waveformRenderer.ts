import { requestMeasure, requestMutation } from "./fasterdom";

// ─── Voice waveform renderer (port of Telegram Web's LiveWaveformRenderer) ──
// A canvas, not DOM bars: 3px bars with a 3px gap, rounded caps, silence drawn
// as a dot, the loudest bar capped at 80% of the height, and peaks normalized
// against a running maximum so a quiet recording still reads as a waveform.
//
// The bars are anchored to the RIGHT edge: while recording, a new peak pushes
// the older ones left, which is what makes the live waveform feel like it is
// being written (Telegram's own behaviour).
//
// When `progress` is set (a paused draft, a playback), the played part is drawn
// at full opacity and the rest at 0.3 — no second layer, no clip path, one pass.

const BAR_WIDTH = 3;
const BAR_GAP = 3;
/** Half the width, so a silent bar is a round dot. */
const BAR_RADIUS = BAR_WIDTH / 2;
const MIN_BAR_HEIGHT = BAR_WIDTH;
/** The loudest bars must not touch the canvas edges. */
const MAX_BAR_HEIGHT_RATIO = 0.8;
const UNPLAYED_ALPHA = 0.3;
const INITIAL_MAX_PEAK = 0.05;

export class WaveformRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private peaks: number[] = [];
  private maxPeak = INITIAL_MAX_PEAK;
  private capacity = 0;
  private cssWidth = 0;
  private cssHeight = 0;
  private dpr = 1;
  private color = "";
  private progress?: number;
  private drawScheduled = false;
  private seekable = false;
  private destroyed = false;
  private cleanupDrag?: () => void;

  onSeek?: (progress: number) => void;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("waveform: no 2d context");
    this.ctx = ctx;

    requestMeasure(() => {
      if (this.destroyed) return;
      const rect = canvas.getBoundingClientRect();
      this.color = getComputedStyle(canvas).color;
      this.applySize(rect.width, rect.height);
    });

    canvas.addEventListener("pointerdown", this.handlePointerDown);
  }

  handleResize(width: number, height: number) {
    this.applySize(width, height);
  }

  setSeekable(seekable: boolean) {
    this.seekable = seekable;
    requestMutation(() => {
      if (this.destroyed) return;
      this.canvas.style.cursor = seekable ? "pointer" : "";
      this.canvas.style.touchAction = seekable ? "none" : "";
    });
  }

  pushPeak(value: number) {
    if (value > this.maxPeak) this.maxPeak = value;
    this.peaks.push(Math.min(1, value / this.maxPeak));
    if (this.capacity && this.peaks.length > this.capacity) {
      this.peaks.splice(0, this.peaks.length - this.capacity);
    }
    this.scheduleDraw();
  }

  /** Show a finished recording: resampled to the bars the width can hold. */
  setPeaks(peaks: ArrayLike<number>) {
    const capacity = this.capacity || 1;
    const fitted: number[] = [];

    if (peaks.length <= capacity) {
      for (let i = 0; i < peaks.length; i += 1) fitted.push(peaks[i]);
    } else {
      const ratio = peaks.length / capacity;
      for (let i = 0; i < capacity; i += 1) {
        const start = Math.floor(i * ratio);
        const end = Math.floor((i + 1) * ratio);
        let peak = 0;
        for (let j = start; j < end && j < peaks.length; j += 1) {
          if (peaks[j] > peak) peak = peaks[j];
        }
        fitted.push(peak);
      }
    }

    let max = 0.001;
    for (let i = 0; i < fitted.length; i += 1) if (fitted[i] > max) max = fitted[i];
    for (let i = 0; i < fitted.length; i += 1) fitted[i] = Math.min(1, fitted[i] / max);

    this.peaks = fitted;
    this.scheduleDraw();
  }

  setProgress(progress?: number) {
    this.progress = progress;
    this.scheduleDraw();
  }

  destroy() {
    this.destroyed = true;
    this.canvas.removeEventListener("pointerdown", this.handlePointerDown);
    this.cleanupDrag?.();
    this.peaks = [];
  }

  private handlePointerDown = (event: PointerEvent) => {
    if (!this.seekable || !this.onSeek) return;
    event.preventDefault();

    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0) return;

    const seekTo = (clientX: number) => {
      this.onSeek?.(Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)));
    };

    seekTo(event.clientX);

    const handleMove = (moveEvent: PointerEvent) => seekTo(moveEvent.clientX);
    const handleUp = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);
      this.cleanupDrag = undefined;
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
    this.cleanupDrag = handleUp;
  };

  private applySize(width: number, height: number) {
    if (width <= 0) return;

    this.cssWidth = width;
    this.cssHeight = height;
    this.dpr = window.devicePixelRatio || 1;
    this.capacity = Math.max(1, Math.floor((this.cssWidth + BAR_GAP) / (BAR_WIDTH + BAR_GAP)));

    if (this.peaks.length > this.capacity) {
      this.peaks.splice(0, this.peaks.length - this.capacity);
    }

    requestMutation(() => {
      if (this.destroyed) return;
      this.canvas.width = Math.round(this.cssWidth * this.dpr);
      this.canvas.height = Math.round(this.cssHeight * this.dpr);
      this.draw();
    });
  }

  private scheduleDraw() {
    if (this.drawScheduled) return;
    this.drawScheduled = true;
    requestMutation(() => {
      this.drawScheduled = false;
      if (this.destroyed) return;
      this.draw();
    });
  }

  private draw() {
    const width = this.cssWidth;
    const height = this.cssHeight;
    if (!width || !height) return;

    const { ctx } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (!this.peaks.length) return;

    const stride = BAR_WIDTH + BAR_GAP;
    const totalWidth = this.peaks.length * stride - BAR_GAP;
    const startX = Math.max(0, width - totalWidth);
    const midY = height / 2;

    ctx.fillStyle = this.color;

    const hasProgress = this.progress !== undefined;
    const progressPx = hasProgress ? startX + Math.max(0, Math.min(1, this.progress!)) * totalWidth : Infinity;

    const snap = (value: number) => Math.round(value * this.dpr) / this.dpr;
    const maxBarHeight = height * MAX_BAR_HEIGHT_RATIO;

    for (let i = 0; i < this.peaks.length; i += 1) {
      const x = snap(startX + i * stride);
      const barHeight = snap(Math.max(MIN_BAR_HEIGHT, Math.min(maxBarHeight, this.peaks[i] * maxBarHeight)));
      const y = snap(midY - barHeight / 2);

      ctx.globalAlpha = !hasProgress || x + BAR_WIDTH / 2 <= progressPx ? 1 : UNPLAYED_ALPHA;

      if (typeof ctx.roundRect === "function") {
        ctx.beginPath();
        ctx.roundRect(x, y, BAR_WIDTH, barHeight, BAR_RADIUS);
        ctx.fill();
      } else {
        // Older engines without roundRect still get a clean bar.
        ctx.fillRect(x, y, BAR_WIDTH, barHeight);
      }
    }

    ctx.globalAlpha = 1;
  }
}
