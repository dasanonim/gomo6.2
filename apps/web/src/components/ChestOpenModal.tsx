import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { motion, useAnimation, useReducedMotion } from "motion/react";
import { Gift, X } from "lucide-react";
import { toast } from "sonner";
import { CurrencyIcon } from "@/components/CurrencyIcon";
import { useMotionOff } from "@/hooks/useTransitionStyle";
import { cn } from "@/lib/utils";
import { apiClient } from "@/integrations/api/client";
import { formatDropsLabel } from "@/utils/formatDropsLabel";

/** One server-driven tap. The server owns the roll; the client only shows it. */
export interface ChestTapOutcome {
  type: "upgraded" | "failed" | "opened" | string;
  rarity: string;
  attempts_left: number;
  attempts_total: number;
  final_rarity?: string;
  drops?: number;
}

interface RarityView {
  rarity: string;
  color: string;
  image_url: string;
  opened_image_url: string;
}

interface CatalogShape {
  rarities?: RarityView[];
  mechanics?: Array<{ key: string; config?: { attempts_per_tier?: number } }>;
}

const FALLBACK_COLORS: Record<string, string> = {
  common: "#9ca3af",
  unusual: "#22c55e",
  rare: "#3b82f6",
  epic: "#a855f7",
  legendary: "#f59e0b",
  mythic: "#e11a48",
  eternal: "#ffffff",
};

const FALLBACK_ORDER = ["common", "unusual", "rare", "epic", "legendary", "mythic", "eternal"];
const FALLBACK_ATTEMPTS = 5;

// The catalog barely changes (curated textures); one in-memory copy per page
// load is enough, no store needed.
let catalogCache: { rarities: RarityView[]; attempts: number } | null = null;

async function loadCatalog(): Promise<{ rarities: RarityView[]; attempts: number }> {
  if (catalogCache) return catalogCache;
  try {
    const body = await apiClient.request<CatalogShape>("/api/v1/gamification/catalog");
    const data = body.data as CatalogShape | undefined;
    const rarities = data?.rarities?.length ? data.rarities : null;
    const attempts = data?.mechanics?.[0]?.config?.attempts_per_tier;
    if (rarities) {
      catalogCache = {
        rarities,
        attempts: typeof attempts === "number" && attempts > 0 ? attempts : FALLBACK_ATTEMPTS,
      };
      return catalogCache;
    }
  } catch {
    /* offline — fall back to colors */
  }
  catalogCache = {
    rarities: FALLBACK_ORDER.map((rarity) => ({
      rarity,
      color: FALLBACK_COLORS[rarity] ?? "#9ca3af",
      image_url: `/storage/v1/object/gamification/${rarity}.png`,
      opened_image_url: `/storage/v1/object/gamification/${rarity}_opened.png`,
    })),
    attempts: FALLBACK_ATTEMPTS,
  };
  return catalogCache;
}

interface ChestOpenModalProps {
  title: string;
  /** Persisted session snapshot (keeps dots right on mount, resumes mid-chest). */
  initialRarity?: string;
  initialAttempts?: number;
  /** One server tap per call. */
  tapChest: () => Promise<ChestTapOutcome>;
  /** The opening tap landed: credit drops + drop the vault row. */
  onApplied: (drops: number) => void;
  /** Patch the vault row snapshot after every tap (reopen stays fresh). */
  onProgress: (rarity: string, attempts: number) => void;
  /** The chest is gone server-side (already opened elsewhere): drop the row. */
  onExpired: () => void;
  onClose: () => void;
}

/**
 * Interactive chest opening: two elements on a blurred stage — the chest and
 * the attempt dots below it. No panel, no chrome. Every tap is one server
 * POST (upgrade, fail or open); the server persists the session, so closing
 * mid-chest and reopening resumes the dots where they were. Textures come
 * from the curated gamification bucket, rarity reads as glow color.
 */
export function ChestOpenModal({
  title,
  initialRarity,
  initialAttempts,
  tapChest,
  onApplied,
  onProgress,
  onExpired,
  onClose,
}: ChestOpenModalProps) {
  const { t } = useTranslation();
  const reduce = useReducedMotion();
  const motionOff = useMotionOff();
  const still = reduce || motionOff;
  const [rarities, setRarities] = useState<RarityView[]>([]);
  const [total, setTotal] = useState(FALLBACK_ATTEMPTS);
  const [rarity, setRarity] = useState(initialRarity || "common");
  const [left, setLeft] = useState(
    typeof initialAttempts === "number" ? initialAttempts : FALLBACK_ATTEMPTS,
  );
  const [opened, setOpened] = useState(false);
  const [drops, setDrops] = useState(0);
  const [finalRarity, setFinalRarity] = useState("");
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState("");
  const controls = useAnimation();
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [imgFailed, setImgFailed] = useState(false);

  useEffect(() => {
    void loadCatalog().then((c) => {
      setRarities(c.rarities);
      setTotal(c.attempts);
      // Untapped chests always start at a full budget; a snapshot only
      // overrides when the session really began (non-full budget or rarity).
      if (typeof initialAttempts !== "number") setLeft(c.attempts);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Lock the page scroll while the ceremony runs.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const view = rarities.find((r) => r.rarity === (opened ? finalRarity : rarity));
  const color = view?.color ?? FALLBACK_COLORS[opened ? finalRarity : rarity] ?? "#9ca3af";
  const src = opened ? view?.opened_image_url : view?.image_url;

  useEffect(() => setImgFailed(false), [src]);

  const tap = useCallback(async () => {
    if (busy || opened) return;
    setBusy(true);
    try {
      const ev = await tapChest();
      const nextTotal = ev.attempts_total > 0 ? ev.attempts_total : total;
      setTotal(nextTotal);
      setRarity(ev.rarity);
      setLeft(ev.attempts_left);
      onProgress(ev.rarity, ev.attempts_left);
      if (ev.type === "opened") {
        const won = ev.drops ?? 0;
        setDrops(won);
        setFinalRarity(ev.final_rarity || ev.rarity);
        setOpened(true);
        setLive(t("quests.chestOpened", { count: won, label: formatDropsLabel(won) }));
        onApplied(won);
        if (!still && imgRef.current) {
          imgRef.current.animate(
            [
              { transform: "scale(0.85)", opacity: 0.4 },
              { transform: "scale(1.06)", opacity: 1 },
              { transform: "scale(1)", opacity: 1 },
            ],
            { duration: 500, easing: "cubic-bezier(0.34, 1.56, 0.64, 1)" },
          );
        }
      } else if (!still) {
        const el = imgRef.current;
        if (el) {
          el.getAnimations().forEach((a) => a.cancel());
          if (ev.type === "upgraded") {
            setLive(t("quests.chestUpgraded"));
            el.animate(
              [
                { transform: "translateY(0) scale(1)" },
                { transform: "translateY(-14px) scale(1.08)" },
                { transform: "translateY(0) scale(0.95)" },
                { transform: "translateY(-6px) scale(1.03)" },
                { transform: "translateY(0) scale(1)" },
              ],
              { duration: 600, easing: "cubic-bezier(0.34, 1.56, 0.64, 1)" },
            );
          } else {
            el.animate(
              [
                { transform: "translateX(0)" },
                { transform: "translateX(-8px)" },
                { transform: "translateX(7px)" },
                { transform: "translateX(-5px)" },
                { transform: "translateX(4px)" },
                { transform: "translateX(0)" },
              ],
              { duration: 400, easing: "ease-in-out" },
            );
          }
        } else if (ev.type === "upgraded") {
          setLive(t("quests.chestUpgraded"));
        }
      } else if (ev.type === "upgraded") {
        setLive(t("quests.chestUpgraded"));
      }
    } catch (err) {
      // 409 = opened elsewhere (or doubled): the row is dead, drop it.
      if ((err as { status?: number })?.status === 409) {
        onExpired();
        onClose();
      } else {
        // Visible, not just screen-reader: a stuck chest with silent taps
        // is indistinguishable from a broken mechanic (e.g. a stale backend
        // that doesn't know /tap yet answers 404 here).
        toast.error(t("quests.openFailed"));
        setLive(t("quests.openFailed"));
      }
    } finally {
      setBusy(false);
    }
  }, [busy, opened, tapChest, total, still, controls, onApplied, onProgress, onExpired, onClose, t]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-[90] flex flex-col items-center justify-center gap-5 bg-black/60 p-4 backdrop-blur-md"
    >
      <button
        type="button"
        onClick={onClose}
        aria-label={t("common.close")}
        className="absolute right-4 top-4 rounded-full p-2 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
      >
        <X className="size-5" />
      </button>

      <span aria-hidden className="pointer-events-none absolute inset-0 opacity-30" style={{ background: `radial-gradient(ellipse 60% 45% at 50% 42%, ${color}66, transparent 70%)` }} />

      {/* The chest: the only control on stage. */}
      <motion.button
        type="button"
        onClick={() => void tap()}
        disabled={busy || opened}
        animate={controls}
        whileTap={still ? undefined : { scale: 0.94 }}
        aria-label={
          opened
            ? t("quests.chestOpenedLabel")
            : t("quests.chestTapAria", { left, total })
        }
        className="relative rounded-3xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 disabled:cursor-default"
      >
        {src && !imgFailed ? (
          <img
            ref={imgRef}
            src={src}
            alt=""
            onError={() => setImgFailed(true)}
            draggable={false}
            className="h-64 w-64 object-contain drop-shadow-2xl sm:h-80 sm:w-80"
          />
        ) : (
          <span
            className={cn("flex h-64 w-64 items-center justify-center rounded-3xl sm:h-80 sm:w-80")}
            style={{ background: `${color}1f`, border: `2px dashed ${color}66` }}
          >
            <Gift className="h-20 w-20" style={{ color }} aria-hidden />
          </span>
        )}
      </motion.button>

      {/* The dots: attempts left at the current rarity. */}
      {!opened ? (
        <div className="flex items-center gap-2" role="img" aria-hidden>
          {Array.from({ length: total }, (_, i) => (
            <span
              key={i}
              className="h-2.5 w-2.5 rounded-full transition-colors"
              style={{
                background: i < left ? color : "rgba(255,255,255,0.22)",
                boxShadow: i < left ? `0 0 8px ${color}` : undefined,
              }}
            />
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3">
          <p className="inline-flex items-center gap-1.5 text-3xl font-bold tabular-nums text-white">
            <CurrencyIcon kind="drops" className="h-7 w-7" />+{drops}
          </p>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full bg-white px-8 py-2.5 text-sm font-semibold text-black transition-transform hover:scale-105 active:scale-95"
          >
            {t("quests.chestTake")}
          </button>
        </div>
      )}

      <span aria-live="polite" className="sr-only">
        {live}
      </span>
    </div>,
    document.body,
  );
}
