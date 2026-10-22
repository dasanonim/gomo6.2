import type { ViewportRect } from "./domRect";

export interface ProfileAvatarOrigin {
  from: ViewportRect;
  src: string;
}

/** Read the one-shot avatar flight payload from React Router location state. */
export function readProfileAvatarOrigin(state: unknown): ProfileAvatarOrigin | null {
  if (!state || typeof state !== "object") return null;
  const candidate = state as { originAvatarRect?: unknown; originAvatarSrc?: unknown };
  const rect = candidate.originAvatarRect as Partial<ViewportRect> | null;
  if (
    !rect ||
    !Number.isFinite(rect.x) ||
    !Number.isFinite(rect.y) ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height) ||
    (rect.width ?? 0) <= 1 ||
    (rect.height ?? 0) <= 1 ||
    typeof candidate.originAvatarSrc !== "string" ||
    candidate.originAvatarSrc.length === 0 ||
    candidate.originAvatarSrc.length > 2048
  ) {
    return null;
  }

  return {
    from: {
      x: rect.x!,
      y: rect.y!,
      width: rect.width!,
      height: rect.height!,
    },
    src: candidate.originAvatarSrc,
  };
}
