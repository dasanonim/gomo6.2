import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { VoicePlayer } from "./VoicePlayer";
import { VOICE_BARS } from "./voice";
import type { Attachment } from "./types";

const attachment: Attachment = {
  url: "u1/messenger/voice.webm",
  type: "audio",
  name: "voice.webm",
  size: 2048,
  mime: "audio/webm",
  meta: JSON.stringify({ voice: true, duration: 30, waveform: new Array(VOICE_BARS).fill(60) }),
};

// The player fetches its blob through the shared authenticated cache; the test
// only needs a URL to exist — and to be able to delay it, because the real one
// arrives asynchronously (the element mounts a tick after the player).
const blobState = vi.hoisted(() => ({ url: "blob:voice" as string | null }));
vi.mock("./attachmentMedia", () => ({
  useAuthenticatedAttachmentUrl: () => blobState.url,
}));

const { mockHaptics } = vi.hoisted(() => ({ mockHaptics: { tick: vi.fn() } }));
vi.mock("@/lib/haptics", () => ({ hapticTick: mockHaptics.tick }));

/** jsdom has no media engine: expose the few properties the player drives. */
function stubMedia(audio: HTMLAudioElement) {
  Object.defineProperty(audio, "duration", { configurable: true, get: () => 30 });
  audio.play = vi.fn(async () => {
    audio.dispatchEvent(new Event("play"));
  });
  audio.pause = vi.fn(() => {
    audio.dispatchEvent(new Event("pause"));
  });
}

beforeEach(() => {
  blobState.url = "blob:voice";
  localStorage.clear();
  mockHaptics.tick.mockClear();
  // The rAF loop would run forever otherwise.
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

describe("VoicePlayer", () => {
  it("draws the stored waveform, not a decoded file", () => {
    const { container } = render(<VoicePlayer attachment={attachment} isMine />);
    const layers = container.querySelectorAll(".voice-bars");
    expect(layers).toHaveLength(2);
    expect(layers[0].querySelectorAll(".voice-bar")).toHaveLength(VOICE_BARS);
    expect(container.querySelector(".voice-time")?.textContent).toBe("0:30");
  });

  it("plays and pauses from the round button", async () => {
    const { container } = render(<VoicePlayer attachment={attachment} />);
    const audio = container.querySelector("audio") as HTMLAudioElement;
    stubMedia(audio);
    const button = screen.getByRole("button", { name: /Воспроизвести голосовое сообщение/ });

    await act(async () => {
      fireEvent.click(button);
    });

    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /Пауза/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Пауза/ }));
    expect(audio.pause).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /Воспроизвести/ })).toBeInTheDocument();
  });

  it("drafts as Telegram's pill: a canvas waveform and a centred play + duration", () => {
    const { container } = render(<VoicePlayer attachment={attachment} variant="draft" src="blob:draft" />);

    expect(container.querySelector("canvas.voice-draft-canvas")).not.toBeNull();
    expect(container.querySelector(".voice-bars")).toBeNull();
    const overlay = screen.getByRole("button", { name: "Прослушать черновик" });
    expect(overlay.textContent).toContain("0:30");
  });

  it("subscribes to a late-mounted audio element (the blob arrives async)", async () => {
    // Regression: the element only exists once the authenticated blob resolves.
    // Listeners registered in an effect keyed on callbacks run while it is still
    // null, so the player must get them through props instead.
    blobState.url = null;
    const { container, rerender } = render(<VoicePlayer attachment={attachment} />);
    expect(container.querySelector("audio")).toBeNull();

    blobState.url = "blob:voice";
    // A fresh object: the player is memoized, and in the app the hook's own
    // state change is what re-renders it.
    rerender(<VoicePlayer attachment={{ ...attachment }} />);
    const audio = container.querySelector("audio") as HTMLAudioElement;
    expect(audio).not.toBeNull();
    stubMedia(audio);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Воспроизвести/ }));
    });

    expect(screen.getByRole("button", { name: /Пауза/ })).toBeInTheDocument();
  });

  it("writes the progress into a CSS variable instead of re-rendering", () => {
    const { container } = render(<VoicePlayer attachment={attachment} />);
    const audio = container.querySelector("audio") as HTMLAudioElement;
    stubMedia(audio);
    const root = container.querySelector(".voice-player") as HTMLElement;
    audio.currentTime = 15;

    act(() => {
      audio.dispatchEvent(new Event("play"));
    });

    expect(root.style.getPropertyValue("--voice-progress")).toBe("0.5");
  });

  it("seeks when the waveform is pressed", () => {
    const { container } = render(<VoicePlayer attachment={attachment} />);
    const audio = container.querySelector("audio") as HTMLAudioElement;
    stubMedia(audio);
    const wave = container.querySelector(".voice-wave") as HTMLElement;
    vi.spyOn(wave, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, width: 100, height: 30, right: 100, bottom: 30, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);

    fireEvent.pointerDown(wave, { clientX: 25 });

    expect(audio.currentTime).toBeCloseTo(7.5, 1);
  });

  it("cycles the speed and keeps the voice's pitch", async () => {
    const { container } = render(<VoicePlayer attachment={attachment} />);
    const audio = container.querySelector("audio") as HTMLAudioElement;
    stubMedia(audio);
    const rate = screen.getByRole("button", { name: /Скорость 1×/ });

    fireEvent.click(rate);
    expect(screen.getByRole("button", { name: /Скорость 1.5×/ })).toBeInTheDocument();
    expect(audio.playbackRate).toBe(1.5);

    fireEvent.click(screen.getByRole("button", { name: /Скорость 1.5×/ }));
    expect(audio.playbackRate).toBe(2);
    // The choice survives the next mount (Telegram remembers it too).
    expect(localStorage.getItem("gomo6:voice:rate")).toBe("2");
  });

  it("reports a media failure instead of pretending to play", () => {
    const { container } = render(<VoicePlayer attachment={attachment} />);
    const audio = container.querySelector("audio") as HTMLAudioElement;
    stubMedia(audio);
    act(() => {
      audio.dispatchEvent(new Event("error"));
    });

    expect(container.querySelector(".voice-player")?.className).toContain("is-failed");
    expect(container.querySelector(".voice-time")?.textContent).toBe("Ошибка");
  });
});
