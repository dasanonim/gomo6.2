import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  Check,
  Coins,
  Flag,
  Gem,
  Gift,
  Heart,
  HeartHandshake,
  IdCard,
  Loader2,
  MessageSquare,
  MessagesSquare,
  NotebookPen,
  Palette,
  PenLine,
  Smile,
  Sparkles,
  Trophy,
  UserPlus,
  Users,
  type LucideIcon,
} from "lucide-react";
import { PentagramLoader } from "@/components/PentagramLoader";
import { toast } from "sonner";
import { AnimatePresence, motion } from "motion/react";
import { SPRING } from "@/lib/motion";
import { useQuests, questErrorStatus, type Quest, type QuestLevel, type QuestReward } from "@/hooks/useQuests";
import { useAuth } from "@/hooks/useAuth";
import { loadAchievementsProfile } from "@/routes/data/achievementsData";
import { isPublicId } from "@/utils/entityUrl";

const ICONS: Record<string, LucideIcon> = {
  smile: Smile,
  "id-card": IdCard,
  "message-square": MessageSquare,
  "pen-line": PenLine,
  "messages-square": MessagesSquare,
  heart: Heart,
  "heart-handshake": HeartHandshake,
  users: Users,
  "user-plus": UserPlus,
  palette: Palette,
  trophy: Trophy,
  "notebook-pen": NotebookPen,
  flag: Flag,
};

function QuestIcon({ name, className }: { name: string; className?: string }) {
  const Icon = ICONS[name] ?? Sparkles;
  return <Icon className={className} />;
}

function RewardChip({ reward }: { reward: QuestReward }) {
  const { t } = useTranslation();
  if (reward.kind === "gems") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs">
        <Gem className="h-3 w-3" />
        {reward.amount}
      </span>
    );
  }
  if (reward.kind === "drops") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs">
        <Coins className="h-3 w-3" />
        {reward.amount}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs">
      <Gift className="h-3 w-3" />
      {t("quests.chest")}
    </span>
  );
}

function LevelRow({
  quest,
  level,
  progress,
  isOwner,
  claiming,
  onClaim,
}: {
  quest: Quest;
  level: QuestLevel;
  progress: number;
  isOwner: boolean;
  claiming: boolean;
  onClaim: () => void;
}) {
  const { t } = useTranslation();
  const done = level.completed;
  return (
    <div
      className={`flex items-center gap-3 rounded-lg border p-3 transition-colors duration-300 ${
        level.can_claim ? "border-primary/50 bg-primary/5" : "border-border"
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{t(level.name_key)}</div>
        <div className="truncate text-xs text-muted-foreground">{t(level.description_key)}</div>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {level.rewards.map((r, i) => (
            <RewardChip key={`${r.kind}-${i}`} reward={r} />
          ))}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        {!done && (
          <span className="text-xs tabular-nums text-muted-foreground">
            {Math.min(progress, level.threshold)}/{level.threshold}
          </span>
        )}
        {isOwner && level.can_claim && (
          <motion.button
            type="button"
            onClick={onClaim}
            disabled={claiming}
            whileTap={{ scale: 0.93 }}
            transition={SPRING.snappy}
            className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity disabled:opacity-50"
          >
            {claiming && <Loader2 className="h-3 w-3 animate-spin" />}
            {t("quests.claim")}
          </motion.button>
        )}
        {level.claimed && (
          <motion.span
            initial={{ scale: 0.4, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={SPRING.pop}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground"
          >
            <Check className="h-3 w-3" />
            {t("quests.claimed")}
          </motion.span>
        )}
      </div>
    </div>
  );
}

/**
 * Quest page: the onboarding checklist plus the progressive ladder — every
 * quest visible with its progress, every completed level claimable by the
 * owner. Guests and other users see progress but no claim buttons.
 */
export default function Achievements() {
  const { t } = useTranslation();
  const { userId } = useParams();
  const { user } = useAuth();
  const [profile, setProfile] = useState<{ id: string; username: string } | null>(null);
  const [profileLoading, setProfileLoading] = useState(Boolean(userId));
  const [claimingKey, setClaimingKey] = useState<string | null>(null);

  useEffect(() => {
    if (!userId) {
      setProfileLoading(false);
      return;
    }
    let cancelled = false;
    setProfileLoading(true);
    loadAchievementsProfile(userId)
      .then((p) => {
        if (!cancelled) setProfile(p);
      })
      .finally(() => {
        if (!cancelled) setProfileLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const trophyUserId =
    profile?.id ?? (userId && isPublicId(userId) ? undefined : userId);
  const { quests, chests, gems, unclaimedCount, loading, claim, openChest, reload, applyClaim, applyChestOpen } =
    useQuests(trophyUserId);
  const isOwner = Boolean(user?.id && trophyUserId && user.id === trophyUserId);
  // In-flight claim/open guard: state-driven `disabled` flips only after a
  // re-render, so a fast double click fires two POSTs — the second gets a 409
  // while the first already granted. The ref blocks the second synchronously.
  const inflight = useRef<Set<string>>(new Set());

  const firstSteps = useMemo(
    () => quests.filter((q) => q.track === "first_steps").sort((a, b) => a.sort_order - b.sort_order),
    [quests],
  );
  const main = useMemo(
    () => quests.filter((q) => q.track !== "first_steps").sort((a, b) => a.sort_order - b.sort_order),
    [quests],
  );
  const doneSteps = useMemo(
    () => firstSteps.filter((q) => q.current_level > 0).length,
    [firstSteps],
  );

  const handleClaim = async (quest: Quest, level: QuestLevel) => {
    const key = `${quest.group_key}:${level.level}`;
    if (inflight.current.has(key)) return;
    inflight.current.add(key);
    setClaimingKey(key);
    try {
      const granted = await claim(quest.group_key, level.level);
      // Surgical patch — no refetch, the row flips in place with animation.
      applyClaim(quest.group_key, level.level, granted);
      const gemsWon = granted
        .filter((g) => g.kind === "gems")
        .reduce((sum, g) => sum + (g.amount ?? 0), 0);
      toast.success(
        gemsWon > 0 ? t("quests.claimedGems", { count: gemsWon }) : t("quests.claimedDone"),
      );
    } catch (err) {
      // 409 = the reward is already claimed (parallel click, retry after a
      // success whose response was lost): not an error, just re-sync state.
      // 422 = progress moved (e.g. rules changed): re-sync too.
      const status = questErrorStatus(err);
      await reload();
      if (status === 409) {
        toast.message(t("quests.alreadyClaimed"));
      } else if (status !== 422) {
        toast.error(t("quests.claimFailed"));
      }
    } finally {
      inflight.current.delete(key);
      setClaimingKey(null);
    }
  };

  const handleOpenChest = async (id: string) => {
    const key = `chest:${id}`;
    if (inflight.current.has(key)) return;
    inflight.current.add(key);
    setClaimingKey(key);
    try {
      const res = await openChest(id);
      applyChestOpen(id, res.gems);
      toast.success(t("quests.chestOpened", { count: res.gems }));
    } catch (err) {
      await reload();
      if (questErrorStatus(err) !== 409) {
        toast.error(t("quests.openFailed"));
      }
    } finally {
      inflight.current.delete(key);
      setClaimingKey(null);
    }
  };

  if (profileLoading || loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <PentagramLoader size="lg" />
      </div>
    );
  }

  return (
    <main className="mx-auto max-w-4xl space-y-8 p-4">
      <header className="space-y-3">
        <Link
          to={`/profile/${userId}`}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {profile
            ? t("achievements.backToProfile", { username: profile.username })
            : t("achievements.back")}
        </Link>

        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <Trophy className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-bold">
              {t("quests.title")}
              {profile && ` — ${profile.username}`}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t("quests.subtitle", { done: doneSteps, total: firstSteps.length })}
            </p>
          </div>
          {isOwner && (
            <div className="flex shrink-0 items-center gap-2 text-sm">
              <motion.span
                key={gems}
                initial={{ scale: 1.35 }}
                animate={{ scale: 1 }}
                transition={SPRING.pop}
                className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 font-medium"
              >
                <Gem className="h-3.5 w-3.5" />
                {gems}
              </motion.span>
              <AnimatePresence initial={false}>
                {unclaimedCount > 0 && (
                  <motion.span
                    key="unclaimed"
                    initial={{ scale: 0.6, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.6, opacity: 0 }}
                    transition={SPRING.pop}
                    className="inline-flex items-center rounded-full bg-primary px-2.5 py-1 font-medium text-primary-foreground"
                  >
                    {t("quests.unclaimed", { count: unclaimedCount })}
                  </motion.span>
                )}
              </AnimatePresence>
            </div>
          )}
        </div>
      </header>

      {isOwner && chests.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {t("quests.chestsSection", { count: chests.length })}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <AnimatePresence initial={false}>
              {chests.map((ch) => (
                <motion.div
                  key={ch.id}
                  layout
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  transition={SPRING.standard}
                  className="flex items-center gap-3 rounded-lg border border-border p-3"
                >
                <Gift className="h-6 w-6 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{t("quests.chestName")}</div>
                  <div className="text-xs text-muted-foreground">{t(ch.quest_key ? `achievements.${ch.quest_key}.title` : "quests.chestFallback")}</div>
                </div>
                <motion.button
                  type="button"
                  onClick={() => void handleOpenChest(ch.id)}
                  disabled={claimingKey === `chest:${ch.id}`}
                  whileTap={{ scale: 0.93 }}
                  transition={SPRING.snappy}
                  className="inline-flex shrink-0 items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
                >
                  {claimingKey === `chest:${ch.id}` && <Loader2 className="h-3 w-3 animate-spin" />}
                  {t("quests.open")}
                </motion.button>
              </motion.div>
            ))}
            </AnimatePresence>
          </div>
        </section>
      )}

      {firstSteps.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {t("quests.firstSteps", { done: doneSteps, total: firstSteps.length })}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {firstSteps.map((quest) => {
              const level = quest.levels[0];
              if (!level) return null;
              return (
                <div key={quest.group_key} className="rounded-lg border border-border p-3">
                  <div className="mb-2 flex items-center gap-2">
                    <QuestIcon name={quest.icon} className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-medium">{t(quest.title_key)}</span>
                  </div>
                  <LevelRow
                    quest={quest}
                    level={level}
                    progress={quest.progress_current}
                    isOwner={isOwner}
                    claiming={claimingKey === `${quest.group_key}:${level.level}`}
                    onClaim={() => void handleClaim(quest, level)}
                  />
                </div>
              );
            })}
          </div>
        </section>
      )}

      {main.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {t("quests.mainLadder")}
          </h2>
          <div className="grid gap-3 md:grid-cols-2">
            {main.map((quest) => (
              <div key={quest.group_key} className="space-y-2 rounded-lg border border-border p-3">
                <div className="flex items-center gap-2">
                  <QuestIcon name={quest.icon} className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium">{t(quest.title_key)}</span>
                </div>
                {quest.levels.map((level) => (
                  <LevelRow
                    key={level.level}
                    quest={quest}
                    level={level}
                    progress={quest.progress_current}
                    isOwner={isOwner}
                    claiming={claimingKey === `${quest.group_key}:${level.level}`}
                    onClaim={() => void handleClaim(quest, level)}
                  />
                ))}
              </div>
            ))}
          </div>
        </section>
      )}

      {quests.length === 0 && (
        <p className="py-12 text-center text-muted-foreground">{t("achievements.noTrophies")}</p>
      )}
    </main>
  );
}
