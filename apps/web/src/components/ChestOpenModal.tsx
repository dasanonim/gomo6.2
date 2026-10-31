import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { motion, useAnimation, useReducedMotion } from "motion/react";
import { Gift } from "lucide-react";
import { toast } from "sonner";
import { CurrencyIcon } from "@/components/CurrencyIcon";
import { useMotionOff } from "@/hooks/useTransitionStyle";
import { cn } from "@/lib/utils";
import { apiClient } from "@/integrations/api/client";
import { formatDropsLabel } from "@/utils/formatDropsLabel";

/** One pre-rolled tap of the server session, revealed click by click. */
export interface ChestReplayStep {
  type: "upgraded" | "failed" | "opened" | string;
  rarity: string;
  attempts_left: number;
}

/** The full session: played AND credited server-side the moment the modal
 * opens. Steps replay the ceremony tap by tap. */
export interface ChestOpenOutcome {
  rarity: string;
  drops: number;
  steps?: ChestReplayStep[];
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
  /** Plays the full session server-side (credited at once). Fired on mount. */
  openChest: () => Promise<ChestOpenOutcome>;
  /** The opening call landed: credit drops + drop the vault row. */
  onApplied: (drops: number) => void;
  /** The chest is gone server-side (already opened elsewhere): drop the row. */
  onExpired: () => void;
  onClose: () => void;
}

/**
 * Interactive chest opening: two elements on a blurred stage — the chest and
 * the attempt dots below it. No panel, no chrome. The full session is played
 * and credited the moment the modal opens, so there is no backing out and
 * leaving mid-way loses nothing; every tap reveals the next pre-rolled step
 * (fail shakes, upgrade flashes new texture, opened swaps to the reward).
 * Dismissal unlocks only when the ceremony is over — any click then closes.
 */
export function ChestOpenModal({
  title,
  openChest,
  onApplied,
  onExpired,
  onClose,
}: ChestOpenModalProps) {
  const { t } = useTranslation();
  const reduce = useReducedMotion();
  const motionOff = useMotionOff();
  const still = reduce || motionOff;
  const [rarities, setRarities] = useState<RarityView[]>([]);
  const [total, setTotal] = useState(FALLBACK_ATTEMPTS);
  const [steps, setSteps] = useState<ChestReplayStep[]>([]);
  const [revealed, setRevealed] = useState(0);
  const [rarity, setRarity] = useState("common");
  const [left, setLeft] = useState(FALLBACK_ATTEMPTS);
  const [opened, setOpened] = useState(false);
  const [drops, setDrops] = useState(0);
  const [finalRarity, setFinalRarity] = useState("");
  const [live, setLive] = useState("");
  const controls = useAnimation();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [imgFailed, setImgFailed] = useState(false);
  const doneRef = useRef(false);

  useEffect(() => {
    void loadCatalog().then((c) => {
      setRarities(c.rarities);
      setTotal(c.attempts);
      setLeft((v) => (v === FALLBACK_ATTEMPTS ? c.attempts : v));
    });
  }, []);

  // The point of no return: the session plays and credits on mount.
  useEffect(() => {
    let cancelled = false;
    openChest()
      .then((res) => {
        if (cancelled) return;
        // No trace (old build) — synthesize a single opening step.
        const trace =
          res.steps && res.steps.length > 0
            ? res.steps
            : [{ type: "opened", rarity: res.rarity, attempts_left: 0 }];
        setSteps(trace);
        setDrops(res.drops);
        setFinalRarity(res.rarity);
        if (!doneRef.current) {
          doneRef.current = true;
          onApplied(res.drops);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        // 409 = opened elsewhere: the row is dead, drop it.
        if ((err as { status?: number })?.status === 409) {
          onExpired();
        } else {
          toast.error(t("quests.openFailed"));
        }
        onClose();
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Lock the page scroll; Escape works only once the ceremony is over.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && doneRef.current && steps.length > 0 && revealed >= steps.length) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose, revealed, steps.length]);

  // Once opened there are no controls left — move focus to the dialog.
  useEffect(() => {
    if (opened) dialogRef.current?.focus();
  }, [opened]);

  const totalCount = steps.length;
  const view = rarities.find((r) => r.rarity === (opened ? finalRarity : rarity));
  const color = view?.color ?? FALLBACK_COLORS[opened ? finalRarity : rarity] ?? "#9ca3af";
  const src = opened ? view?.opened_image_url : view?.image_url;

  useEffect(() => setImgFailed(false), [src]);

  const tap = useCallback(() => {
    if (steps.length === 0 || revealed >= steps.length || opened) return;
    const next = steps[revealed];
    setRevealed((n) => n + 1);
    setRarity(next.rarity);
    setLeft(next.attempts_left);
    if (next.type === "opened") {
      setOpened(true);
      setLive(t("quests.chestOpened", { count: drops, label: formatDropsLabel(drops) }));
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
      return;
    }
    if (still) {
      if (next.type === "upgraded") setLive(t("quests.chestUpgraded"));
      return;
    }
    const el = imgRef.current;
    if (!el) {
      if (next.type === "upgraded") setLive(t("quests.chestUpgraded"));
      return;
    }
    el.getAnimations().forEach((a) => a.cancel());
    if (next.type === "upgraded") {
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
  }, [steps, revealed, opened, drops, still, t]);

  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
      onClick={opened ? onClose : undefined}
      className="fixed inset-0 z-[90] flex flex-col items-center justify-center gap-5 bg-black/60 p-4 backdrop-blur-md focus-visible:outline-none"
    >
      <span aria-hidden className="pointer-events-none absolute inset-0 opacity-30" style={{ background: `radial-gradient(ellipse 60% 45% at 50% 42%, ${color}66, transparent 70%)` }} />

      {/* The chest: the only control on stage. Mid-ceremony taps reveal
          the next pre-rolled step; after the opening tap any click closes. */}
      <motion.button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (opened) onClose();
          else tap();
        }}
        disabled={steps.length === 0}
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
        <div className="flex flex-col items-center gap-1">
          <p className="inline-flex items-center gap-1.5 text-3xl font-bold tabular-nums text-white">
            <CurrencyIcon kind="drops" className="h-7 w-7" />+{drops}
          </p>
          <p className="text-xs text-white/60">{formatDropsLabel(drops)}</p>
        </div>
      )}

      {/* Screen-reader dismissal: no visible chrome, but keyboard users
          still get a labelled control (Escape works too, once opened). */}
      <button type="button" onClick={onClose} tabIndex={-1} className="sr-only">
        {t("common.close")}
      </button>

      <span aria-live="polite" className="sr-only">
        {live}
      </span>
    </div>,
    document.body,
  );
}
