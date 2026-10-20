import { useEffect, useMemo, useState } from "react";
import { Check, Loader2, Search, Star, Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { UserAvatar } from "@/components/UserAvatar";
import { cn } from "@/lib/utils";
import { storiesApi } from "@/services/storiesApi";
import { useStoriesStore } from "@/stores/storiesStore";
import type { StoryAuthor } from "@/types/stories";

export type CloseFriendsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * «Избранные» — the audience behind privacy=close_friends. Built from the
 * friends endpoint (the server only accepts mutual friends), with a live filter
 * so a long list stays usable on a phone.
 */
export function CloseFriendsDialog({ open, onOpenChange }: CloseFriendsDialogProps) {
  const { t } = useTranslation();
  const loadCloseFriends = useStoriesStore((state) => state.loadCloseFriends);
  const saveCloseFriends = useStoriesStore((state) => state.saveCloseFriends);

  const [friends, setFriends] = useState<StoryAuthor[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setQuery("");
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

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return friends;
    return friends.filter(
      (friend) =>
        friend.username.toLowerCase().includes(needle) ||
        (friend.display_name ?? "").toLowerCase().includes(needle),
    );
  }, [friends, query]);

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
      <DialogContent className="z-[260] gap-0 overflow-hidden p-0 sm:max-w-md" overlayClassName="z-[250]">
        <div className="flex items-start gap-3 border-b border-border/60 px-5 pb-4 pr-12 pt-5">
          <span className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[var(--story-ring-close-to)]/15 text-[var(--story-ring-close-to)]">
            <Star className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-base font-semibold">
              {t("stories.closeFriendsTitle")}
            </DialogTitle>
            <p className="mt-1 text-[13px] leading-5 text-muted-foreground">
              {t("stories.closeFriendsHint")}
            </p>
          </div>
          <span className="mt-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium tabular-nums text-muted-foreground">
            {selected.size}
          </span>
        </div>

        <div className="px-5 py-3">
          <div className="flex items-center gap-2 rounded-full border border-border/70 bg-background px-3 py-2 focus-within:ring-2 focus-within:ring-primary/30">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("stories.closeFriendsSearch")}
              aria-label={t("stories.closeFriendsSearch")}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
        </div>

        <div className="max-h-[45vh] min-h-[8rem] overflow-y-auto px-2 pb-2">
          {loading ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : error ? (
            <p className="px-3 py-8 text-center text-sm text-destructive">{error}</p>
          ) : visible.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-4 py-8 text-center text-muted-foreground">
              <Users className="h-6 w-6 opacity-60" />
              <p className="text-sm">
                {friends.length === 0 ? t("stories.closeFriendsEmpty") : t("stories.closeFriendsNotFound")}
              </p>
            </div>
          ) : (
            <ul className="space-y-0.5">
              {visible.map((friend) => {
                const active = selected.has(friend.id);
                return (
                  <li key={friend.id}>
                    <button
                      type="button"
                      onClick={() => toggle(friend.id)}
                      aria-pressed={active}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors",
                        active ? "bg-primary/10" : "hover:bg-muted/60",
                      )}
                    >
                      <UserAvatar
                        src={friend.avatar_url}
                        userId={friend.id}
                        alt={friend.username}
                        className="h-10 w-10"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {friend.display_name || friend.username}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          @{friend.username}
                        </span>
                      </span>
                      <span
                        className={cn(
                          "grid h-6 w-6 shrink-0 place-items-center rounded-full border-2 transition-colors",
                          active
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border",
                        )}
                      >
                        {active && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border/60 px-5 py-3">
          <span className="text-xs text-muted-foreground">
            {t("stories.closeFriendsSelected", { count: selected.size })}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" className="rounded-full" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button size="sm" className="rounded-full px-4" onClick={save} disabled={saving || loading}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("common.save")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
