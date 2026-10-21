import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MAX_RING_SEGMENTS, StoryRing } from "./StoryRing";

const segments = () => Array.from(document.querySelectorAll("[data-segment]"));
const readSegments = () => segments().filter((el) => el.getAttribute("data-read") === "true");

describe("StoryRing", () => {
  it("draws one arc per live slide", () => {
    render(
      <StoryRing total={3} read={1}>
        <span>avatar</span>
      </StoryRing>,
    );
    expect(segments()).toHaveLength(3);
    expect(readSegments()).toHaveLength(1);
    expect(screen.getByText("avatar")).toBeInTheDocument();
  });

  it("draws nothing around an owner without stories", () => {
    render(
      <StoryRing total={0}>
        <span>avatar</span>
      </StoryRing>,
    );
    expect(segments()).toHaveLength(0);
    expect(screen.queryByTestId("story-ring-svg")).toBeNull();
  });

  it("marks every slide read once all are seen", () => {
    render(
      <StoryRing total={2} read={2}>
        <span>avatar</span>
      </StoryRing>,
    );
    expect(readSegments()).toHaveLength(2);
  });

  it("caps the arc count but keeps the read proportion", () => {
    render(
      <StoryRing total={100} read={50}>
        <span>avatar</span>
      </StoryRing>,
    );
    expect(segments()).toHaveLength(MAX_RING_SEGMENTS);
    expect(readSegments()).toHaveLength(MAX_RING_SEGMENTS / 2);
  });

  it("switches the gradient stops for close friends", () => {
    const { container } = render(
      <StoryRing total={1} closeFriends>
        <span>avatar</span>
      </StoryRing>,
    );
    const stops = Array.from(container.querySelectorAll("stop")).map((s) => s.getAttribute("stop-color"));
    expect(stops).toEqual(["var(--story-ring-close-from)", "var(--story-ring-close-to)"]);
  });

  it("ignores a read count above the total", () => {
    render(
      <StoryRing total={2} read={99}>
        <span>avatar</span>
      </StoryRing>,
    );
    expect(readSegments()).toHaveLength(2);
  });
});
