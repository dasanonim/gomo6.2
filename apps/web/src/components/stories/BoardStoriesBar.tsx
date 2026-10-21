import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useStoriesStore } from "@/stores/storiesStore";
import { hasUnreadCloseFriends } from "@/types/stories";
import { StoryAvatar } from "./StoryAvatar";
import { useOwnerStories } from "./useOwnerStories";

export type BoardStoriesBarProps = {
  boardId: string;
  boardName: string;
  avatarUrl?: string | null;
  /** Board owner or a role carrying can_post_stories. */
  canPost: boolean;
};

/**
 * GomoSub stories entry: a single circle with the community's ring plus an
 * "add" action for owners and story publishers. Rendered under the community
 * header; hidden entirely for a member who can neither watch nor post.
 */
export function BoardStoriesBar({ boardId, boardName, avatarUrl, canPost }: BoardStoriesBarProps) {
  const { t } = useTranslation();
  const { stories } = useOwnerStories("gosub", boardId);
  const openComposer = useStoriesStore((state) => state.openComposer);

  if (stories.length === 0 && !canPost) return null;

  const add = () =>
    openComposer({ ownerType: "gosub", ownerId: boardId, ownerName: boardName });

  return (
    <div className="flex items-center gap-3 rounded-[var(--card-radius)] border border-border/70 bg-surface px-3 py-2 sm:px-4">
      <StoryAvatar
        ownerType="gosub"
        ownerId={boardId}
        ownerName={boardName}
        avatarUrl={avatarUrl}
        stories={stories}
        size="sm"
        showAdd={canPost}
        origin="board"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{t("stories.boardTitle")}</p>
        <p className="truncate text-xs text-muted-foreground">
          {stories.length > 0
            ? t("stories.boardLive", { count: stories.length })
            : t("stories.boardEmpty")}
        </p>
      </div>
      {canPost && (
        <Button size="sm" variant="outline" onClick={add} className="shrink-0">
          <Plus className="mr-1 h-4 w-4" />
          <span className="hidden sm:inline">{t("stories.boardAdd")}</span>
        </Button>
      )}
      {hasUnreadCloseFriends(stories) && (
        <span className="sr-only">{t("stories.boardCloseFriends")}</span>
      )}
    </div>
  );
}
