import { memo, useEffect, useState } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Gomo6Mark } from "./Gomo6Mark";
import {
  getCachedProfileSummary,
  requestProfileSummary,
  subscribeProfileSummaries,
} from "@/utils/profileSummaryLoader";
import { cn } from "@/lib/utils";

interface AdminBadgeProps {
  userId: string;
  className?: string;
  iconClassName?: string;
}

/**
 * Значок команды сайта — тот же Gomo6Mark, что и в хедере.
 *
 * Раньше тут лежал отдельный SVG (коляска) с собственным одноразовым
 * `getProfile/loadProfile`-эффектом: бейдж не подписывался на
 * `profile-cache:invalidate`, поэтому после выдачи/снятия админки значок
 * появлялся только после ремаунта, а первый рендер всегда был пустым
 * (скачок вёрстки). Теперь состояние читается из того же батч-лоадера
 * (`profileSummaryLoader`), что и остальные бейджи, и подписано на его
 * обновления — отдельный запрос на каждый бейдж не нужен.
 */
export const AdminBadge = memo(({ userId, className, iconClassName }: AdminBadgeProps) => {
  const [isAdmin, setIsAdmin] = useState(
    () => Boolean(userId) && Boolean(getCachedProfileSummary(userId)?.is_admin),
  );

  useEffect(() => {
    if (!userId) {
      setIsAdmin(false);
      return;
    }

    let alive = true;

    const syncFromCache = (): boolean => {
      const cached = getCachedProfileSummary(userId);
      if (!cached) return false;
      if (alive) setIsAdmin(Boolean(cached.is_admin));
      return true;
    };

    if (!syncFromCache()) {
      void requestProfileSummary(userId).then((summary) => {
        if (alive) setIsAdmin(Boolean(summary?.is_admin));
      });
    }

    const unsubscribe = subscribeProfileSummaries(() => {
      if (alive) syncFromCache();
    });

    return () => {
      alive = false;
      unsubscribe();
    };
  }, [userId]);

  if (!isAdmin) return null;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn("inline-flex shrink-0 items-center justify-center align-middle text-primary cursor-default", className)}
            data-testid="admin-badge"
            data-admin-badge="true"
            role="img"
            aria-label="команда сайта"
          >
            <Gomo6Mark className={cn("h-6 w-6 shrink-0", iconClassName)} strokeWidth={220} />
          </span>
        </TooltipTrigger>
        <TooltipContent className="rounded-full border-primary/30 bg-card/95 px-3 py-1 text-xs font-medium shadow-lg backdrop-blur">
          <p>команда сайта</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
});

AdminBadge.displayName = 'AdminBadge';
