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

function ConversationSkeletonCard({ isCollapsed = false }: { isCollapsed?: boolean }) {
  if (isCollapsed) {
    return (
      <div className="conversation-card" aria-hidden="true">
        <div className="avatar-wrapper">
          <Skeleton pulse={false} className="avatar h-11 w-11 rounded-full" />
        </div>
      </div>
    );
  }
  return (
    <div className="conversation-card" aria-hidden="true">
      <div className="avatar-wrapper">
        <Skeleton pulse={false} className="avatar h-11 w-11 rounded-full" />
      </div>
      <div className="conversation-copy min-w-0 overflow-hidden">
        <div className="conversation-head">
          <Skeleton pulse={false} className="h-3.5 w-28" />
          <Skeleton pulse={false} className="h-3 w-12" />
        </div>
        <div className="conversation-meta">
          <Skeleton pulse={false} className="h-3 w-full max-w-[180px]" />
          <Skeleton pulse={false} className="ml-auto h-5 w-5 rounded-full" />
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
            <Skeleton pulse={false} className="avatar notes-avatar h-11 w-11 rounded-full" />
          </div>
          {!isCollapsed && (
            <div className="conversation-copy min-w-0 overflow-hidden">
              <Skeleton pulse={false} className="h-3.5 w-20" />
              <Skeleton pulse={false} className="mt-2 h-3 w-3/4 max-w-[200px]" />
            </div>
          )}
        </div>
        {Array.from({ length: count }).map((_, i) => (
          <ConversationSkeletonCard key={i} isCollapsed={isCollapsed} />
        ))}
      </div>
    </div>
  );
}

export function ProfileSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 sm:gap-4">
          <Skeleton className="w-14 h-14 sm:w-20 sm:h-20 rounded-full shrink-0" />
          <div className="space-y-2 flex-1">
            <Skeleton className="h-6 sm:h-7 w-48" />
            <Skeleton className="h-4 w-32" />
          </div>
        </div>
        <Skeleton className="h-8 w-8 rounded-md shrink-0" />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4 p-3 sm:p-4 bg-post-header border border-border">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="space-y-1">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-6 sm:h-7 w-12" />
          </div>
        ))}
      </div>
      <div className="space-y-2">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
      <div className="border-b border-border">
        <div className="flex gap-0">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-10 px-6 shrink-0" />
          ))}
        </div>
      </div>
    </div>
  );
}
