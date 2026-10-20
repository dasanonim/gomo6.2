import { useEffect, useState } from "react";

/**
 * Extracts evenly spaced frames from a local video for the composer's timeline.
 *
 * A separate, muted <video> is used so seeking for thumbnails never disturbs
 * the preview the user is watching. Frames are returned as JPEG data URLs; an
 * empty array means "not ready yet" (the timeline then shows a plain track).
 */
export function useVideoFrames(src: string | null, count = 8): string[] {
  const [frames, setFrames] = useState<string[]>([]);

  useEffect(() => {
    if (!src) {
      setFrames([]);
      return;
    }
    let cancelled = false;
    const video = document.createElement("video");
    video.src = src;
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");

    const seek = (time: number) =>
      new Promise<void>((resolve) => {
        if (Math.abs(video.currentTime - time) < 0.01) {
          resolve();
          return;
        }
        const onSeeked = () => {
          video.removeEventListener("seeked", onSeeked);
          resolve();
        };
        video.addEventListener("seeked", onSeeked);
        try {
          video.currentTime = time;
        } catch {
          video.removeEventListener("seeked", onSeeked);
          resolve();
        }
      });

    const run = async () => {
      if (!video.videoWidth || !context) return;
      const ratio = video.videoHeight && video.videoWidth ? video.videoHeight / video.videoWidth : 1.6;
      canvas.width = 96;
      canvas.height = Math.max(48, Math.round(96 * ratio));
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      if (duration <= 0) return;

      const shots: string[] = [];
      for (let i = 0; i < count; i += 1) {
        if (cancelled) return;
        await seek((duration * i) / count);
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        shots.push(canvas.toDataURL("image/jpeg", 0.6));
      }
      if (!cancelled) setFrames(shots);
    };

    video.addEventListener("loadeddata", () => void run());
    return () => {
      cancelled = true;
      video.removeAttribute("src");
      video.load();
    };
  }, [src, count]);

  return frames;
}
