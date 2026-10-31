import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MotionConfig } from "motion/react";
import { describe, it, expect, vi } from "vitest";
import { ChestOpenModal } from "./ChestOpenModal";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const STEPS = [
  { type: "failed", rarity: "common", attempts_left: 4 },
  { type: "upgraded", rarity: "unusual", attempts_left: 5 },
  { type: "opened", rarity: "unusual", attempts_left: 0 },
];

function setupCatalog() {
  mockFetch.mockImplementation((url: string) =>
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
            mechanics: [],
          },
        }),
      text: () => Promise.resolve("{}"),
    }),
  );
}

function renderModal(applied: (r: { drops: number }) => void = () => {}) {
  return render(
    <MotionConfig reducedMotion="always">
      <ChestOpenModal
        title="Сундук"
        openChest={() => Promise.resolve({ rarity: "unusual", drops: 60, steps: STEPS })}
        onApplied={applied}
        onClose={() => {}}
      />
    </MotionConfig>,
  );
}

describe("ChestOpenModal", () => {
  it("replays the server trace tap-by-tap and reveals the reward", async () => {
    setupCatalog();
    const applied = vi.fn();
    renderModal(applied);

    // The single secure call lands, the parent credits immediately.
    await waitFor(() => expect(applied).toHaveBeenCalledTimes(1));
    expect(applied).toHaveBeenCalledWith(
      expect.objectContaining({ rarity: "unusual", drops: 60 }),
    );

    // Three taps replay the three pre-rolled steps, no extra network.
    const chest = await screen.findByRole("button", { name: "Жми ещё" });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(screen.getByText("0 из 3")).toBeInTheDocument();

    fireEvent.click(chest);
    await waitFor(() => expect(screen.getByText("1 из 3")).toBeInTheDocument());
    fireEvent.click(chest);
    await waitFor(() => expect(screen.getByText("Редкость выросла! Жми дальше")).toBeInTheDocument());
    fireEvent.click(chest);

    await waitFor(() => expect(screen.getByText("+60")).toBeInTheDocument());
    expect(screen.getByText("Необычный")).toBeInTheDocument();
    expect(screen.getByText("Забрать")).toBeInTheDocument();
    // Still a single catalog fetch + zero open POSTs from the modal itself.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("opens at once when the server sends no trace (old build)", async () => {
    setupCatalog();
    render(
      <MotionConfig reducedMotion="always">
        <ChestOpenModal
          title="Сундук"
          openChest={() => Promise.resolve({ rarity: "rare", drops: 70 })}
          onApplied={() => {}}
          onClose={() => {}}
        />
      </MotionConfig>,
    );

    const chest = await screen.findByRole("button", { name: "Жми ещё" });
    fireEvent.click(chest);
    await waitFor(() => expect(screen.getByText("+70")).toBeInTheDocument());
  });

  it("shows the failure state when the open call rejects", async () => {
    setupCatalog();
    render(
      <MotionConfig reducedMotion="always">
        <ChestOpenModal
          title="Сундук"
          openChest={() => Promise.reject(new Error("nope"))}
          onApplied={() => {}}
          onClose={() => {}}
        />
      </MotionConfig>,
    );

    await waitFor(() =>
      expect(screen.getByText("Не получилось открыть сундук")).toBeInTheDocument(),
    );
  });
});
