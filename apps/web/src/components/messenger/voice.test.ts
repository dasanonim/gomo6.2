import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  VOICE_BARS,
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
