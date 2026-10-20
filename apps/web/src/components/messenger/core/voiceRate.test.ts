import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  __resetVoiceRateForTests,
  getVoiceRate,
  nextVoiceRate,
  setVoiceRate,
  subscribeVoiceRate,
  VOICE_RATES,
} from "./voiceRate";

beforeEach(() => {
  localStorage.clear();
  __resetVoiceRateForTests();
});

describe("voice rate store", () => {
  it("defaults to 1×", () => {
    expect(getVoiceRate()).toBe(1);
  });

  it("persists the choice and notifies every mounted player", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeVoiceRate(listener);

    setVoiceRate(1.5);

    expect(getVoiceRate()).toBe(1.5);
    expect(localStorage.getItem("gomo6:voice:rate")).toBe("1.5");
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    setVoiceRate(2);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not notify when the value is unchanged", () => {
    const listener = vi.fn();
    subscribeVoiceRate(listener);
    setVoiceRate(1);
    expect(listener).not.toHaveBeenCalled();
  });

  it("cycles 0.5 → 1 → 1.5 → 2 → 0.5", () => {
    expect(VOICE_RATES).toEqual([0.5, 1, 1.5, 2]);
    expect(nextVoiceRate(0.5)).toBe(1);
    expect(nextVoiceRate(1)).toBe(1.5);
    expect(nextVoiceRate(1.5)).toBe(2);
    expect(nextVoiceRate(2)).toBe(0.5);
  });

  it("ignores a stored value that is not a supported rate", () => {
    localStorage.setItem("gomo6:voice:rate", "7");
    __resetVoiceRateForTests();
    expect(getVoiceRate()).toBe(1);
  });

  it("survives a private mode that throws on storage", () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("quota");
    };
    try {
      setVoiceRate(2);
      expect(getVoiceRate()).toBe(2);
    } finally {
      Storage.prototype.setItem = original;
    }
  });
});
