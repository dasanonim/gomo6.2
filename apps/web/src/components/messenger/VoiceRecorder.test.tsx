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
  state: "inactive" | "recording" = "inactive";
  mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  private listeners: Record<string, Array<() => void>> = {};

  constructor(_stream: unknown, options?: { mimeType?: string }) {
    this.mimeType = options?.mimeType ?? "audio/webm";
  }
  addEventListener(type: string, callback: () => void) {
    (this.listeners[type] ??= []).push(callback);
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
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

  it("is hidden while the composer is busy", () => {
    const { rerender } = render(<VoiceRecorder onSend={vi.fn()} />);
    expect(mic()).toBeEnabled();
    rerender(<VoiceRecorder onSend={vi.fn()} disabled />);
    expect(mic()).toBeDisabled();
  });
});
