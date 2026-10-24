import { Skeleton } from "@/components/ui/skeleton";
import { PostCardActions, PostCardHeading, PostCardShell } from "@/components/post/PostCardChrome";

export function StoriesRailSkeleton() {
  return (
    <div
      className="mb-4 flex gap-4 overflow-hidden"
      aria-hidden="true"
      data-testid="stories-rail-skeleton"
    >
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex w-[76px] shrink-0 flex-col items-center gap-2">
          <Skeleton pulse={false} className="h-12 w-12 rounded-full" />
          <Skeleton pulse={false} className="h-2 w-10" />
        </div>
      ))}
    </div>
  );
}

export function ThreadCardSkeleton({ showMedia = false }: { showMedia?: boolean }) {
  return (
    <PostCardShell>
      <PostCardHeading>
        <div className="flex items-center gap-3">
          <Skeleton pulse={false} className="h-8 w-8 shrink-0 rounded-full" />
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Skeleton pulse={false} className="h-3.5 w-24" />
            <Skeleton pulse={false} className="h-3 w-14" />
          </div>
          <Skeleton pulse={false} className="h-6 w-16 shrink-0 rounded-full" />
        </div>
        <Skeleton pulse={false} className="h-5 w-3/4" />
      </PostCardHeading>

      <div className="space-y-2">
        <Skeleton pulse={false} className="h-3.5 w-full" />
        <Skeleton pulse={false} className="h-3.5 w-5/6" />
      </div>

      {showMedia && (
        <Skeleton pulse={false} className="aspect-[16/9] w-full rounded-lg" />
      )}

      <PostCardActions>
        <Skeleton pulse={false} className="h-4 w-12 rounded-full" />
        <Skeleton pulse={false} className="h-4 w-12 rounded-full" />
        <Skeleton pulse={false} className="h-4 w-8 rounded-full" />
      </PostCardActions>
    </PostCardShell>
  );
}

export function ThreadFeedSkeleton({ count = 2 }: { count?: number }) {
  return (
    <div
      className="space-y-4"
      role="status"
      aria-label="Загружаем ленту"
      aria-busy="true"
      data-testid="feed-skeleton"
    >
      <span className="sr-only">Загружаем ленту</span>
      <div aria-hidden="true" className="space-y-4">
        {Array.from({ length: count }).map((_, i) => (
          <div key={i} data-testid="feed-post-skeleton">
            <ThreadCardSkeleton showMedia={i === 1} />
          </div>
        ))}
      </div>
    </div>
  );
}

const SKELETON_PREVIEW_WIDTHS = ["w-3/4", "w-1/2", "w-2/3", "w-5/6", "w-2/5", "w-3/5"];

function ConversationSkeletonCard({ index, isCollapsed = false }: { index: number; isCollapsed?: boolean }) {
  // Exact row geometry: 44px grid column + copy (name 14px + 11px time on the
  // head row, 12px preview + badge on the meta row). Only one row carries a
  // badge skeleton — a badge on every row reads as noise, not data.
  if (isCollapsed) {
    return (
      <div className="conversation-card" aria-hidden="true">
        <div className="avatar-wrapper">
          <Skeleton pulse={false} className="avatar" />
        </div>
      </div>
    );
  }
  return (
    <div className="conversation-card" aria-hidden="true">
      <div className="avatar-wrapper">
        <Skeleton pulse={false} className="avatar" />
      </div>
      <div className="conversation-copy">
        <div className="conversation-head">
          <Skeleton pulse={false} className="h-3.5 w-28" />
          <Skeleton pulse={false} className="h-2.5 w-10" />
        </div>
        <div className="conversation-meta">
          <Skeleton pulse={false} className={`h-3 ${SKELETON_PREVIEW_WIDTHS[index % SKELETON_PREVIEW_WIDTHS.length]}`} />
          {index === 1 && <Skeleton pulse={false} className="h-5 w-5 rounded-full" />}
        </div>
      </div>
    </div>
  );
}

export function ConversationListSkeleton({
  count = 6,
  isCollapsed = false,
}: {
  count?: number;
  isCollapsed?: boolean;
}) {
  return (
    <div
      className="conversation-list"
      role="status"
      aria-label="Загружаем диалоги"
      aria-busy="true"
      data-testid="conversation-list-skeleton"
    >
      <span className="sr-only">Загружаем диалоги</span>
      <div aria-hidden="true" className="contents">
        <div className="conversation-card notes-card">
          <div className="avatar-wrapper">
            <Skeleton pulse={false} className="avatar" />
          </div>
          {!isCollapsed && (
            <div className="conversation-copy">
              <div className="conversation-head">
                <Skeleton pulse={false} className="h-3.5 w-20" />
                <Skeleton pulse={false} className="h-2.5 w-10" />
              </div>
              <div className="conversation-meta">
                <Skeleton pulse={false} className="h-3 w-2/3" />
              </div>
            </div>
          )}
        </div>
        {Array.from({ length: count }).map((_, i) => (
          <ConversationSkeletonCard key={i} index={i} isCollapsed={isCollapsed} />
        ))}
      </div>
    </div>
  );
}

export function ProfileSkeleton() {
  // Mirrors the real social layout 1:1 (ProfileHeader + inline ProfileStats
  // row + bio + tab bar pills) so the row fades in without reflow.
  return (
    <div className="space-y-6" aria-hidden="true">
      {/* header: avatar + identity + action */}
      <div className="flex items-center justify-between gap-2 sm:gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-3 sm:gap-4">
          <Skeleton pulse={false} className="h-14 w-14 sm:h-20 sm:w-20 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton pulse={false} className="h-6 sm:h-7 w-44 max-w-full" />
            <div className="flex items-center gap-2">
              <Skeleton pulse={false} className="h-4 w-24" />
              <Skeleton pulse={false} className="h-4 w-16 rounded-full" />
            </div>
          </div>
        </div>
        <Skeleton pulse={false} className="h-9 w-9 shrink-0 rounded-xl" />
      </div>
      {/* stats: X-style inline row, ActiEye pinned right */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {["w-14", "w-10", "w-12", "w-10"].map((w, i) => (
            <span key={i} className="inline-flex items-center gap-2">
              {i > 0 && <span className="text-muted-foreground/50 select-none">·</span>}
              <span className="inline-flex items-baseline gap-1">
                <Skeleton pulse={false} className={`h-4 ${w}`} />
                <Skeleton pulse={false} className="h-3 w-12" />
              </span>
            </span>
          ))}
        </div>
        <Skeleton pulse={false} className="size-8 sm:size-12 shrink-0 rounded-full" />
      </div>
      {/* bio */}
      <div className="space-y-2">
        <Skeleton pulse={false} className="h-4 w-full" />
        <Skeleton pulse={false} className="h-4 w-5/6" />
      </div>
      {/* tab bar pills */}
      <div className="border-b border-border">
        <div className="flex gap-1 min-w-max px-1.5 py-1">
          {["w-16", "w-20", "w-24", "w-14"].map((w, i) => (
            <span key={i} className="flex items-center gap-1.5 rounded-lg px-2.5 sm:px-3 py-2">
              <Skeleton pulse={false} className="h-4 w-4 rounded" />
              <Skeleton pulse={false} className={`h-4 ${w}`} />
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
