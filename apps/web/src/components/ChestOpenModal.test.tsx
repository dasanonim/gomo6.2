import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { MotionConfig } from "motion/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChestOpenModal } from "./ChestOpenModal";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function setupCatalog() {
  fetchMock.mockImplementation(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () =>
        Promise.resolve({
          success: true,
          data: {
            rarities: [
              { rarity: "common", color: "#9ca3af", image_url: "/c.png", opened_image_url: "/c_o.png" },
              { rarity: "unusual", color: "#22c55e", image_url: "/u.png", opened_image_url: "/u_o.png" },
            ],
            mechanics: [{ key: "rarity_chest", config: { attempts_per_tier: 5 } }],
          },
        }),
      text: () => Promise.resolve("{}"),
    }),
  );
}

function renderModal(tapChest: () => Promise<any>, props: Record<string, unknown> = {}) {
  const onApplied = vi.fn();
  const onProgress = vi.fn();
  const onExpired = vi.fn();
  const onClose = vi.fn();
  render(
    <MotionConfig reducedMotion="always">
      <ChestOpenModal
        title="Сундук"
        tapChest={tapChest}
        onApplied={onApplied}
        onProgress={onProgress}
        onExpired={onExpired}
        onClose={onClose}
        {...props}
      />
    </MotionConfig>,
  );
  return { onApplied, onProgress, onExpired, onClose };
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe("ChestOpenModal", () => {
  it("taps the server until the chest opens: fail shakes, upgrade flashes, reward lands", async () => {
    setupCatalog();
    const taps = [
      { type: "failed", rarity: "common", attempts_left: 4, attempts_total: 5 },
      { type: "upgraded", rarity: "unusual", attempts_left: 5, attempts_total: 5 },
      { type: "opened", rarity: "unusual", attempts_left: 0, attempts_total: 5, final_rarity: "unusual", drops: 60 },
    ];
    let n = 0;
    const { onApplied, onProgress, onClose } = renderModal(() => Promise.resolve(taps[Math.min(n++, taps.length - 1)]));

    // Dots from the catalog budget before the first tap.
    const dialog = await screen.findByRole("dialog");
    const chest = within(dialog).getByRole("button", { name: /Осталось попыток: 5 из 5/ });
    // 5 dots rendered.
    expect(dialog.querySelectorAll("span.rounded-full").length).toBe(5);

    fireEvent.click(chest);
    await waitFor(() => expect(onProgress).toHaveBeenCalledWith("common", 4));

    fireEvent.click(chest);
    await waitFor(() => expect(onProgress).toHaveBeenCalledWith("unusual", 5));

    fireEvent.click(chest);
    await waitFor(() => expect(onApplied).toHaveBeenCalledWith(60));
    expect(await within(dialog).findByText("+60")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1); // catalog only — taps go through tapChest

    // No take button, no cross: any click dismisses (reward is credited).
    fireEvent.click(within(dialog).getByText("+60"));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("resumes a mid-chest session from the snapshot", async () => {
    setupCatalog();
    const { onApplied } = renderModal(
      () => Promise.resolve({ type: "opened", rarity: "unusual", attempts_left: 0, attempts_total: 5, final_rarity: "unusual", drops: 40 }),
      { initialRarity: "unusual", initialAttempts: 2 },
    );
    const dialog = await screen.findByRole("dialog");
    within(dialog).getByRole("button", { name: /Осталось попыток: 2 из 5/ });
    fireEvent.click(within(dialog).getByRole("button", { name: /Осталось попыток: 2 из 5/ }));
    await waitFor(() => expect(onApplied).toHaveBeenCalledWith(40));
  });

  it("drops the row when the chest is already gone server-side", async () => {
    setupCatalog();
    const err = Object.assign(new Error("gone"), { status: 409 });
    const { onExpired, onClose } = renderModal(() => Promise.reject(err));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /Осталось попыток/ }));
    await waitFor(() => expect(onExpired).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
