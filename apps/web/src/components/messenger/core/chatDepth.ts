export interface ChatUnderlayFrame {
  /** Pixel translation of the conversation list behind the chat panel. */
  x: number;
  /** Progress from 0 (chat closed) to 1 (chat fully open). */
  dim: number;
}

/**
 * Telegram-style depth for the mobile chat push. The list is driven by the
 * chat panel's own x value, so opening and an in-progress swipe-back are exact
 * inverses rather than two animations that can drift apart.
 */
export function getChatUnderlayFrame(
  panelX: number,
  viewportWidth: number,
  isMobile: boolean,
): ChatUnderlayFrame {
  if (!isMobile || !Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return { x: 0, dim: 0 };
  }

  const closedProgress = Math.max(0, Math.min(1, panelX / viewportWidth));
  const openProgress = 1 - closedProgress;
  return {
    x: openProgress === 0 ? 0 : -viewportWidth * 0.18 * openProgress,
    dim: openProgress,
  };
}
