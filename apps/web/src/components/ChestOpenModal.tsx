import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { AnimatePresence, motion, useAnimation, useReducedMotion } from "motion/react";
import { Gift, Loader2, X } from "lucide-react";
import { PentagramLoader } from "@/components/PentagramLoader";
import { CurrencyIcon } from "@/components/CurrencyIcon";
import { pressFeedback, springFor } from "@/lib/motion";
import { useMotionOff } from "@/hooks/useTransitionStyle";
import { cn } from "@/lib/utils";
import { apiClient } from "@/integrations/api/client";
import { formatDropsLabel } from "@/utils/formatDropsLabel";
import type { ChestStep } from "@/hooks/useQuests";

/** Server-rolled open outcome. Steps replay tap-by-tap (may be absent on old builds). */
export interface ChestOpenOutcome {
  rarity: string;
  drops: number;
  steps?: Array<ChestStep | { type: string; rarity: string; attempts_left: number }>;
}

interface RarityView {
  rarity: string;
  color: string;
  image_url: string;
  opened_image_url: string;
}

const FALLBACK_COLORS: Record<string, string> = {
  common: "#9ca3af",
  unusual: "#22c55e",
  rare: "#3b82f6",
  epic: "#a855f7",
  legendary: "#f59e0b",
  mythic: "#e11d48",
  eternal: "#ffffff",
};

const FALLBACK_ORDER = ["common", "unusual", "rare", "epic", "legendary", "mythic", "eternal"];

// The catalog barely changes (curated textures); one in-memory copy per page
// load is enough, no store needed.
let catalogCache: RarityView[] | null = null;

async function loadRarities(): Promise<RarityView[]> {
  if (catalogCache) return catalogCache;
  try {
    const body = await apiClient.request<{ rarities?: RarityView[] }>("/api/v1/gamification/catalog");
    const data = body.data as { rarities?: RarityView[] } | undefined;
    if (data && Array.isArray(data.rarities) && data.rarities.length > 0) {
      catalogCache = data.rarities;
      return catalogCache;
    }
  } catch {
    /* offline or old build — fall back to colors */
  }
  catalogCache = FALLBACK_ORDER.map((rarity) => ({
    rarity,
    color: FALLBACK_COLORS[rarity] ?? "#9ca3af",
    image_url: `/storage/v1/object/gamification/${rarity}.png`,
    opened_image_url: `/storage/v1/object/gamification/${rarity}_opened.png`,
  }));
  return catalogCache;
}

function ChestImage({
  src,
  color,
  alt,
  opened,
  className,
}: {
  src: string;
  color: string;
  alt: string;
  opened: boolean;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (!src || failed) {
    return (
      <span
        className={cn("flex items-center justify-center rounded-2xl", className)}
        style={{ background: `${color}1f`, border: `2px dashed ${color}66` }}
      >
        <Gift className="h-16 w-16" style={{ color }} aria-hidden />
      </span>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      onError={() => setFailed(true)}
      draggable={false}
      className={cn("object-contain", className)}
    />
  );
}

interface ChestOpenModalProps {
  title: string;
  openChest: () => Promise<ChestOpenOutcome>;
  /** Credit the result (balance, vault) the moment it lands. */
  onApplied: (result: ChestOpenOutcome) => void;
  onClose: () => void;
}

/**
 * Interactive chest opening: one secure server call rolls the whole session,
 * then every tap on the chest replays the next pre-rolled step (fail → shake,
 * upgrade → flash + new texture, opened → reward). The backdrop blurs the
 * page on every form factor; the chest stays centered and thumb-reachable.
 */
export function ChestOpenModal({ title, openChest, onApplied, onClose }: ChestOpenModalProps) {
  const { t } = useTranslation();
  const reduce = useReducedMotion();
  const motionOff = useMotionOff();
  const [rarities, setRarities] = useState<RarityView[]>([]);
  const [result, setResult] = useState<ChestOpenOutcome | null>(null);
  const [failed, setFailed] = useState(false);
  const [revealed, setRevealed] = useState(0);
  const appliedRef = useRef(false);
  const controls = useAnimation();

  useEffect(() => {
    void loadRarities().then(setRarities);
  }, []);

  // One secure call: the server plays + credits the session, we replay it.
  useEffect(() => {
    let cancelled = false;
    openChest()
      .then((res) => {
        if (cancelled) return;
        // No trace (old build) — synthesize a single opening step.
        if (!res.steps || res.steps.length === 0) {
          res = { ...res, steps: [{ type: "opened", rarity: res.rarity, attempts_left: 0 }] };
        }
        setResult(res);
        if (!appliedRef.current) {
          appliedRef.current = true;
          onApplied(res);
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Lock the page scroll + close on Escape once the reward is shown (before
  // that an accidental close would skip the moment — the reward is safe, it
  // is already credited, but the ceremony deserves the click).
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && revealedCount >= totalCount && totalCount > 0) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const steps = useMemo(() => result?.steps ?? [], [result]);
  const totalCount = steps.length;
  const revealedCount = Math.min(revealed, totalCount);
  const opened = result !== null && revealedCount >= totalCount && totalCount > 0;
  const shownRarity = revealedCount > 0 ? (steps[revealedCount - 1]?.rarity ?? "common") : "common";
  const view = rarities.find((r) => r.rarity === (opened ? result?.rarity : shownRarity));
  const color = view?.color ?? FALLBACK_COLORS[opened ? (result?.rarity ?? "") : shownRarity] ?? "#9ca3af";
  const lastStep = revealedCount > 0 ? steps[revealedCount - 1] : null;

  const tap = useCallback(() => {
    if (!result || opened || revealedCount >= totalCount) return;
    const next = steps[revealedCount];
    setRevealed((n) => n + 1);
    if (reduce || motionOff) return;
    const kind = next?.type === "upgraded" || next?.type === "opened" ? "upgrade" : "fail";
    // Fire-and-forget keyframes on the stable button: no remount, focus stays.
    if (kind === "fail") {
      void controls.start({ x: [0, -10, 8, -5, 0], rotate: [0, -2, 2, 0] });
    } else {
      void controls.start({ scale: [1, 1.12, 1], rotate: [0, -3, 3, 0] });
    }
  }, [result, opened, revealedCount, totalCount, steps, reduce, motionOff, controls]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-[90] flex items-center justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-md"
      onClick={opened ? onClose : undefined}
    >
      <div
        className="relative w-full max-w-sm overflow-hidden rounded-3xl border border-border/60 bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-25"
          style={{ background: `radial-gradient(ellipse 80% 60% at 50% 38%, ${color}55, transparent 70%)` }}
        />
        <div className="relative flex items-center justify-between px-5 pt-4">
          <p className="truncate text-sm font-medium text-muted-foreground">{title}</p>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="relative px-5 pb-5 pt-1">
          {failed ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <p className="text-sm text-muted-foreground">{t("quests.openFailed")}</p>
              <button
                type="button"
                onClick={onClose}
                className="rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
              >
                {t("common.close")}
              </button>
            </div>
          ) : !result ? (
            <div className="flex flex-col items-center gap-3 py-10">
              <PentagramLoader size="lg" />
              <p className="text-sm text-muted-foreground">{t("quests.chestRolling")}</p>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-center gap-2" aria-live="polite">
                <span
                  className="inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wide"
                  style={{ background: `${color}22`, color, border: `1px solid ${color}55` }}
                >
                  {t(`quests.rarity.${opened ? result.rarity : shownRarity}`, {
                    defaultValue: opened ? result.rarity : shownRarity,
                  })}
                </span>
                {!opened && (
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {t("quests.chestTapCount", { done: revealedCount, total: totalCount })}
                  </span>
                )}
              </div>

              <motion.button
                type="button"
                onClick={tap}
                disabled={opened}
                aria-label={opened ? t("quests.chestOpenedLabel") : t("quests.chestTapHint")}
                {...pressFeedback(reduce || motionOff ? true : null)}
                transition={springFor("snappy", reduce)}
                initial={false}
                animate={controls}
                className="mx-auto mt-2 block rounded-3xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-default"
              >
                <motion.div
                  animate={
                    opened && !reduce && !motionOff
                      ? { scale: [1, 1.06, 1], transition: { repeat: Infinity, duration: 2.2 } }
                      : { scale: 1 }
                  }
                  style={opened ? { filter: `drop-shadow(0 0 28px ${color})` } : undefined}
                >
                  <ChestImage
                    src={opened ? (view?.opened_image_url ?? "") : (view?.image_url ?? "")}
                    color={color}
                    alt={title}
                    opened={opened}
                    className="h-56 w-56 sm:h-64 sm:w-64"
                  />
                </motion.div>
              </motion.button>

              <AnimatePresence mode="wait" initial={false}>
                {opened ? (
                  <motion.div
                    key="reward"
                    initial={reduce || motionOff ? false : { opacity: 0, y: 12, scale: 0.96 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    transition={springFor("soft", reduce)}
                    className="mt-1 flex flex-col items-center gap-3 text-center"
                  >
                    <p className="inline-flex items-center gap-1.5 text-2xl font-bold tabular-nums">
                      <CurrencyIcon kind="drops" className="h-6 w-6" />+{result.drops}
                    </p>
                    <p className="-mt-2 text-sm text-muted-foreground">
                      {formatDropsLabel(result.drops)}
                    </p>
                    {lastStep && lastStep.type !== "opened" && (
                      <p className="text-xs text-muted-foreground">{t("quests.chestKeptRarity")}</p>
                    )}
                    <button
                      type="button"
                      onClick={onClose}
                      className="mt-1 w-full rounded-full bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
                    >
                      {t("quests.chestTake")}
                    </button>
                  </motion.div>
                ) : (
                  <motion.p
                    key="hint"
                    exit={reduce || motionOff ? undefined : { opacity: 0 }}
                    className="mt-3 text-center text-sm text-muted-foreground"
                  >
                    {revealedCount === 0
                      ? t("quests.chestTapStart")
                      : lastStep?.type === "upgraded"
                        ? t("quests.chestUpgraded")
                        : t("quests.chestTapHint")}
                  </motion.p>
                )}
              </AnimatePresence>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
