import { useCallback, useEffect, useState } from "react";
import { PinOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { CompactThreadList } from "@/components/CompactThreadList";
import { PostActionsMenu } from "@/components/PostActionsMenu";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import {
  useProfilePinnedThreads,
  useTogglePinnedThread,
} from "@/hooks/queries/useProfilePinnedThreads";
import { fetchThreadLikesBatch, type ThreadApiRow } from "@/utils/threadFeedItem";

interface ProfilePinnedThreadsProps {
  /** The profile whose pins are shown (owner's UUID). */
  userId: string;
  /** Whether the viewer owns this profile (unpin menu is owner-only). */
  isOwner: boolean;
  /** The viewer's id, for per-viewer like state on the rows. */
  currentUserId: string | null;
}

/**
 * «Закреплённые темы» (issue #518) — up to three threads the profile owner
 * curated, between the identity panel and the tab bar.
 *
 * The rows reuse the compact section-page list but stripped to the essentials:
 * no last-poster column, no bookmark, and the same opaque panel surface as the
 * page's other blocks. There is no heading — the block reads as a plain list of
 * threads above the tabs.
 *
 * The list is already visibility-filtered by the backend (the pin rows are gated
 * by the owner's profile privacy and the thread bodies by GET /threads), so a
 * thread the viewer may not read never reaches this component. An empty list
 * renders nothing for visitors and a short hint for the owner — the pin action
 * itself lives inside each thread's «три точки» menu, so the hint is the only
 * discovery path on the profile.
 */
export const ProfilePinnedThreads = ({
  userId,
  isOwner,
  currentUserId,
}: ProfilePinnedThreadsProps) => {
  const { t } = useTranslation();
  const { data: threads, isLoading } = useProfilePinnedThreads(userId);
  const [likes, setLikes] = useState<Map<string, { count: number; isLiked: boolean }>>(new Map());
  const togglePin = useTogglePinnedThread(currentUserId);

  const rows = threads ?? [];
  const ids = rows.map((row) => row.id).join(",");

  // Like counts for the pinned rows — one batch call, best-effort (the rows
  // simply start at 0 if it fails). Keyed by the joined ids so it re-runs only
  // when the set of pinned threads actually changes.
  useEffect(() => {
    const threadIds = ids ? ids.split(",") : [];
    if (threadIds.length === 0) {
      setLikes(new Map());
      return;
    }
    let cancelled = false;
    fetchThreadLikesBatch(threadIds, currentUserId).then((map) => {
      if (!cancelled) setLikes(map);
    });
    return () => {
      cancelled = true;
    };
  }, [ids, currentUserId]);

  const handleUnpin = useCallback(
    (threadId: string) => {
      togglePin.mutate(
        { threadId, pinned: false },
        {
          onSuccess: () => toast.success(t("profile.pinnedThreadUnpinned")),
          onError: () => toast.error(t("profile.pinnedThreadUnpinError")),
        },
      );
    },
    [togglePin, t],
  );

  // Nothing to show while the pins load (avoids an empty panel flashing above
  // the tabs), and nothing at all for a visitor when the profile has no pins.
  if (isLoading) return null;
  if (rows.length === 0 && !isOwner) return null;

  if (rows.length === 0) {
    return (
      <p className="surface-panel rounded-xl border border-dashed border-border/60 px-4 py-3 text-sm text-muted-foreground">
        {t("profile.pinnedThreadsEmpty")}
      </p>
    );
  }

  return (
    <section aria-label={t("profile.pinnedThreads")}>
      <CompactThreadList
        rows={rows as ThreadApiRow[]}
        likes={likes}
        currentUserId={currentUserId}
        // The profile rows are a plain curated list: no last-poster column, no
        // bookmark, and the same opaque panel surface as the page's other
        // blocks (the section page keeps the translucent default).
        hideLastPoster
        hideBookmark
        containerClassName="surface-panel rounded-xl border border-border/60 shadow-sm"
        renderRowActions={
          isOwner
            ? (row) => (
                <PostActionsMenu triggerTitle={t("profile.pinnedThreadMenu")}>
                  <DropdownMenuItem
                    onClick={() => handleUnpin(row.id)}
                    className="cursor-pointer px-3 py-2 transition-colors hover:bg-primary/15 hover:text-primary focus:bg-primary/15 focus:text-primary"
                    title={t("profile.unpinThreadFromProfile")}
                  >
                    <PinOff className="mr-3 h-4 w-4" />
                    {t("profile.unpinThreadFromProfile")}
                  </DropdownMenuItem>
                </PostActionsMenu>
              )
            : undefined
        }
      />
    </section>
  );
};
