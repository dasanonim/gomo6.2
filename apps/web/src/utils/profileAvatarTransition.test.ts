import { describe, expect, it } from "vitest";
import { readProfileAvatarOrigin } from "./profileAvatarTransition";

describe("readProfileAvatarOrigin", () => {
  it("reads a complete avatar origin from route state", () => {
    expect(readProfileAvatarOrigin({
      originAvatarRect: { x: 12, y: 20, width: 40, height: 40 },
      originAvatarSrc: "/storage/avatar.jpg",
    })).toEqual({
      from: { x: 12, y: 20, width: 40, height: 40 },
      src: "/storage/avatar.jpg",
    });
  });

  it.each([
    null,
    {},
    { originAvatarSrc: "/avatar.jpg" },
    { originAvatarRect: { x: 0, y: 0, width: 0, height: 20 }, originAvatarSrc: "/avatar.jpg" },
    { originAvatarRect: { x: 0, y: 0, width: 20, height: 20 }, originAvatarSrc: "" },
  ])("ignores invalid route state: %o", (state) => {
    expect(readProfileAvatarOrigin(state)).toBeNull();
  });
});
