import { renderHook, act } from "@testing-library/react";
import { describe, it, expect } from "vitest";

import { setTransitionStyle } from "@/lib/viewTransitions";

import { usePendingView, pendingViewClass } from "./usePendingView";

describe("usePendingView", () => {
  it("starts on the initial view", () => {
    const { result } = renderHook(() =>
      usePendingView<"section" | "feed">("section", "section"),
    );
    expect(result.current.shown).toBe("section");
    expect(result.current.isShown("section")).toBe(true);
    expect(result.current.isRendered("feed")).toBe(false);
  });

  it("keeps the previous view rendered until the target reports ready", () => {
    const { result, rerender } = renderHook(
      ({ target }: { target: "section" | "feed" }) => usePendingView(target, "section"),
      { initialProps: { target: "section" as "section" | "feed" } },
    );

    rerender({ target: "feed" });

    // The target is mounted but not shown; the previous view stays on screen.
    expect(result.current.isRendered("feed")).toBe(true);
    expect(result.current.isShown("feed")).toBe(false);
    expect(result.current.isRendered("section")).toBe(true);
    expect(result.current.isShown("section")).toBe(true);

    act(() => result.current.readyFor("feed")());

    expect(result.current.isShown("feed")).toBe(true);
    // The old view unmounts once it is neither the target nor shown.
    expect(result.current.isRendered("section")).toBe(false);
  });

  it("hands out a stable onReady per view", () => {
    const { result, rerender } = renderHook(() => usePendingView("feed", "feed"));
    const first = result.current.readyFor("feed");
    rerender();
    expect(result.current.readyFor("feed")).toBe(first);
  });

  it("does not re-run the swap for a view that is already on screen", () => {
    setTransitionStyle("none");
    const { result } = renderHook(() => usePendingView("section", "section"));
    act(() => result.current.readyFor("section")());
    // The view is already visible — the swap is a no-op, content may have been
    // swapped underneath by its own fetch.
    expect(result.current.shown).toBe("section");
  });
});

describe("pendingViewClass", () => {
  it("hides non-shown views and fades in the shown one", () => {
    expect(pendingViewClass(false)).toBe("hidden");
    expect(pendingViewClass(true)).toBe("view-fade-in");
  });

  it("no entrance at all when motion is off", () => {
    expect(pendingViewClass(true, "none")).toBe("");
    // Still hidden when it is not the shown view.
    expect(pendingViewClass(false, "none")).toBe("hidden");
  });
});
