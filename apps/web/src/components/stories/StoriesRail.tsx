import { useEffect, useMemo } from "react";
import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/hooks/useAuth";
import { useStoriesStore } from "@/stores/storiesStore";
import { StoryAvatar } from "./StoryAvatar";
import { useStoriesRealtime } from "./useStoriesRealtime";

/**
 * The stories rail above the feed — the same shape as Telegram's: your own
 * circle first (with "+" when you have nothing live), then everyone with an
 * unseen story, then the rest, newest first.
 *
 * The rail is fetched once per session and refreshed by the realtime bridge
 * when someone in it publishes.
 */
export function StoriesRail() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const rail = useStoriesStore((state) => state.rail);
  const openComposer = useStoriesStore((state) => state.openComposer);
  useStoriesRealtime(user?.id);
  const railLoaded = useStoriesStore((state) => state.railLoaded);
  const loadRail = useStoriesStore((state) => state.loadRail);

  useEffect(() => {
    if (!user?.id) return;
    void loadRail().catch(() => undefined);
  }, [user?.id, loadRail]);

  const ownGroup = useMemo(
    () => rail.find((group) => group.owner.type === "user" && group.owner.id === user?.id),
    [rail, user?.id],
  );

  if (!user?.id) return null;
  if (!railLoaded && rail.length === 0) {
    // Skeleton keeps the page from jumping once the rail arrives.
    return (
      <div className="mb-4 flex gap-4 overflow-hidden" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex w-[76px] shrink-0 flex-col items-center gap-2">
            <div className="h-12 w-12 animate-pulse rounded-full bg-muted" />
            <div className="h-2 w-10 animate-pulse rounded bg-muted" />
          </div>
        ))}
      </div>
    );
  }

  const ownName = user.username || t("stories.you");

  return (
    <nav aria-label={t("stories.railTitle")} className="mb-4">
      <div className="flex gap-4 overflow-x-auto px-1.5 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="flex w-[76px] shrink-0 flex-col items-center gap-1.5">
          <div className="relative">
            <StoryAvatar
              ownerType="user"
              ownerId={user.id}
              ownerName={ownName}
              avatarUrl={user.avatar_url}
              userId={user.id}
              stories={ownGroup?.stories ?? []}
              showAdd
              origin="rail"
            />
            {/* With a live story the "+" moves to a sibling button: the ring
                stays a viewer entry point, and a second slide is one tap away
                without hiding the entry point behind a menu. */}
            {ownGroup && ownGroup.stories.length > 0 && (
              <button
                type="button"
                onClick={() =>
                  openComposer({ ownerType: "user", ownerId: user.id, ownerName: ownName })
                }
                aria-label={t("stories.addYourStory")}
                title={t("stories.addYourStory")}
                className="absolute -bottom-0.5 -right-1 grid h-5 w-5 place-items-center rounded-full border-2 border-background bg-primary text-primary-foreground transition-transform hover:scale-105"
              >
                <Plus className="h-3 w-3" strokeWidth={3} />
              </button>
            )}
          </div>
          <span className="w-full truncate text-center text-[11px] text-foreground">
            {t("stories.yourStory")}
          </span>
        </div>

        {rail
          .filter((group) => !(group.owner.type === "user" && group.owner.id === user.id))
          .map((group) => (
            <div
              key={`${group.owner.type}:${group.owner.id}`}
              className="flex w-[76px] shrink-0 flex-col items-center gap-1.5"
            >
              <StoryAvatar
                ownerType={group.owner.type}
                ownerId={group.owner.id}
                ownerName={group.owner.name}
                avatarUrl={group.owner.avatar_url}
                userId={group.owner.type === "user" ? group.owner.id : undefined}
                stories={group.stories}
                origin="rail"
              />
              <span
                className={`w-full truncate text-center text-[11px] ${
                  group.has_unread ? "font-semibold text-foreground" : "text-muted-foreground"
                }`}
              >
                {group.owner.name}
              </span>
            </div>
          ))}
      </div>
    </nav>
  );
}
