import { useEffect, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { Eye, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Eye className="h-4 w-4" />
            {t("stories.viewersTitle")}
            {story && story.views_count > 0 && (
              <span className="text-sm font-normal text-muted-foreground">{story.views_count}</span>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="max-h-[55vh] overflow-y-auto">
          {loading ? (
            <div className="flex justify-center py-8 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : error ? (
            <p className="px-2 py-6 text-center text-sm text-destructive">
              {t("stories.errorLoadViewers")}
            </p>
          ) : viewers.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">
              {t("stories.viewersEmpty")}
            </p>
          ) : (
            <ul className="divide-y divide-border/60">
              {viewers.map((viewer) => (
                <li key={viewer.user.id} className="flex items-center gap-3 py-2">
                  <UserAvatar
                    src={viewer.user.avatar_url}
                    userId={viewer.user.id}
                    alt={viewer.user.username}
                    className="h-9 w-9"
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
          <Button variant="outline" onClick={loadMore} disabled={loadingMore}>
            {loadingMore && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t("stories.viewersMore")}
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}
