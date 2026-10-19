import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, SendHorizontal, Trash2, Lock } from "lucide-react";
import { toast } from "sonner";
import { hapticSuccess, hapticTick } from "@/lib/haptics";
import { messengerApi } from "@/services/messengerApi";
import type { Attachment } from "./types";
import {
  VOICE_BARS,
  VOICE_MAX_BYTES,
  VOICE_MAX_SECONDS,
  extensionForMime,
  extractWaveform,
  formatVoiceTime,
  pickVoiceMimeType,
} from "./voice";

// ─── Voice recorder ────────────────────────────────────────────────────────
// Telegram's gesture, with its hard edge cases:
//
//   press the mic  → recording starts (the permission prompt is the only async
//                    step, and a release during it opens a hands-free recording
//                    instead of silently doing nothing);
//   release        → send;
//   slide left     → release cancels;
//   slide up       → lock: the finger can leave, the recording continues;
//   five minutes   → stop and send by itself.
//
// While recording the composer row is covered by the recording bar. Its
// waveform is written straight to the DOM in a rAF loop — 40 bars, no React
// state per frame — and the sent waveform is recomputed from the finished file,
// so the receiver draws what the sender actually recorded.

const CANCEL_DISTANCE_PX = 110;
const LOCK_DISTANCE_PX = 70;
/** Shorter than this is a mis-tap, not a message. */
const MIN_SENT_SECONDS = 0.6;
const TICK_MS = 100;
const BAR_INTERVAL_MS = 70;

type Phase = "idle" | "requesting" | "recording" | "uploading";

interface Props {
  /** Called with the uploaded attachment; the parent sends the message. */
  onSend: (attachment: Attachment) => void;
  /** The composer is busy (sending/uploading) — the mic stays inert. */
  disabled?: boolean;
  /** Hides the mic entirely (editing an existing message, for instance). */
  hidden?: boolean;
}

function describePermissionError(error: unknown): string {
  const name = (error as { name?: string } | null)?.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Нет доступа к микрофону — разреши его в настройках браузера";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "Микрофон не найден";
  }
  if (!window.isSecureContext) {
    return "Запись звука работает только по HTTPS или на localhost";
  }
  return "Не удалось начать запись";
}

export function VoiceRecorder({ onSend, disabled = false, hidden = false }: Props) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [locked, setLocked] = useState(false);
  const [cancelArmed, setCancelArmed] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeRef = useRef<string>("");
  const startedAtRef = useRef(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const rafRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const barsRef = useRef<HTMLDivElement | null>(null);
  const liveBarsRef = useRef<number[]>([]);
  const lastBarAtRef = useRef(0);
  const phaseRef = useRef<Phase>("idle");
  const lockedRef = useRef(false);
  const cancelRef = useRef(false);
  const pressRef = useRef<{ x: number; y: number; active: boolean } | null>(null);
  /** A release that happened while the permission prompt was open. */
  const releasedWhileRequestingRef = useRef(false);
  const finishingRef = useRef(false);

  phaseRef.current = phase;
  lockedRef.current = locked;
  cancelRef.current = cancelArmed;

  const paintBars = useCallback(() => {
    const holder = barsRef.current;
    if (!holder) return;
    const bars = liveBarsRef.current;
    const children = holder.children;
    for (let i = 0; i < children.length; i += 1) {
      const value = bars[Math.max(0, bars.length - VOICE_BARS + i)] ?? 0;
      (children[i] as HTMLElement).style.setProperty("--h", `${Math.max(6, value)}%`);
    }
  }, []);

  const stopTracks = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const teardown = useCallback(() => {
    if (tickRef.current !== null) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    void audioCtxRef.current?.close().catch(() => undefined);
    audioCtxRef.current = null;
    analyserRef.current = null;
    stopTracks();
    recorderRef.current = null;
    pressRef.current = null;
    releasedWhileRequestingRef.current = false;
    liveBarsRef.current = [];
  }, [stopTracks]);

  const reset = useCallback(() => {
    teardown();
    setPhase("idle");
    setLocked(false);
    setCancelArmed(false);
    setElapsed(0);
  }, [teardown]);

  useEffect(
    () => () => {
      teardown();
    },
    [teardown],
  );

  // ── Stop, then send or drop ──────────────────────────────────────────────
  const finish = useCallback(
    async (send: boolean) => {
      if (finishingRef.current) return;
      const recorder = recorderRef.current;
      if (!recorder) {
        reset();
        return;
      }
      finishingRef.current = true;

      const duration = (performance.now() - startedAtRef.current) / 1000;
      const stopped = new Promise<void>((resolve) => {
        recorder.addEventListener("stop", () => {
          // WebKit has shipped versions that fire the FINAL `dataavailable`
          // after `stop`. Reading the chunks right on `stop` kept only the
          // first timeslice — the note played ~0.5s and then went silent.
          // One macrotask is enough for that late chunk to land.
          setTimeout(resolve, 40);
        }, { once: true });
      });
      try {
        if (recorder.state !== "inactive") recorder.stop();
      } catch {
        /* already stopped */
      }
      await stopped;

      const mime = mimeRef.current;
      const chunks = chunksRef.current;
      chunksRef.current = [];
      const liveBars = [...liveBarsRef.current];
      teardown();

      if (!send || duration < MIN_SENT_SECONDS || chunks.length === 0) {
        finishingRef.current = false;
        reset();
        return;
      }

      const type = mime.split(";")[0] || "audio/webm";
      const blob = new Blob(chunks, { type });
      if (blob.size > VOICE_MAX_BYTES) {
        finishingRef.current = false;
        reset();
        toast.error("Голосовое слишком длинное для отправки");
        return;
      }

      setPhase("uploading");
      const extension = extensionForMime(mime);
      const file = new File([blob], `voice-${Date.now()}.${extension}`, { type });
      try {
        const waveform = (await extractWaveform(blob)) ?? liveBars;
        const uploaded = await messengerApi.uploadFile(file);
        onSend({
          url: uploaded.path,
          type: "audio",
          name: file.name,
          size: blob.size,
          mime: type,
          meta: JSON.stringify({ voice: true, duration, waveform }),
        });
        hapticSuccess();
      } catch (error) {
        // The server's own reason is worth surfacing: a rejected container, an
        // expired session and a size cap all look identical without it.
        const detail = error instanceof Error && error.message ? ` — ${error.message}` : "";
        console.warn("[voice] upload failed", { name: file.name, mime: type, size: blob.size }, error);
        toast.error(`Не удалось отправить голосовое${detail}`);
      } finally {
        finishingRef.current = false;
        reset();
      }
    },
    [onSend, reset, teardown],
  );

  // ── Sampling: one rAF loop for the live waveform, one tick for the timer ──
  const startLoops = useCallback(() => {
    const analyser = analyserRef.current;
    const buffer = analyser ? new Uint8Array(analyser.fftSize) : null;

    const frame = () => {
      const now = performance.now();
      if (analyser && buffer && now - lastBarAtRef.current >= BAR_INTERVAL_MS) {
        lastBarAtRef.current = now;
        analyser.getByteTimeDomainData(buffer);
        let sum = 0;
        for (let i = 0; i < buffer.length; i += 1) {
          const centred = (buffer[i] - 128) / 128;
          sum += centred * centred;
        }
        const rms = Math.sqrt(sum / buffer.length);
        // Same curve the file-based waveform uses, so the live preview and the
        // delivered bars look like the same voice.
        const value = Math.round(Math.min(100, Math.max(6, Math.pow(rms * 4.2, 0.75) * 100)));
        liveBarsRef.current.push(value);
        paintBars();
      }
      rafRef.current = requestAnimationFrame(frame);
    };
    rafRef.current = requestAnimationFrame(frame);

    startedAtRef.current = performance.now();
    tickRef.current = setInterval(() => {
      if ((phaseRef.current as Phase) !== "recording") return;
      const seconds = (performance.now() - startedAtRef.current) / 1000;
      setElapsed(seconds);
      if (seconds >= VOICE_MAX_SECONDS) {
        void finish(true);
      }
    }, TICK_MS);
  }, [paintBars, finish]);

  const cancel = useCallback(() => {
    hapticTick(10);
    void finish(false);
  }, [finish]);

  // ── Start ────────────────────────────────────────────────────────────────
  const start = useCallback(async () => {
    if (phaseRef.current !== "idle" || disabled) return;
    // On an insecure origin (a phone on http://192.168.x.x) the browser hides
    // `mediaDevices` entirely — saying "this browser cannot record" there is a
    // lie, and the fix is an https address, not another browser.
    if (!window.isSecureContext) {
      toast.error("Запись работает только по HTTPS или на localhost — открой https-адрес стенда");
      return;
    }
    const mime = pickVoiceMimeType();
    if (mime === null) {
      toast.error("Этот браузер не умеет записывать звук (нужен Safari 14.5+ или свежий Chrome)");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      toast.error("Браузер не даёт доступ к микрофону");
      return;
    }

    setPhase("requesting");
    releasedWhileRequestingRef.current = false;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (error) {
      releasedWhileRequestingRef.current = false;
      setPhase("idle");
      toast.error(describePermissionError(error));
      return;
    }
    if ((phaseRef.current as Phase) !== "requesting") {
      // The user left while the prompt was open.
      stream.getTracks().forEach((track) => track.stop());
      return;
    }

    streamRef.current = stream;
    chunksRef.current = [];
    liveBarsRef.current = [];
    lastBarAtRef.current = 0;

    // Safari refuses `new MediaRecorder(stream, { mimeType })` in some versions
    // even when `isTypeSupported` says yes, so the requested container is a
    // preference, not a demand: retry with the browser's own default.
    let recorder: MediaRecorder | null = null;
    const optionSets: (MediaRecorderOptions | undefined)[] = mime ? [{ mimeType: mime }, undefined] : [undefined];
    for (const options of optionSets) {
      try {
        recorder = new MediaRecorder(stream, options);
        break;
      } catch {
        recorder = null;
      }
    }
    if (!recorder) {
      stream.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setPhase("idle");
      toast.error("Не удалось начать запись в поддерживаемом формате");
      return;
    }

    // What the browser ACTUALLY opened wins: Safari records mp4/AAC even when
    // nothing was requested, and labelling that file "audio/webm" would upload
    // a lie (wrong extension, wrong mime) and break playback for the receiver.
    mimeRef.current = recorder.mimeType || mime || "";
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.onerror = () => {
      toast.error("Запись прервалась");
      void finish(false);
    };
    // No timeslice: the recorder buffers the note and hands it over whole at
    // stop. The live waveform comes from the analyser, so streaming chunks buy
    // nothing — and a partial chunk stream is exactly how a voice note ends up
    // truncated on WebKit.
    recorder.start();
    recorderRef.current = recorder;

    // Live levels. Failure to build the analyser must not break recording.
    try {
      const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (Ctor) {
        const context = new Ctor();
        const analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        context.createMediaStreamSource(stream).connect(analyser);
        audioCtxRef.current = context;
        analyserRef.current = analyser;
      }
    } catch {
      analyserRef.current = null;
    }

    setPhase("recording");
    setElapsed(0);
    hapticTick(8);
    startLoops();
  }, [disabled, finish, startLoops]);

  // A release that arrives while the permission prompt is still open opens a
  // hands-free recording: the user asked to record, and the prompt is ours to
  // wait for. Releasing later stops it through the send button.
  useEffect(() => {
    if (phase === "recording" && releasedWhileRequestingRef.current && !locked) {
      releasedWhileRequestingRef.current = false;
      setLocked(true);
    }
  }, [phase, locked]);

  // ── The gesture ──────────────────────────────────────────────────────────
  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    // Safari throws for a pointer id that is no longer active (and a test, or a
    // released finger, has exactly such an id). The gesture works regardless:
    // the move/up listeners live on the window.
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      /* not capturable */
    }
    // Drop the keyboard: the recording bar takes the row over, and a soft
    // keyboard would both cover it and keep the composer focused.
    const active = document.activeElement as HTMLElement | null;
    if (active && (active.isContentEditable || active.tagName === "INPUT" || active.tagName === "TEXTAREA")) {
      active.blur();
    }
    pressRef.current = { x: event.clientX, y: event.clientY, active: true };
    setLocked(false);
    setCancelArmed(false);
    void start();
  }, [start]);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const press = pressRef.current;
      if (!press?.active) return;
      const dx = event.clientX - press.x;
      const dy = event.clientY - press.y;
      if (!lockedRef.current && dy < -LOCK_DISTANCE_PX) {
        setLocked(true);
        hapticTick(10);
        return;
      }
      if (!lockedRef.current) setCancelArmed(dx < -CANCEL_DISTANCE_PX);
    };

    const onUp = () => {
      const press = pressRef.current;
      if (!press?.active) return;
      press.active = false;
      if ((phaseRef.current as Phase) === "requesting") {
        // Still waiting for the permission prompt — decide when it resolves.
        releasedWhileRequestingRef.current = true;
        return;
      }
      if ((phaseRef.current as Phase) !== "recording") return;
      if (lockedRef.current) return; // locked: the buttons take over
      if (cancelRef.current) cancel();
      else void finish(true);
    };

    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [cancel, finish]);

  // Leaving the page or the chat mid-recording must not leave the microphone
  // hot; a real recording (≥1s) is sent rather than thrown away.
  useEffect(() => {
    if (phase !== "recording") return;
    const onHidden = () => {
      if (document.visibilityState !== "hidden") return;
      void finish((performance.now() - startedAtRef.current) / 1000 >= 1);
    };
    document.addEventListener("visibilitychange", onHidden);
    return () => document.removeEventListener("visibilitychange", onHidden);
  }, [phase, finish]);

  if (hidden) return null;

  const recording = phase === "recording" || phase === "requesting";
  const busy = phase === "uploading";

  if (!recording && !busy) {
    return (
      <button
        type="button"
        className="composer-mic"
        disabled={disabled}
        aria-label="Записать голосовое"
        title="Голосовое сообщение"
        onPointerDown={handlePointerDown}
      >
        <Mic size={17} />
      </button>
    );
  }

  return (
    <div className={`voice-record${locked ? " is-locked" : ""}${cancelArmed ? " is-cancelling" : ""}${busy ? " is-busy" : ""}`}>
      <button
        type="button"
        className="voice-record-cancel"
        onClick={cancel}
        aria-label="Отменить запись"
        title="Отменить"
      >
        <Trash2 size={16} />
      </button>

      <div className="voice-record-body">
        <div className="voice-record-timer">
          <span className="voice-record-dot" aria-hidden="true" />
          <span className="voice-record-time" aria-live="off">{formatVoiceTime(elapsed)}</span>
          {locked && <Lock size={12} className="voice-record-lock" aria-label="Запись закреплена" />}
        </div>
        <div className="voice-record-wave" ref={barsRef} aria-hidden="true">
          {Array.from({ length: VOICE_BARS }).map((_, index) => (
            <span key={index} className="voice-record-bar" />
          ))}
        </div>
        <div className="voice-record-hint" aria-live="polite">
          {cancelArmed
            ? "Отпусти — отмена"
            : locked
              ? "Идёт запись — нажми, чтобы отправить"
              : "Отпусти — отправить · ← отмена · ↑ закрепить"}
        </div>
      </div>

      <button
        type="button"
        className={`composer-mic is-action${locked ? " is-send" : ""}`}
        onClick={locked ? () => void finish(true) : undefined}
        aria-label={locked ? "Отправить голосовое" : "Идёт запись"}
        title={locked ? "Отправить" : undefined}
      >
        {busy ? <span className="voice-record-spinner" aria-hidden="true" /> : locked ? <SendHorizontal size={16} /> : <Mic size={17} />}
      </button>
    </div>
  );
}
