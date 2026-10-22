import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileBottomNav } from "./MobileBottomNav";
import { useMessengerStore } from "@/stores/messengerStore";
import type { User } from "@/integrations/api/client";

const user = { id: "user-1", public_id: 17 } as User;

function renderNav(path: string, currentUser: User | null = user) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <MobileBottomNav user={currentUser} />
      <Routes>
        <Route path="*" element={null} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("MobileBottomNav", () => {
  const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");

  beforeEach(() => {
    useMessengerStore.setState({ conversations: [] });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get() {
        return this.classList?.contains("mobile-bottom-nav__rail") ? 408 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
      configurable: true,
      value: () => true,
    });
    Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    if (originalClientWidth) {
      Object.defineProperty(HTMLElement.prototype, "clientWidth", originalClientWidth);
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
    }
    Reflect.deleteProperty(HTMLElement.prototype, "setPointerCapture");
    Reflect.deleteProperty(HTMLElement.prototype, "hasPointerCapture");
    Reflect.deleteProperty(HTMLElement.prototype, "releasePointerCapture");
  });

  it("provides the four primary mobile destinations", () => {
    renderNav("/");

    expect(screen.getByRole("navigation", { name: "Основная навигация" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Лента" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "GomoSub" })).toHaveAttribute("href", "/g");
    expect(screen.getByRole("link", { name: "Чаты" })).toHaveAttribute("href", "/messages");
    expect(screen.getByRole("link", { name: "Профиль" })).toHaveAttribute("href", "/profile/17");
  });

  it("keeps the matching top-level tab selected on nested routes", () => {
    renderNav("/g/my-community/c/general");

    expect(screen.getByRole("link", { name: "GomoSub" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Лента" })).not.toHaveAttribute("aria-current");
  });

  it("points guests to sign-in for the profile tab", () => {
    renderNav("/", null);

    expect(screen.getByRole("link", { name: "Профиль" })).toHaveAttribute("href", "/auth");
  });

  it("drags the selected pill to a tab and navigates when released", () => {
    renderNav("/");
    const rail = document.querySelector(".mobile-bottom-nav__rail")!;
    const feedTab = screen.getByRole("link", { name: "Лента" });

    fireEvent.pointerDown(feedTab, {
      pointerId: 7,
      button: 0,
      clientX: 55,
      clientY: 20,
    });
    fireEvent.pointerMove(rail, {
      pointerId: 7,
      button: -1,
      clientX: 175,
      clientY: 20,
    });
    fireEvent.pointerUp(rail, {
      pointerId: 7,
      button: 0,
      clientX: 175,
      clientY: 20,
    });

    expect(screen.getByRole("link", { name: "GomoSub" })).toHaveAttribute("aria-current", "page");
  });
});
