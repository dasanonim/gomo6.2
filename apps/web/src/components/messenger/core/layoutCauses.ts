/**
 * The properties and methods that force the browser to lay out the document.
 *
 * Ported from Telegram Web (`lib/fasterdom/layoutCauses.ts`), which in turn
 * credits Paul Irish's list (https://gist.github.com/paulirish/5d52fb081b3570c81e3a).
 *
 * `fasterdom` patches exactly these in a dev build and complains when one of them
 * is touched while the mutation phase is running: at that point the pass has
 * already written to the DOM, so a read forces a synchronous reflow — which is the
 * whole thing the batched pass exists to avoid. A property read from a *measure*
 * phase (or from anywhere outside a pass, where the phase is `measure` by default)
 * is not reported: that is what the phase is for.
 */

export default {
  Element: {
    props: [
      "clientLeft", "clientTop", "clientWidth", "clientHeight",
      "scrollWidth", "scrollHeight", "scrollLeft", "scrollTop",
    ] as const,
    methods: [
      "getClientRects", "getBoundingClientRect",
      "scrollBy", "scrollTo", "scrollIntoView", "scrollIntoViewIfNeeded",
    ] as const,
  },
  HTMLElement: {
    props: [
      "offsetLeft", "offsetTop", "offsetWidth", "offsetHeight", "offsetParent",
      "innerText",
    ] as const,
    methods: ["focus"] as const,
  },
  window: {
    props: ["scrollX", "scrollY", "innerHeight", "innerWidth"] as const,
    methods: ["getComputedStyle"] as const,
  },
  VisualViewport: {
    props: ["height", "width", "offsetTop", "offsetLeft"] as const,
  },
  Document: {
    props: ["scrollingElement"] as const,
    methods: ["elementFromPoint"] as const,
  },
  HTMLInputElement: {
    methods: ["select"] as const,
  },
  MouseEvent: {
    props: ["layerX", "layerY", "offsetX", "offsetY"] as const,
  },
  Range: {
    methods: ["getClientRects", "getBoundingClientRect"] as const,
  },
};
