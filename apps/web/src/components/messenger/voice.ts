import type { Attachment } from "./types";

// ─── Voice messages ────────────────────────────────────────────────────────
// A voice note is an `audio` attachment whose meta says `voice: true` and
// carries what the UI needs to draw it without touching the audio itself:
// the duration and the waveform. Telegram sends exactly this (a 5-bit
// amplitude string) — a receiver must never have to download and decode the
// recording just to paint its bars.

/** Telegram-ish cap: long enough for a real thought, small enough to upload. */
export const VOICE_MAX_SECONDS = 300;
/** Bars in a bubble's waveform (Telegram draws ~40 at a phone width). */
export const VOICE_BARS = 40;
/** Storage rejects anything over 10 MB, so the UI stops well before that. */
export const VOICE_MAX_BYTES = 9 * 1024 * 1024;

export type VoiceMeta = {
  /** Seconds, fractional. */
  duration: number;
  /** 0..100 per bar, exactly VOICE_BARS entries once normalized. */
  waveform: number[];
  voice: true;
};

/** `m:ss` — the only format a voice message ever shows. */
export function formatVoiceTime(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const total = Math.floor(safe + 0.0001);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${rest < 10 ? "0" : ""}${rest}`;
}

/**
 * Resamples a waveform to exactly `bars` entries, clamped to 0..100. Old rows,
 * a decoded file with a different bar count and the live preview all go through
 * this, so the renderer can assume one length.
 */
export function normalizeWaveform(values: number[] | undefined, bars = VOICE_BARS): number[] {
  if (!values || values.length === 0) return new Array(bars).fill(0);
  const clean = values.map((value) => (Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0));
  if (clean.length === bars) return clean;
  const out: number[] = [];
  for (let i = 0; i < bars; i += 1) {
    const from = Math.floor((i * clean.length) / bars);
    const to = Math.max(from + 1, Math.floor(((i + 1) * clean.length) / bars));
    let peak = 0;
    for (let at = from; at < to && at < clean.length; at += 1) peak = Math.max(peak, clean[at]);
    out.push(peak);
  }
  return out;
}

/** The voice metadata of an attachment, or null when it is not a voice note. */
/**
 * How many bars fit a given pixel width.
 *
 * A fixed 40 bars looks right in a 240px bubble and like scattered sticks in a
 * wide composer row, so the count follows the width: ~3px per bar plus a 2px
 * gap, within sane bounds. The waveform is resampled to it (see `normalizeWaveform`).
 */
export function barCountForWidth(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return VOICE_BARS;
  const perBar = 3 + 2;
  return Math.min(160, Math.max(16, Math.round(width / perBar)));
}

/**
 * RMS of an analyser's time-domain buffer (128 = silence, 0/255 = full swing).
 *
 * An all-zero buffer is NOT full volume: it is a buffer the analyser never
 * wrote — a suspended AudioContext, a stopped source, a freshly allocated
 * array. Read naively, zeros compute as `(0-128)/128 = -1` for every sample,
 * i.e. RMS 1.0, which is exactly how a live waveform ends up pinned to the
 * ceiling before the first sound (and why only the *second* recording showed
 * it: the first context runs, later ones can start suspended).
 */
export function rmsFromTimeDomain(buffer: ArrayLike<number>): number {
  const length = buffer.length;
  if (!length) return 0;
  let sum = 0;
  let wrote = false;
  for (let i = 0; i < length; i += 1) {
    const value = buffer[i];
    if (value !== 0) wrote = true;
    const centred = (value - 128) / 128;
    sum += centred * centred;
  }
  if (!wrote) return 0;
  return Math.sqrt(sum / length);
}

/**
 * Peak normalisation, Telegram's model.
 *
 * Their stored waveform is scaled by the **average** peak times 1.8 (floored at
 * MIN_NORM_PEAK), not by the loudest sample. That is what makes a note read the
 * same everywhere: the average bar sits at ~55% of the height, loud syllables
 * clip at the top, quiet ones stay low — and a single startup thump (or a door
 * slam) cannot flatten the rest of the recording into dots, nor paint the whole
 * preview at full height.
 */
export const PEAK_SCALE_MULTIPLIER = 1.8;
/** Below this a "scale" is just noise; keeps silence at zero instead of 100%. */
export const MIN_PEAK_SCALE = 0.02;

export function peakScale(peaks: ArrayLike<number>): number {
  const length = peaks.length;
  if (!length) return MIN_PEAK_SCALE;
  let sum = 0;
  for (let i = 0; i < length; i += 1) sum += peaks[i];
  return Math.max((sum / length) * PEAK_SCALE_MULTIPLIER, MIN_PEAK_SCALE);
}

/**
 * A live analyser's RMS → 0..1 peak, with the same curve the file-based
 * waveform uses. No floor: the renderer normalises against a running maximum
 * that starts at 0.05, so a floored silence would read as full height.
 */
export function livePeak(rms: number): number {
  return Math.min(1, Math.max(0, Math.pow(rms * 4.2, 0.75)));
}

/** The 0..100 value stored in a message's waveform: silence keeps a visible 6%. */
export function storedPeak(peak: number): number {
  return Math.round(Math.min(100, Math.max(6, peak * 100)));
}

export function parseVoiceMeta(attachment: Attachment | undefined | null): VoiceMeta | null {
  if (!attachment || attachment.type !== "audio" || !attachment.meta) return null;
  try {
    const parsed = JSON.parse(attachment.meta) as Partial<VoiceMeta> & { duration?: unknown };
    if (parsed.voice !== true) return null;
    const duration = typeof parsed.duration === "number" && parsed.duration > 0 ? parsed.duration : 0;
    const waveform = normalizeWaveform(Array.isArray(parsed.waveform) ? parsed.waveform.filter((v): v is number => typeof v === "number") : undefined);
    return { duration, waveform, voice: true };
  } catch {
    return null;
  }
}

/** The chat-list preview for a message that is only an attachment. */
export function attachmentPreviewLabel(attachments: Attachment[] | undefined | null): string | null {
  if (attachments?.some((attachment) => isVoiceAttachment(attachment))) return "Голосовое сообщение";
  return null;
}

/** True when the attachment should render as a voice note, not a file row. */
export function isVoiceAttachment(attachment: Attachment | undefined | null): boolean {
  return parseVoiceMeta(attachment) !== null;
}

const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/ogg;codecs=opus",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
  "audio/webm",
];

/**
 * The first container/codec this browser can actually record. Safari records
 * mp4/AAC, Chromium webm/Opus — both play everywhere modern, so the receiver
 * needs no transcode. Returns null when MediaRecorder is unavailable.
 */
export function pickVoiceMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const mime of MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) return mime;
    } catch {
      /* keep probing */
    }
  }
  return "";
}

/**
 * File extension for a recorder mime type.
 *
 * Audio WebM gets `.weba`, never `.webm`: the storage handler treats `.webm` as
 * a VIDEO input and pushes it through the ffmpeg transcoder, which an audio-only
 * file fails (or worse, silently becomes a silent mp4). `.weba` is the standard
 * extension for audio-only WebM and is stored as `audio/webm`.
 */
export function extensionForMime(mime: string): string {
  if (mime.includes("mp4") || mime.includes("aac")) return "m4a";
  if (mime.includes("ogg")) return "ogg";
  // An unknown container is safer labelled as audio-only mp4: it can never be
  // mistaken for a video, and browsers sniff the real format on playback.
  if (!mime) return "m4a";
  return "weba";
}

/**
 * Peaks from an actual recording, 0..100, `bars` of them.
 *
 * The live preview during recording is only an approximation (an analyser can
 * miss transients between frames); the sent waveform is computed from the
 * finished file so the receiver sees what the sender heard.
 */
export async function extractWaveform(blob: Blob, bars = VOICE_BARS): Promise<number[] | null> {
  if (typeof AudioContext === "undefined" && typeof (globalThis as { webkitAudioContext?: unknown }).webkitAudioContext === "undefined") {
    return null;
  }
  const Ctor = (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
    ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;

  const context = new Ctor();
  try {
    const buffer = await context.decodeAudioData(await blob.arrayBuffer());
    if (!buffer.length || !buffer.numberOfChannels) return null;
    const channel = buffer.getChannelData(0);
    const bucket = Math.max(1, Math.floor(channel.length / bars));
    const peaks: number[] = [];
    for (let i = 0; i < bars; i += 1) {
      let peak = 0;
      const start = i * bucket;
      const end = Math.min(channel.length, start + bucket);
      // Stride samples: a 5-minute file at 48kHz is 14M floats, and reading all
      // of them on the main thread blocks the UI.
      const stride = Math.max(1, Math.floor((end - start) / 400));
      for (let at = start; at < end; at += stride) {
        const value = Math.abs(channel[at]);
        if (value > peak) peak = value;
      }
      peaks.push(peak);
    }
    // Telegram's scale: relative to the average, so the average bar sits at
    // ~55% and one loud transient cannot compress the rest into dots.
    const scale = peakScale(peaks);
    return peaks.map((peak) => Math.round(Math.min(100, Math.max(6, (peak / scale) * 100))));
  } catch {
    return null;
  } finally {
    void context.close().catch(() => undefined);
  }
}
