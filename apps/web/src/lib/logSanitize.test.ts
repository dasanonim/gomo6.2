import { describe, expect, it } from "vitest";
import { sanitizeLog } from "./logSanitize";

describe("sanitizeLog", () => {
  it("strips CR and LF so a value cannot forge log lines", () => {
    expect(sanitizeLog("ok")).toBe("ok");
    expect(sanitizeLog("evil\nERROR forged line")).toBe("evilERROR forged line");
    expect(sanitizeLog("a\r\nb")).toBe("ab");
    expect(sanitizeLog("line1\rline2")).toBe("line1line2");
  });

  it("stringifies non-strings first", () => {
    expect(sanitizeLog(new Error("boom\nx"))).toBe("Error: boomx");
    expect(sanitizeLog(42)).toBe("42");
    expect(sanitizeLog(undefined)).toBe("undefined");
  });
});
