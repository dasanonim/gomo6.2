import { useMemo, type MouseEvent } from "react";
import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { UserAvatar } from "@/components/UserAvatar";
import { cn } from "@/lib/utils";
import { useStoriesStore } from "@/stores/storiesStore";
import {
  hasUnreadCloseFriends,
  isStoryLive,
  type Story,
  type StoryOwnerType,
} from "@/types/stories";
import { StoryRing } from "./StoryRing";

const SIZES = {
  xs: "h-8 w-8",
  sm: "h-10 w-10",
  md: "h-12 w-12",
  lg: "h-14 w-14",
  xl: "h-20 w-20",
} as const;

export type StoryAvatarSize = keyof typeof SIZES;

export type StoryAvatarProps = {
  ownerType: StoryOwnerType;
  ownerId: string;
  /** Owner display name — the ring's accessible label and composer title. */
  ownerName: string;
  avatarUrl?: string | null;
  /** User id for the avatar-override store (freshly uploaded avatars). */
  userId?: string | null;
  stories: Story[];
  size?: StoryAvatarSize;
  /** Show the "+" badge / open the composer when the owner has no live story. */
  showAdd?: boolean;
  className?: string;
  origin?: string;
};

/**
 * The avatar circle with a stories ring — the single entry point used by the
 * rail, the profile header and the GomoSub header.
 *
 * Clicking opens the viewer at the first unread slide (or the first slide when
 * everything is read). With no live slides and `showAdd`, it opens the
 * composer instead, which is how "your story" is created from the rail.
 */
export function StoryAvatar({
  ownerType,
  ownerId,
  ownerName,
  avatarUrl,
  userId,
  stories,
  size = "md",
  showAdd = false,
  className,
  origin = "rail",
}: StoryAvatarProps) {
  const { t } = useTranslation();
  const openViewer = useStoriesStore((s) => s.openViewer);
  const openComposer = useStoriesStore((s) => s.openComposer);

  const live = useMemo(() => stories.filter((story) => isStoryLive(story)), [stories]);
  const read = live.filter((story) => story.is_viewed).length;
  const closeFriends = hasUnreadCloseFriends(live);
  const firstUnread = live.find((story) => !story.is_viewed) ?? live[0];
  const canAdd = showAdd && live.length === 0;

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (live.length === 0) {
      if (showAdd) openComposer({ ownerType, ownerId, ownerName });
      return;
    }
    openViewer({ ownerType, ownerId, ownerName, storyId: firstUnread.id, origin });
  };

  const label = live.length
    ? t("stories.openOwner", { name: ownerName })
    : showAdd
      ? t("stories.addYourStory")
      : ownerName;

  return (
    <StoryRing total={live.length} read={read} closeFriends={closeFriends} className={className}>
      <button
        type="button"
        onClick={handleClick}
        aria-label={label}
        title={label}
        className={cn(
          "relative grid place-items-center overflow-visible rounded-full bg-muted ring-2 ring-background transition-transform duration-150 hover:scale-[1.03] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/40 active:scale-95",
          SIZES[size],
        )}
      >
        <UserAvatar
          src={avatarUrl}
          userId={userId}
          alt={ownerName}
          className="h-full w-full"
        />
        {canAdd && (
          <span className="absolute -bottom-0.5 -right-0.5 grid h-5 w-5 place-items-center rounded-full border-2 border-background bg-primary text-primary-foreground">
            <Plus className="h-3 w-3" strokeWidth={3} />
          </span>
        )}
      </button>
    </StoryRing>
  );
}
