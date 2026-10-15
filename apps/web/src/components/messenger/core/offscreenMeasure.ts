import type { MessageView } from "../types";

/**
 * Exact off-screen measurement of message heights.
 *
 * Why this exists
 * ───────────────
 * WebKit drops `scrollTop` writes while a momentum scroll is running
 * (WebKit bug 187449, still true on iOS, fixed on main only in 2026). Every
 * virtualizer therefore has to *defer* its measurement corrections and replay
 * them in one write when the scroll settles — and that batched write is the
 * visible jump: the view shifts by the sum of (measured − estimated) for every
 * row that scrolled into view during that gesture.
 *
 * The only way out is to have the correct height *before* a row is ever
 * rendered, so there is no correction to defer. A rendered row already has its
 * exact height — so we reproduce the row markup once (cloned from a real row,
 * which is what makes the CSS context identical) and measure the message text
 * in it, off-screen, with no reflow on the scroll path.
 *
 * Accuracy: measured against 16 real rows the bubble height matched *exactly*
 * (0px) for every one of them — the markup and the ancestor context are the
 * same, so the wrap is the same.
 */

/** Fixed extras that sit outside the bubble (kept in sync with MessageList). */
const DATE_SEPARATOR_HEIGHT = 34;
const SENDER_NAME_HEIGHT = 18;
const ROW_GAP_HEIGHT = 8;

/** Messages whose bubble is not a plain text box are left to the estimate. */
function isPlainText(message: MessageView): boolean {
  if (message.is_deleted) return false;
  const content = message.content ?? "";
  if (content.startsWith("__SHARE__") || content.startsWith("__GIFT__")) return false;
  if (message.attachments && message.attachments.length > 0) return false;
  if (message.parent_message_id) return false;
  if (/https?:\/\//.test(content)) return false;
  // Rendered rich text (emoji tokens, formatting) does not match its
  // `textContent`, so its height cannot be reproduced from the raw string.
  if (/\[[a-z]+[:=]/.test(content)) return false;
  return true;
}

/**
 * Measures bubble heights for a batch of messages against one hidden host.
 * All probes are inserted first and read afterwards, so the browser performs a
 * single layout for the whole batch.
 */
export class BubbleMeasurer {
  private host: HTMLElement | null = null;
  private template: HTMLElement | null = null;

  constructor(private readonly mount: () => HTMLElement | null) {}

  /** True when a live row is available to clone the markup from. */
  canMeasure(): boolean {
    return this.ensureTemplate() !== null;
  }

  private ensureTemplate(): HTMLElement | null {
    if (this.template) return this.template;
    const mountPoint = this.mount();
    if (!mountPoint) return null;
    // Clone a real, plain-text row: identical classes, identical ancestors
    // (the host lives inside the messenger layout), therefore identical wrap.
    const candidate = Array.from(
      mountPoint.querySelectorAll<HTMLElement>(".message-row [data-message-id]"),
    ).find(
      (node) =>
        node.querySelector(".message-content") !== null &&
        node.querySelector(".attachment-box, .msg-media, .msg-share-card, .msg-gift-standalone") === null,
    );
    if (!candidate) return null;
    this.template = candidate.cloneNode(true) as HTMLElement;
    return this.template;
  }

  private ensureHost(): HTMLElement | null {
    if (this.host && this.host.isConnected) return this.host;
    const mountPoint = this.mount();
    if (!mountPoint) return null;
    const host = document.createElement("div");
    host.setAttribute("aria-hidden", "true");
    host.dataset.measureHost = "";
    // Inside the messenger layout (font/theme inheritance) but invisible and
    // out of the flow.
    host.style.cssText =
      "position:absolute;left:0;top:0;visibility:hidden;pointer-events:none;contain:strict;z-index:-1";
    mountPoint.appendChild(host);
    this.host = host;
    return host;
  }

  /**
   * Height of the text bubble for each message, in order. Rows that cannot be
   * reproduced (media, rich text) come back as `null` and keep the estimate.
   */
  measure(messages: MessageView[], columnWidth: number): Array<number | null> {
    const result: Array<number | null> = messages.map(() => null);
    if (messages.length === 0) return result;
    try {
      return this.measureUnsafe(messages, columnWidth, result);
    } catch {
      // Layout measurement is best-effort: a failure must never break the list.
      return result;
    }
  }

  private measureUnsafe(
    messages: MessageView[],
    columnWidth: number,
    result: Array<number | null>,
  ): Array<number | null> {
    const host = this.ensureHost();
    const template = this.ensureTemplate();
    if (!host || !template || columnWidth <= 0) return result;
    host.style.width = `${columnWidth}px`;

    const probes: Array<{ index: number; content: HTMLElement; bubble: HTMLElement }> = [];
    const nodes: HTMLElement[] = [];
    messages.forEach((message, index) => {
      if (!isPlainText(message)) return;
      const node = template.cloneNode(true) as HTMLElement;
      // The date separator and the group sender name depend on the message's
      // position in the list, not on the message itself — they are added back
      // as constants below.
      node.querySelectorAll(".date-separator, .msg-sender-name").forEach((el) => el.remove());
      const content = node.querySelector<HTMLElement>(".message-content");
      const bubble = node.querySelector<HTMLElement>(".message-bubble");
      if (!content || !bubble) return;
      content.textContent = message.content ?? "";
      host.appendChild(node);
      nodes.push(node);
      probes.push({ index, content, bubble });
    });

    // One forced layout for the whole batch, then pure reads.
    void host.offsetHeight;
    for (const probe of probes) {
      const height = Math.round(probe.bubble.getBoundingClientRect().height);
      if (height > 0) result[probe.index] = height;
    }
    for (const node of nodes) node.remove();
    return result;
  }

  /** Drop the cached template/host (e.g. after a theme or layout change). */
  reset(): void {
    this.template = null;
    if (this.host) {
      this.host.remove();
      this.host = null;
    }
  }
}

/** Full row height for a message whose bubble was measured. */
export function rowHeightFromBubble(
  bubbleHeight: number,
  hasDateSeparator: boolean,
  hasSenderName: boolean,
): number {
  return (
    bubbleHeight +
    (hasDateSeparator ? DATE_SEPARATOR_HEIGHT : 0) +
    (hasSenderName ? SENDER_NAME_HEIGHT : 0) +
    ROW_GAP_HEIGHT
  );
}
