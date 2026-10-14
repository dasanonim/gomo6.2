import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { formatFileSize, getAttachmentIcon } from "./display";

describe("formatFileSize", () => {
  it("formats bytes, KB and MB", () => {
    expect(formatFileSize(0)).toBe("0 B");
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(1024)).toBe("1.0 KB");
    expect(formatFileSize(1536)).toBe("1.5 KB");
    expect(formatFileSize(1024 * 1024)).toBe("1.0 MB");
    expect(formatFileSize(2.5 * 1024 * 1024)).toBe("2.5 MB");
  });
});

describe("getAttachmentIcon", () => {
  it("renders an icon for every attachment type (including video)", () => {
    for (const type of ["image", "video", "audio", "file"] as const) {
      const { container } = render(<>{getAttachmentIcon(type)}</>);
      expect(container.querySelector("svg")).not.toBeNull();
    }
  });
});
