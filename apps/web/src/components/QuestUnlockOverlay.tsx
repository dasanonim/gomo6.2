import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "motion/react";
import { Coins, Gem, Gift, Trophy } from "lucide-react";
import { SPRING } from "@/lib/motion";
import { eventManager } from "@/services/eventManager";
import { useAuth } from "@/hooks/useAuth";
import { fetchQuestProgress, type QuestReward } from "@/hooks/useQuests";
import type { Notification } from "@/integrations/api/client";

interface Unlock {
  key: string;
  track: string;
  title: string;
  name: string;
  desc: string;
  rewards: QuestReward[];
  uid: string;
}

/** How long the card stays before gliding away on its own. */
const DWELL_MS = 4500;

function UnlockRewards({ rewards }: { rewards: QuestReward[] }) {
  const { t } = useTranslation();
  if (rewards.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center justify-center gap-1.5">
      {rewards.map((r, i) => (
        <span
          key={`${r.kind}-${i}`}
          className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs font-medium"
        >
          {r.kind === "gems" && (
            <>
              <Gem className="h-3.5 w-3.5" />
              {r.amount}
            </>
          )}
          {r.kind === "drops" && (
            <>
              <Coins className="h-3.5 w-3.5" />
              {r.amount}
            </>
          )}
          {r.kind === "chest" && (
            <>
              <Gift className="h-3.5 w-3.5" />
              {t("quests.chest")}
            </>
          )}
        </span>
      ))}
    </div>
  );
}

/**
 * Center-screen quest unlock card: appears above everything when the server
 * reports a completed level (`achievement_unlock` over WS), shows what the
 * quest is and what it gives, then glides away on its own. A button takes
 * the user to the quest page to claim — claiming itself stays there.
 */
export function QuestUnlockOverlay() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [queue, setQueue] = useState<Unlock[]>([]);
  const [current, setCurrent] = useState<Unlock | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dismiss = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setCurrent(null);
  }, []);

  // Feed the queue from WS unlock notifications, resolving display data
  // through the progress endpoint (names, descriptions and rewards live
  // in the catalog, not in the notification payload).
  useEffect(() => {
    const off = eventManager.on("new_notification", (message) => {
      const notif = message.data as Notification | undefined;
      const params = notif?.params as
        | { group_key?: string; level?: number }
        | undefined;
      if (!notif || notif.type !== "achievement_unlock" || !params?.group_key) return;
      const uid = user?.id;
      if (!uid) return;
      const key = `${params.group_key}:${params.level ?? 1}`;
      void fetchQuestProgress(uid)
        .then((data) => {
          const quest = (data.quests ?? []).find((q) => q.group_key === params.group_key);
          const level = quest?.levels.find((l) => l.level === (params.level ?? 1));
          if (!quest || !level) return;
          setQueue((q) => [
            ...q,
            {
              key: `${key}:${Date.now()}`,
              track: quest.track,
              title: t(quest.title_key),
              name: t(level.name_key),
              desc: t(level.description_key),
              rewards: level.rewards,
              uid,
            },
          ]);
        })
        .catch(() => {});
    });
    return off;
  }, [t, user?.id]);

  // Show the head of the queue; auto-dismiss after the dwell time.
  useEffect(() => {
    if (current || queue.length === 0) return;
    const [head, ...rest] = queue;
    setQueue(rest);
    setCurrent(head);
  }, [current, queue]);

  useEffect(() => {
    if (!current) return;
    timer.current = setTimeout(() => setCurrent(null), DWELL_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [current]);

  const goToQuests = () => {
    if (!current) return;
    navigate(`/achievements/${current.uid}`);
    dismiss();
  };

  return (
    <AnimatePresence>
      {current && (
        <div className="pointer-events-none fixed inset-x-0 bottom-6 z-[200] flex justify-center px-4">
          <motion.div
            key={current.key}
            role="status"
            initial={{ opacity: 0, y: 80, scale: 0.94 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 60, scale: 0.96 }}
            transition={SPRING.standard}
            className="pointer-events-auto w-full max-w-xs overflow-hidden rounded-xl border border-border bg-card/95 shadow-xl backdrop-blur"
          >
            <div className="flex items-center gap-3 p-3.5">
              <motion.div
                initial={{ scale: 0.5, rotate: -12 }}
                animate={{ scale: 1, rotate: 0 }}
                transition={{ ...SPRING.pop, delay: 0.05 }}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"
              >
                <Trophy className="h-5 w-5" />
              </motion.div>
              <div className="min-w-0 flex-1 text-left">
                <div className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                  {t("quests.unlockTitle")}
                </div>
                <div className="truncate text-sm font-bold" title={current.desc}>{current.name}</div>
                <div className="mt-0.5 flex flex-wrap gap-1">
                  <UnlockRewards rewards={current.rewards} />
                </div>
              </div>
              <button
                type="button"
                onClick={goToQuests}
                className="shrink-0 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-transform active:scale-[0.98]"
              >
                {t("quests.unlockGo")}
              </button>
            </div>
            <motion.div
              key={`bar-${current.key}`}
              initial={{ width: "100%" }}
              animate={{ width: "0%" }}
              transition={{ duration: DWELL_MS / 1000, ease: "linear" }}
              className="h-0.5 bg-primary/70"
            />
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
