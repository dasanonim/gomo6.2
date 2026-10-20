import { useEffect, useMemo, useState } from "react";
import { Check, Loader2, Star } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { UserAvatar } from "@/components/UserAvatar";
import { storiesApi } from "@/services/storiesApi";
import { useStoriesStore } from "@/stores/storiesStore";
import type { StoryAuthor } from "@/types/stories";
import { cn } from "@/lib/utils";

export type CloseFriendsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * «Избранные» — the audience behind privacy=close_friends. The server only
 * accepts mutual friends, so this list is built from the friends endpoint and
 * whatever is saved is the authoritative set returned by the server.
 */
export function CloseFriendsDialog({ open, onOpenChange }: CloseFriendsDialogProps) {
  const { t } = useTranslation();
  const loadCloseFriends = useStoriesStore((state) => state.loadCloseFriends);
  const saveCloseFriends = useStoriesStore((state) => state.saveCloseFriends);

  const [friends, setFriends] = useState<StoryAuthor[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void Promise.all([storiesApi.friends(), loadCloseFriends(true)])
      .then(([list, chosen]) => {
        if (cancelled) return;
        setFriends(list);
        setSelected(new Set(chosen.map((friend) => friend.id)));
      })
      .catch(() => {
        if (!cancelled) setError(t("stories.errorLoadFriends"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, loadCloseFriends, t]);

  const selectedCount = useMemo(() => selected.size, [selected]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await saveCloseFriends(Array.from(selected));
      onOpenChange(false);
    } catch {
      setError(t("stories.errorSaveFriends"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="z-[260] sm:max-w-md" overlayClassName="z-[250]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Star className="h-4 w-4 text-[var(--story-ring-close-to)]" />
            {t("stories.closeFriendsTitle")}
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{t("stories.closeFriendsHint")}</p>

        <div className="max-h-[45vh] overflow-y-auto rounded-lg border border-border/70">
          {loading ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : friends.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              {t("stories.closeFriendsEmpty")}
            </p>
          ) : (
            friends.map((friend) => {
              const active = selected.has(friend.id);
              return (
                <button
                  key={friend.id}
                  type="button"
                  onClick={() => toggle(friend.id)}
                  aria-pressed={active}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-muted/60"
                >
                  <UserAvatar
                    src={friend.avatar_url}
                    userId={friend.id}
                    alt={friend.username}
                    className="h-9 w-9"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {friend.display_name || friend.username}
                  </span>
                  <span
                    className={cn(
                      "grid h-5 w-5 place-items-center rounded-full border",
                      active
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border",
                    )}
                  >
                    {active && <Check className="h-3 w-3" strokeWidth={3} />}
                  </span>
                </button>
              );
            })
          )}
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">
            {t("stories.closeFriendsSelected", { count: selectedCount })}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={save} disabled={saving || loading}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("common.save")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
