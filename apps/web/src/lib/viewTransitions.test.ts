import { describe, it, expect } from "vitest";
import {
  DEFAULT_TRANSITION_STYLE,
  getTransitionStyle,
  transitionEnterClass,
  prefersReducedMotion,
  runViewTransition,
  setTransitionStyle,
  TRANSITION_STYLES,
  type TransitionStyle,
} from "./viewTransitions";

const saved = (value: string | null) => {
  if (value === null) localStorage.removeItem("transition-style");
  else localStorage.setItem("transition-style", value);
};

describe("transition style", () => {
  it("has exactly two positions — animated or off", () => {
    expect(TRANSITION_STYLES.map((s) => s.id)).toEqual(["fade", "none"]);
    expect(DEFAULT_TRANSITION_STYLE).toBe("fade");
  });

  it("reads the saved style", () => {
    saved("fade");
    expect(getTransitionStyle()).toBe("fade");
    saved("none");
    expect(getTransitionStyle()).toBe("none");
  });

  it("maps legacy styles (rise/slide/view-transition) onto «Есть анимации»", () => {
    for (const legacy of ["rise", "slide", "view-transition", "bogus"]) {
      saved(legacy);
      expect(getTransitionStyle()).toBe("fade");
    }
    saved(null);
    expect(getTransitionStyle()).toBe("fade");
  });

  it("broadcasts a change so live consumers update", () => {
    saved("fade");
    let seen: TransitionStyle | null = null;
    window.addEventListener("gomo6:transition-style", (event) => {
      seen = (event as CustomEvent<{ style: TransitionStyle }>).detail.style;
    });
    setTransitionStyle("none");
    expect(seen).toBe("none");
    setTransitionStyle("fade");
  });
});

describe("enterclass / motion preference", () => {
  it("animates in 'fade', adds nothing in 'none'", () => {
    expect(transitionEnterClass("fade")).toBe("view-fade-in");
    expect(transitionEnterClass("none")).toBe("");
  });

  it("'Без анимации' counts as reduced motion", () => {
    saved("none");
    expect(prefersReducedMotion()).toBe(true);
    saved("fade");
  });
});

describe("runViewTransition", () => {
  it("applies the update immediately — the container's entrance is the animation", () => {
    let ran = false;
    runViewTransition(() => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});
