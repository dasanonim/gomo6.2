import { useEffect, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { Eye, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { UserAvatar } from "@/components/UserAvatar";
import { useDateLocale } from "@/i18n/dateLocale";
import { storiesApi } from "@/services/storiesApi";
import { safeDate } from "@/utils/safeDate";
import type { Story, StoryViewerEntry } from "@/types/stories";

export type StoryViewersSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  story: Story | null;
};

/** The author's viewers list — newest first, keyset-paginated by the server. */
export function StoryViewersSheet({ open, onOpenChange, story }: StoryViewersSheetProps) {
  const { t } = useTranslation();
  const dateLocale = useDateLocale();
  const [viewers, setViewers] = useState<StoryViewerEntry[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!open || !story) return;
    let cancelled = false;
    setLoading(true);
    setError(false);
    setViewers([]);
    setCursor(undefined);
    void storiesApi
      .viewers(story.id, { limit: 50 })
      .then((page) => {
        if (cancelled) return;
        setViewers(page.viewers);
        setCursor(page.next_before);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, story]);

  const loadMore = async () => {
    if (!story || !cursor) return;
    setLoadingMore(true);
    try {
      const page = await storiesApi.viewers(story.id, { before: cursor, limit: 50 });
      setViewers((prev) => [...prev, ...page.viewers]);
      setCursor(page.next_before);
    } catch {
      setError(true);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="z-[260] gap-0 overflow-hidden p-0 sm:max-w-md" overlayClassName="z-[250]">
        <div className="flex items-start gap-3 border-b border-border/60 px-5 pb-4 pr-12 pt-5">
          <span className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
            <Eye className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <DialogTitle className="flex items-center gap-2 text-base font-semibold">
              {t("stories.viewersTitle")}
              {story && story.views_count > 0 && (
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium tabular-nums text-muted-foreground">
                  {story.views_count}
                </span>
              )}
            </DialogTitle>
            <p className="mt-1 text-[13px] leading-5 text-muted-foreground">
              {t("stories.viewersHint")}
            </p>
          </div>
        </div>

        <div className="max-h-[50vh] min-h-[8rem] overflow-y-auto px-2 py-2">
          {loading ? (
            <div className="flex justify-center py-10 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : error ? (
            <p className="px-3 py-8 text-center text-sm text-destructive">
              {t("stories.errorLoadViewers")}
            </p>
          ) : viewers.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-4 py-8 text-center text-muted-foreground">
              <Eye className="h-6 w-6 opacity-60" />
              <p className="text-sm">{t("stories.viewersEmpty")}</p>
            </div>
          ) : (
            <ul className="space-y-0.5">
              {viewers.map((viewer) => (
                <li
                  key={viewer.user.id}
                  className="flex items-center gap-3 rounded-xl px-3 py-2 transition-colors hover:bg-muted/50"
                >
                  <UserAvatar
                    src={viewer.user.avatar_url}
                    userId={viewer.user.id}
                    alt={viewer.user.username}
                    className="h-10 w-10"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {viewer.user.display_name || viewer.user.username}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      @{viewer.user.username}
                    </p>
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatDistanceToNow(safeDate(viewer.viewed_at), {
                      addSuffix: true,
                      locale: dateLocale,
                    })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {cursor && !loading && (
          <div className="border-t border-border/60 px-5 py-3">
            <Button
              variant="outline"
              className="w-full rounded-full"
              onClick={loadMore}
              disabled={loadingMore}
            >
              {loadingMore && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("stories.viewersMore")}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
