import { FileText, Image as ImageIcon, Mic, Video } from "lucide-react";
import type { Attachment } from "../types";

/** Human-readable file size: bytes / KB / MB. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The icon for an attachment chip / file card, by attachment type.
 *
 * Single source of truth: the composer and the message content each used to
 * carry their own copy, and they had already drifted — the composer's copy was
 * missing the `video` case, so video attachments showed a generic file icon
 * there.
 */
export function getAttachmentIcon(type: Attachment["type"]) {
  switch (type) {
    case "image":
      return <ImageIcon size={16} />;
    case "video":
      return <Video size={16} />;
    case "audio":
      return <Mic size={16} />;
    default:
      return <FileText size={16} />;
  }
}
