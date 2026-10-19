import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import type { Attachment } from "./types";
import { useAuthenticatedAttachmentUrl } from "./attachmentMedia";
import { formatVoiceTime, parseVoiceMeta } from "./voice";
import { hapticTick } from "@/lib/haptics";

// ─── Voice message player ───────────────────────────────────────────────────
// Telegram's player, not `<audio controls>`: a round play button, the
// waveform with a played fill, the elapsed/total time and a speed pill.
//
// Two rules make it feel smooth and cheap:
//  • the progress is written straight to a CSS variable from a rAF loop, so a
//    playing message never re-renders React (a list of 40 bubbles with one
//    playing would otherwise re-render 60 times a second);
//  • only one voice plays at a time: starting a second one pauses the first.

/** The element that is currently playing — a voice message at a time, like TG. */
let currentAudio: HTMLAudioElement | null = null;

const SPEEDS = [1, 1.5, 2] as const;
const RATE_KEY = "gomo6:voice:rate";

function readRate(): number {
  try {
    const stored = Number(localStorage.getItem(RATE_KEY));
    return SPEEDS.includes(stored as (typeof SPEEDS)[number]) ? stored : 1;
  } catch {
    return 1;
  }
}

interface Props {
  attachment: Attachment;
  isMine?: boolean;
  /** Whose voice it is, for the screen-reader label. */
  from?: string;
}

export const VoicePlayer = memo(function VoicePlayer({ attachment, isMine = false, from }: Props) {
  const meta = parseVoiceMeta(attachment);
  const duration = meta?.duration ?? 0;
  const bars = meta?.waveform ?? [];

  // The blob is authenticated (fetched with the session cookie) and cached by
  // the shared attachment cache, so remounting a scrolled-away bubble is free.
  // `enabled` lets the player ask for another attempt: the first one can land
  // in the window between "object uploaded" and "attachment row committed".
  const [loadEnabled, setLoadEnabled] = useState(true);
  const url = useAuthenticatedAttachmentUrl(attachment, attachment.url, loadEnabled);
  const retriedRef = useRef(false);
  const retryLoad = useCallback(() => {
    setLoadEnabled(false);
    requestAnimationFrame(() => setLoadEnabled(true));
  }, []);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const waveRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const draggingRef = useRef(false);

  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState<number>(() => readRate());
  const [elapsed, setElapsed] = useState(0);
  const [failed, setFailed] = useState(false);

  const paint = useCallback(() => {
    const audio = audioRef.current;
    const root = rootRef.current;
    if (!audio || !root) return;
    const total = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : duration;
    const progress = total > 0 ? Math.min(1, Math.max(0, audio.currentTime / total)) : 0;
    root.style.setProperty("--voice-progress", String(progress));
    // The label follows whole seconds only: 60 text updates a second would be
    // wasted renders for a string that changes once a second.
    setElapsed((previous) => (Math.abs(previous - audio.currentTime) >= 0.9 ? audio.currentTime : previous));
  }, [duration]);

  const stopLoop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const loop = useCallback(() => {
    paint();
    rafRef.current = requestAnimationFrame(loop);
  }, [paint]);

  const pause = useCallback(() => {
    audioRef.current?.pause();
  }, []);

  const play = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio || !url) return;
    try {
      if (currentAudio && currentAudio !== audio) currentAudio.pause();
      currentAudio = audio;
      audio.playbackRate = rate;
      // Voice pitch must not rise with the speed (Chrome/Safari support it).
      audio.preservesPitch = true;
      await audio.play();
      hapticTick(4);
    } catch {
      setFailed(true);
    }
  }, [rate, url]);

  const toggle = useCallback(() => {
    if (failed) {
      setFailed(false);
      retryLoad();
      return;
    }
    if (playing) pause();
    else void play();
  }, [failed, pause, play, playing, retryLoad]);

  const seekTo = useCallback((ratio: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const total = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : duration;
    if (!(total > 0)) return;
    audio.currentTime = Math.min(total, Math.max(0, ratio * total));
    paint();
  }, [duration, paint]);

  const ratioFromEvent = useCallback((clientX: number) => {
    const wave = waveRef.current;
    if (!wave) return 0;
    const rect = wave.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  }, []);

  const handleWavePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    draggingRef.current = true;
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      /* Safari throws for a stale pointer id; dragging still works via props */
    }
    seekTo(ratioFromEvent(event.clientX));
  }, [ratioFromEvent, seekTo]);

  const handleWavePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    seekTo(ratioFromEvent(event.clientX));
  }, [ratioFromEvent, seekTo]);

  const handleWavePointerUp = useCallback(() => {
    draggingRef.current = false;
  }, []);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      toggle();
      return;
    }
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const audio = audioRef.current;
      if (!audio) return;
      const total = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : duration;
      audio.currentTime = Math.min(total, Math.max(0, audio.currentTime + (event.key === "ArrowRight" ? 5 : -5)));
      paint();
    }
  }, [duration, paint, toggle]);

  const cycleRate = useCallback(() => {
    const next = SPEEDS[(SPEEDS.indexOf(rate as (typeof SPEEDS)[number]) + 1) % SPEEDS.length];
    setRate(next);
    try {
      localStorage.setItem(RATE_KEY, String(next));
    } catch {
      /* private mode */
    }
    const audio = audioRef.current;
    if (audio) audio.playbackRate = next;
    hapticTick(4);
  }, [rate]);

  // The audio element's own events are the only truth for the UI state: a
  // paused-by-another-player message must show its play glyph again.
  //
  // They are React props on the element, not listeners registered in an effect:
  // the element is mounted lazily (only once its blob URL exists), so an effect
  // keyed on the callbacks would run while `audioRef.current` is still null and
  // never subscribe at all — the play glyph would never flip and the progress
  // would never move, even though the audio was playing.
  const handlePlay = useCallback(() => {
    setPlaying(true);
    setFailed(false);
    stopLoop();
    loop();
  }, [loop, stopLoop]);

  const handlePause = useCallback(() => {
    setPlaying(false);
    stopLoop();
    const audio = audioRef.current;
    if (audio) setElapsed(audio.currentTime);
    paint();
  }, [paint, stopLoop]);

  const handleEnded = useCallback(() => {
    setPlaying(false);
    stopLoop();
    const audio = audioRef.current;
    if (audio) {
      audio.currentTime = 0;
      if (currentAudio === audio) currentAudio = null;
    }
    setElapsed(0);
    paint();
  }, [paint, stopLoop]);

  const handleError = useCallback(() => setFailed(true), []);

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = rate;
  }, [rate]);

  useEffect(() => {
    paint();
  }, [paint]);

  // One automatic retry, once: a transient 403/network error must not leave a
  // voice note permanently unplayable.
  useEffect(() => {
    if (url || retriedRef.current) return;
    retriedRef.current = true;
    const timer = setTimeout(retryLoad, 900);
    return () => clearTimeout(timer);
  }, [retryLoad, url]);

  useEffect(() => () => {
    stopLoop();
    const audio = audioRef.current;
    if (audio && currentAudio === audio) currentAudio = null;
  }, [stopLoop]);

  const total = duration || 0;
  const label = playing ? formatVoiceTime(elapsed) : formatVoiceTime(total);

  return (
    <div
      ref={rootRef}
      className={`voice-player${isMine ? " is-mine" : ""}${failed ? " is-failed" : ""}`}
      style={{ ["--voice-progress" as string]: 0 }}
      data-testid="voice-player"
    >
      <button
        type="button"
        className="voice-play"
        onClick={url ? toggle : retryLoad}
        disabled={false}
        aria-label={url
          ? `${playing ? "Пауза" : "Воспроизвести"} голосовое сообщение, ${formatVoiceTime(total)}${from ? `, ${from}` : ""}`
          : "Загрузить голосовое сообщение"}
        title={!url ? "Загрузить" : failed ? "Не удалось загрузить — нажми, чтобы повторить" : undefined}
      >
        {playing ? <Pause size={16} /> : <Play size={16} />}
      </button>

      <div className="voice-main">
        <div
          ref={waveRef}
          className="voice-wave"
          role="slider"
          tabIndex={0}
          aria-label="Позиция воспроизведения"
          aria-valuemin={0}
          aria-valuemax={Math.round(total)}
          aria-valuenow={Math.round(elapsed)}
          onPointerDown={handleWavePointerDown}
          onPointerMove={handleWavePointerMove}
          onPointerUp={handleWavePointerUp}
          onPointerCancel={handleWavePointerUp}
          onKeyDown={handleKeyDown}
        >
          <div className="voice-bars" aria-hidden="true">
            {bars.map((peak, index) => (
              <span key={index} className="voice-bar" style={{ ["--h" as string]: `${Math.max(8, peak)}%` }} />
            ))}
          </div>
          <div className="voice-bars is-played" aria-hidden="true">
            {bars.map((peak, index) => (
              <span key={index} className="voice-bar" style={{ ["--h" as string]: `${Math.max(8, peak)}%` }} />
            ))}
          </div>
        </div>

        <div className="voice-meta">
          <span className="voice-time">{failed ? "Ошибка" : label}</span>
          <button
            type="button"
            className="voice-rate"
            onClick={cycleRate}
            aria-label={`Скорость ${rate}×`}
          >
            {rate}×
          </button>
        </div>
      </div>

      {/* The element is mounted only once a blob URL exists, so iOS can honour
          `play()` synchronously inside the tap (no async src swap afterwards). */}
      {url && (
        // A voice message has no captions to offer — the waveform, the elapsed
        // time and the button's label are its accessible representation.
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <audio
          ref={audioRef}
          src={url}
          preload="auto"
          playsInline
          onPlay={handlePlay}
          onPause={handlePause}
          onEnded={handleEnded}
          onError={handleError}
          onLoadedMetadata={() => paint()}
        />
      )}
    </div>
  );
});
