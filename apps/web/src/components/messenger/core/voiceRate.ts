// ─── Voice playback rate (global, like Telegram's tab player) ──────────────
// Telegram keeps ONE rate for voice messages: change it while listening and it
// applies to the next note as well (`lastPlaybackRate` in the tab state). Every
// mounted player therefore reads from this store instead of keeping its own
// state, so a change is instant everywhere and survives a reload.

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "gomo6:voice:rate";

export const VOICE_RATES = [0.5, 1, 1.5, 2] as const;
export type VoiceRate = (typeof VOICE_RATES)[number];

function isRate(value: number): value is VoiceRate {
  return (VOICE_RATES as readonly number[]).includes(value);
}

function readStoredRate(): VoiceRate {
  try {
    const stored = Number(localStorage.getItem(STORAGE_KEY));
    return isRate(stored) ? stored : 1;
  } catch {
    return 1;
  }
}

let current: VoiceRate = readStoredRate();
const listeners = new Set<() => void>();

export function getVoiceRate(): VoiceRate {
  return current;
}

export function setVoiceRate(rate: VoiceRate): void {
  if (rate === current) return;
  current = rate;
  try {
    localStorage.setItem(STORAGE_KEY, String(rate));
  } catch {
    /* private mode — the in-memory value still works */
  }
  listeners.forEach((listener) => listener());
}

export function subscribeVoiceRate(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The next rate in the cycle: 0.5 → 1 → 1.5 → 2 → 0.5. */
export function nextVoiceRate(rate: VoiceRate): VoiceRate {
  const index = VOICE_RATES.indexOf(rate);
  return VOICE_RATES[(index + 1) % VOICE_RATES.length];
}

/** Only for tests: reset the module between cases. */
export function __resetVoiceRateForTests(): void {
  current = readStoredRate();
  listeners.clear();
}

export function useVoiceRate(): VoiceRate {
  return useSyncExternalStore(subscribeVoiceRate, getVoiceRate, getVoiceRate);
}
