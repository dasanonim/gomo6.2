import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { VoiceRecorder } from "./VoiceRecorder";

const { mockUpload, mockToast, mockHaptics, mockWaveform } = vi.hoisted(() => ({
  mockUpload: vi.fn(),
  mockToast: { error: vi.fn(), success: vi.fn() },
  mockHaptics: { tick: vi.fn(), success: vi.fn() },
  mockWaveform: vi.fn(async () => [12, 40, 80]),
}));

vi.mock("@/services/messengerApi", () => ({
  messengerApi: { uploadFile: (...args: unknown[]) => mockUpload(...args) },
}));
vi.mock("sonner", () => ({ toast: mockToast }));
vi.mock("@/lib/haptics", () => ({ hapticTick: mockHaptics.tick, hapticSuccess: mockHaptics.success }));
vi.mock("./voice", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./voice")>();
  return { ...actual, extractWaveform: mockWaveform };
});

// ─── A recorder the browser does not provide in jsdom ──────────────────────
class FakeMediaRecorder {
  static isTypeSupported = (mime: string) => mime.startsWith("audio/webm");
  /** What the "browser" opens when nothing is requested. */
  static defaultMime = "audio/webm";
  /** Requested containers this "browser" refuses to construct (Safari quirk). */
  static refuseRequested = false;
  /** WebKit habit: the final `dataavailable` fires AFTER the `stop` event. */
  static lateFinalChunk = false;
  state: "inactive" | "recording" = "inactive";
  mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners: Record<string, Array<() => void>> = {};

  constructor(_stream: unknown, options?: { mimeType?: string }) {
    if (options?.mimeType && FakeMediaRecorder.refuseRequested) {
      throw new DOMException("unsupported", "NotSupportedError");
    }
    this.mimeType = options?.mimeType ?? FakeMediaRecorder.defaultMime;
  }
  addEventListener(type: string, callback: () => void) {
    (this.listeners[type] ??= []).push(callback);
  }
  start() {
    this.state = "recording";
    if (FakeMediaRecorder.lateFinalChunk) {
      // A first chunk while recording, the rest only at stop.
      setTimeout(() => this.ondataavailable?.({ data: new Blob(["head-bytes"], { type: "audio/webm" }) }), 5);
    }
  }
  stop() {
    this.state = "inactive";
    if (FakeMediaRecorder.lateFinalChunk) {
      (this.listeners.stop ?? []).forEach((callback) => callback());
      setTimeout(() => this.ondataavailable?.({ data: new Blob(["tail-bytes"], { type: "audio/webm" }) }), 20);
      return;
    }
    this.ondataavailable?.({ data: new Blob(["voice-bytes"], { type: "audio/webm" }) });
    (this.listeners.stop ?? []).forEach((callback) => callback());
  }
}

function fakeStream() {
  return { getTracks: () => [{ stop: vi.fn() }], getAudioTracks: () => [{ getSettings: () => ({}) }] } as unknown as MediaStream;
}

let now = 0;

beforeEach(() => {
  now = 0;
  // jsdom reports an insecure context by default; the recorder refuses that on
  // purpose (a phone on http://192.168.x.x has no getUserMedia at all).
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  FakeMediaRecorder.defaultMime = "audio/webm";
  FakeMediaRecorder.refuseRequested = false;
  FakeMediaRecorder.lateFinalChunk = false;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => fakeStream()) },
  });
  mockUpload.mockReset().mockResolvedValue({ path: "u1/messenger/voice-1.webm" });
  mockWaveform.mockClear();
  mockToast.error.mockClear();
  mockHaptics.tick.mockClear();
  mockHaptics.success.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const mic = () => screen.getByRole("button", { name: "Записать голосовое" });

async function pressMic() {
  fireEvent.pointerDown(mic(), { pointerId: 1, clientX: 10, clientY: 10, button: 0, pointerType: "mouse" });
  // getUserMedia resolves on a microtask
  await act(async () => {
    await Promise.resolve();
  });
}

describe("VoiceRecorder", () => {
  it("records, then uploads and hands the parent a voice attachment", async () => {
    const onSend = vi.fn();
    render(<VoiceRecorder onSend={onSend} />);

    await pressMic();
    await screen.findByText(/Отпусти — отправить/);

    now = 2400; // 2.4s of speech
    fireEvent.pointerUp(window);

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    const attachment = onSend.mock.calls[0][0];
    const meta = JSON.parse(attachment.meta);
    expect(attachment.type).toBe("audio");
    expect(attachment.url).toBe("u1/messenger/voice-1.webm");
    expect(attachment.mime).toContain("audio/webm");
    expect(meta.voice).toBe(true);
    expect(meta.duration).toBeCloseTo(2.4, 1);
    // The waveform comes from the finished file, not the live preview.
    expect(mockWaveform).toHaveBeenCalledTimes(1);
    expect(meta.waveform.length).toBeGreaterThan(0);
    expect(mockHaptics.success).toHaveBeenCalledTimes(1);
  });

  it("keeps a final chunk the browser delivers after `stop` (WebKit)", async () => {
    // The truncation bug: the note played ~0.5s and went silent because only
    // the early timeslice made it into the upload.
    FakeMediaRecorder.lateFinalChunk = true;
    const onSend = vi.fn();
    render(<VoiceRecorder onSend={onSend} />);

    await pressMic();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    now = 1500;
    fireEvent.pointerUp(window);

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1), { timeout: 3000 });
    // Both chunks ("head-bytes" + "tail-bytes") are in the upload.
    expect(onSend.mock.calls[0][0].size).toBe(20);
  });

  it("drops a mis-tap instead of sending an empty voice message", async () => {
    const onSend = vi.fn();
    render(<VoiceRecorder onSend={onSend} />);

    await pressMic();
    now = 200;
    fireEvent.pointerUp(window);

    await waitFor(() => expect(mic()).toBeInTheDocument());
    expect(onSend).not.toHaveBeenCalled();
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("cancels when the finger slides left", async () => {
    const onSend = vi.fn();
    render(<VoiceRecorder onSend={onSend} />);

    await pressMic();
    now = 1500;
    fireEvent.pointerMove(window, { clientX: -140, clientY: 8 });
    await screen.findByText("Отпусти — отмена");
    fireEvent.pointerUp(window);

    await waitFor(() => expect(mic()).toBeInTheDocument());
    expect(onSend).not.toHaveBeenCalled();
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("locks when the finger slides up: releasing does not stop, the send button does", async () => {
    const onSend = vi.fn();
    render(<VoiceRecorder onSend={onSend} />);

    await pressMic();
    fireEvent.pointerMove(window, { clientX: 12, clientY: -120 });
    await screen.findByText(/Идёт запись/);

    now = 1800;
    fireEvent.pointerUp(window);
    // Still recording after the finger left.
    expect(screen.getByText(/Идёт запись/)).toBeInTheDocument();
    expect(onSend).not.toHaveBeenCalled();

    now = 2200;
    fireEvent.click(screen.getByRole("button", { name: "Отправить голосовое" }));

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  });

  it("explains a denied microphone instead of failing silently", async () => {
    const denied = Object.assign(new Error("denied"), { name: "NotAllowedError" });
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockRejectedValueOnce(denied);
    const onSend = vi.fn();
    render(<VoiceRecorder onSend={onSend} />);

    await pressMic();

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith(expect.stringMatching(/микрофон/i)));
    expect(mic()).toBeInTheDocument();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("records in the container the browser actually chose (Safari: mp4/AAC)", async () => {
    // Safari supports no webm: `pickVoiceMimeType` finds nothing, the recorder
    // constructs with no options and opens mp4 — the attachment must say so.
    FakeMediaRecorder.isTypeSupported = () => false;
    FakeMediaRecorder.defaultMime = "audio/mp4";
    const onSend = vi.fn();
    render(<VoiceRecorder onSend={onSend} />);

    await pressMic();
    now = 1500;
    fireEvent.pointerUp(window);

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    const attachment = onSend.mock.calls[0][0];
    expect(attachment.mime).toBe("audio/mp4");
    expect(attachment.name.endsWith(".m4a")).toBe(true);
  });

  it("falls back to the browser default when the requested container is refused", async () => {
    // Safari threw on `new MediaRecorder(stream, { mimeType })` even though it
    // reported the type as supported.
    FakeMediaRecorder.refuseRequested = true;
    const onSend = vi.fn();
    render(<VoiceRecorder onSend={onSend} />);

    await pressMic();
    now = 1200;
    fireEvent.pointerUp(window);

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0][0].mime).toContain("audio/");
  });

  it("releases the microphone when no recorder can be built", async () => {
    FakeMediaRecorder.refuseRequested = true;
    const stream = fakeStream();
    const stop = vi.fn();
    (stream.getTracks as unknown as () => Array<{ stop: () => void }>) = () => [{ stop }];
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockResolvedValueOnce(stream);
    // No options AND the default constructor also fails.
    const Original = FakeMediaRecorder;
    vi.stubGlobal("MediaRecorder", class extends Original {
      constructor(...args: ConstructorParameters<typeof Original>) {
        if (!(args[1] as { mimeType?: string } | undefined)?.mimeType) throw new DOMException("nope", "NotSupportedError");
        super(...args);
      }
    });
    const onSend = vi.fn();
    render(<VoiceRecorder onSend={onSend} />);

    await pressMic();

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith(expect.stringMatching(/формат/i)));
    expect(stop).toHaveBeenCalled();
    expect(mic()).toBeInTheDocument();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("surfaces the server's own reason when the upload is rejected", async () => {
    mockUpload.mockRejectedValueOnce(new Error("file type not allowed: .bin"));
    render(<VoiceRecorder onSend={vi.fn()} />);

    await pressMic();
    now = 1500;
    fireEvent.pointerUp(window);

    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith(
        expect.stringContaining("file type not allowed"),
      ),
    );
  });

  it("explains an insecure origin instead of blaming the browser", async () => {
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: false });
    const onSend = vi.fn();
    render(<VoiceRecorder onSend={onSend} />);

    await pressMic();

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith(expect.stringMatching(/HTTPS/)));
    expect(mic()).toBeInTheDocument();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("is hidden while the composer is busy", () => {
    const { rerender } = render(<VoiceRecorder onSend={vi.fn()} />);
    expect(mic()).toBeEnabled();
    rerender(<VoiceRecorder onSend={vi.fn()} disabled />);
    expect(mic()).toBeDisabled();
  });
});
