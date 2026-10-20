import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  VOICE_BARS,
  MIN_PEAK_SCALE,
  PEAK_SCALE_MULTIPLIER,
  barCountForWidth,
  livePeak,
  peakScale,
  rmsFromTimeDomain,
  storedPeak,
  extensionForMime,
  formatVoiceTime,
  isVoiceAttachment,
  normalizeWaveform,
  parseVoiceMeta,
  pickVoiceMimeType,
} from "./voice";
import type { Attachment } from "./types";

const voiceAttachment = (meta: unknown): Attachment => ({
  url: "u1/messenger/voice.webm",
  type: "audio",
  name: "voice.webm",
  size: 1024,
  mime: "audio/webm",
  meta: JSON.stringify(meta),
});

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("formatVoiceTime", () => {
  it("formats like a voice message, never with hours", () => {
    expect(formatVoiceTime(0)).toBe("0:00");
    expect(formatVoiceTime(7)).toBe("0:07");
    expect(formatVoiceTime(59.9)).toBe("0:59");
    expect(formatVoiceTime(60)).toBe("1:00");
    expect(formatVoiceTime(125.4)).toBe("2:05");
  });

  it("survives garbage", () => {
    expect(formatVoiceTime(Number.NaN)).toBe("0:00");
    expect(formatVoiceTime(-4)).toBe("0:00");
  });
});

describe("peakScale (Telegram's 1.8x average)", () => {
  it("scales by the average, not by the loudest sample", () => {
    // A flat room tone sits well below the ceiling instead of filling it.
    expect(peakScale(new Array(40).fill(0.2))).toBeCloseTo(0.36, 3);
    // One loud spike barely moves the scale: the rest of the note survives.
    const spiky = [1, ...new Array(39).fill(0.1)];
    expect(peakScale(spiky)).toBeCloseTo(((1 + 39 * 0.1) / 40) * 1.8, 3);
  });

  it("keeps a floor so silence stays silent", () => {
    expect(peakScale([])).toBe(MIN_PEAK_SCALE);
    expect(peakScale(new Array(40).fill(0))).toBe(MIN_PEAK_SCALE);
  });

  it("puts the average bar at ~55% of the height", () => {
    const mean = 0.3;
    const values = new Array(40).fill(mean);
    const scale = peakScale(values);
    expect((mean / scale) * 100).toBeCloseTo(100 / PEAK_SCALE_MULTIPLIER, 0);
  });
});

describe("rmsFromTimeDomain", () => {
  it("reads a silent analyser buffer as silence", () => {
    expect(rmsFromTimeDomain(new Uint8Array([128, 128, 128, 128]))).toBe(0);
    expect(rmsFromTimeDomain(new Uint8Array(1024).fill(128))).toBe(0);
  });

  it("does not mistake an unwritten buffer for full volume", () => {
    // The bug: an analyser that never wrote leaves the array at zeros, which
    // naively computes as RMS 1.0 — a waveform pinned to the ceiling before the
    // first sound (the second recording, whose context starts suspended).
    expect(rmsFromTimeDomain(new Uint8Array(1024))).toBe(0);
    expect(rmsFromTimeDomain([])).toBe(0);
  });

  it("measures a real signal", () => {
    // samples are centred on 128 and scaled to -1..1
    expect(rmsFromTimeDomain([128, 255, 128, 0])).toBeCloseTo(0.704, 3);
    expect(rmsFromTimeDomain([128, 228, 128, 28])).toBeCloseTo(0.552, 3);
  });
});

describe("live peaks", () => {
  it("keeps the stored floor and the live value on separate scales", () => {
    // Silence: the message's waveform keeps a visible 6%, the live renderer
    // must receive 0 — a floored value is above its running maximum (0.05) and
    // would render as full height until the first real sound.
    expect(livePeak(0)).toBe(0);
    expect(storedPeak(livePeak(0))).toBe(6);
  });

  it("curves a normal level without ever exceeding one", () => {
    expect(livePeak(0.05)).toBeGreaterThan(0);
    expect(livePeak(0.05)).toBeLessThan(0.5);
    expect(livePeak(0.5)).toBeLessThanOrEqual(1);
    expect(livePeak(1)).toBe(1);
  });
});

describe("barCountForWidth", () => {
  it("sizes the bar count to the width so a waveform always reads as one", () => {
    // 240px bubble: about 3px per bar with a 2px gap.
    expect(barCountForWidth(240)).toBe(48);
    // A full-width composer row would stretch 40 bars into sticks; the count
    // grows (and stays sane at absurd widths).
    expect(barCountForWidth(700)).toBe(140);
    expect(barCountForWidth(5000)).toBe(160);
    expect(barCountForWidth(10)).toBe(16);
    // Unknown width: the message's own stored count.
    expect(barCountForWidth(0)).toBe(VOICE_BARS);
  });
});

describe("normalizeWaveform", () => {
  it("resamples to exactly VOICE_BARS entries", () => {
    expect(normalizeWaveform([1, 2, 3]).length).toBe(VOICE_BARS);
    expect(normalizeWaveform(new Array(100).fill(50)).length).toBe(VOICE_BARS);
    expect(normalizeWaveform(undefined).length).toBe(VOICE_BARS);
  });

  it("keeps a correctly sized waveform as is and clamps out-of-range peaks", () => {
    const input = new Array(VOICE_BARS).fill(40);
    expect(normalizeWaveform(input)).toEqual(input);
    expect(normalizeWaveform([-10, 200]).every((value) => value >= 0 && value <= 100)).toBe(true);
  });

  it("takes the peak of each bucket when shrinking", () => {
    const peaks = normalizeWaveform([0, 0, 100, 0, 0, 0, 0, 0], 4);
    expect(peaks).toHaveLength(4);
    expect(peaks).toContain(100);
  });
});

describe("parseVoiceMeta", () => {
  it("reads a voice note's duration and waveform", () => {
    const meta = parseVoiceMeta(voiceAttachment({ voice: true, duration: 12.5, waveform: [10, 20] }));
    expect(meta?.duration).toBe(12.5);
    expect(meta?.waveform).toHaveLength(VOICE_BARS);
    expect(isVoiceAttachment(voiceAttachment({ voice: true, duration: 3 }))).toBe(true);
  });

  it("refuses ordinary audio files", () => {
    // A sent .mp3 is an audio attachment, not a voice note.
    expect(parseVoiceMeta(voiceAttachment({ duration: 3 }))).toBeNull();
    expect(parseVoiceMeta(voiceAttachment({ voice: false }))).toBeNull();
    expect(isVoiceAttachment({ ...voiceAttachment({ voice: true }), type: "file" })).toBe(false);
  });

  it("never throws on broken metadata", () => {
    expect(parseVoiceMeta({ ...voiceAttachment({}), meta: "not json" })).toBeNull();
    expect(parseVoiceMeta({ ...voiceAttachment({}), meta: null })).toBeNull();
    expect(parseVoiceMeta(null)).toBeNull();
    expect(parseVoiceMeta(undefined)).toBeNull();
  });
});

describe("recording container", () => {
  it("names the file for the recorder's own container", () => {
    // Never ".webm": the server treats that extension as a video input and runs
    // it through ffmpeg, which an audio-only recording fails.
    expect(extensionForMime("audio/webm;codecs=opus")).toBe("weba");
    expect(extensionForMime("audio/mp4;codecs=mp4a.40.2")).toBe("m4a");
    expect(extensionForMime("audio/ogg;codecs=opus")).toBe("ogg");
    // Unknown container: audio-only mp4, which can never be taken for a video.
    expect(extensionForMime("")).toBe("m4a");
  });

  it("prefers opus in webm, falls back to whatever the browser supports", () => {
    const supported = new Set(["audio/mp4"]);
    vi.stubGlobal("MediaRecorder", {
      isTypeSupported: (mime: string) => supported.has(mime),
    });
    expect(pickVoiceMimeType()).toBe("audio/mp4");

    vi.stubGlobal("MediaRecorder", { isTypeSupported: () => true });
    expect(pickVoiceMimeType()).toBe("audio/webm;codecs=opus");

    vi.stubGlobal("MediaRecorder", { isTypeSupported: () => false });
    expect(pickVoiceMimeType()).toBe("");

    vi.stubGlobal("MediaRecorder", undefined);
    expect(pickVoiceMimeType()).toBeNull();
  });
});
