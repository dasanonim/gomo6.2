import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CreateFab } from "./CreateFab";

describe("CreateFab", () => {
  it("renders with the given label and fires onClick", () => {
    const onClick = vi.fn();
    render(<CreateFab onClick={onClick} label="Создать тему" />);

    const button = screen.getByRole("button", { name: "Создать тему" });
    expect(button).toBeInTheDocument();

    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("forwards a custom right offset", () => {
    const { container } = render(
      <CreateFab onClick={() => {}} label="Написать" right="10px" />,
    );
    const fab = container.querySelector(".create-fab");
    expect(fab?.getAttribute("style")).toContain("right: 10px");
  });
});
