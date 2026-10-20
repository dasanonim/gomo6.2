import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { formatDistanceToNow } from "date-fns";
import {
  ChevronLeft,
  ChevronRight,
  Eye,
  Loader2,
  MoreVertical,
  Pause,
  Send,
  Trash2,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { UserAvatar } from "@/components/UserAvatar";
import { useDateLocale } from "@/i18n/dateLocale";
import { useStoriesStore, type StoryViewerState } from "@/stores/storiesStore";
import {
  STORY_REACTIONS,
  type Story,
  type StoryPrivacy,
  isStoryLive,
  ownerKey,
} from "@/types/stories";
import { safeDate } from "@/utils/safeDate";
import { storageUrl } from "@/utils/storage";
import { StoryPrivacyBadge, StoryPrivacyPicker } from "./StoryPrivacyPicker";
import { StoryViewersSheet } from "./StoryViewersSheet";
import { storyPresetBackground } from "./storyPresets";
import { useStoryProgress } from "./useStoryProgress";
import "./stories.css";

const IMAGE_DURATION_MS = 6000;
const EMPTY_STORIES: Story[] = [];
const SWIPE_CLOSE_PX = 120;
const HOLD_MS = 220;
/** Slide transition lock; also swallows click+pointerup double events. */
const NAV_LOCK_MS = 180;

/** Slides that are gone (deleted, expired, hidden mid-session) are skipped. */
function resolveStory(state: ReturnType<typeof useStoriesStore.getState>, viewer: StoryViewerState) {
  const list = state.byOwner[ownerKey(viewer.ownerType, viewer.ownerId)] ?? [];
  return list.find((story) => story.id === viewer.storyId && isStoryLive(story)) ?? null;
}

/**
 * Full-screen stories player. Mounted once at the app root; it renders only
 * while the store has an open viewer, so the feed underneath keeps its scroll
 * position.
 */
export function StoryViewer() {
  const viewer = useStoriesStore((state) => state.viewer);
  const viewerOpen = Boolean(viewer);

  useEffect(() => {
    if (!viewerOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [viewerOpen]);

  if (!viewer) return null;
  return createPortal(
    <StoryViewerInner
      key={`${viewer.ownerType}:${viewer.ownerId}:${viewer.storyId}`}
      viewer={viewer}
    />,
    document.body,
  );
}

function StoryViewerInner({ viewer }: { viewer: StoryViewerState }) {
  const { t } = useTranslation();
  const locale = useDateLocale();
  const navigate = useNavigate();

  const story = useStoriesStore((state) => resolveStory(state, viewer));
  const loadUserStories = useStoriesStore((state) => state.loadUserStories);
  const loadBoardStories = useStoriesStore((state) => state.loadBoardStories);
  const markViewed = useStoriesStore((state) => state.markViewed);
  const closeViewer = useStoriesStore((state) => state.closeViewer);
  const viewerNext = useStoriesStore((state) => state.viewerNext);
  const viewerPrev = useStoriesStore((state) => state.viewerPrev);
  const react = useStoriesStore((state) => state.react);
  const removeStory = useStoriesStore((state) => state.removeStory);
  const updateStory = useStoriesStore((state) => state.updateStory);

  // A quick tap (prev/next) and a long press (pause) start with the same
  // pointerdown. Pausing immediately made the pause badge flash on every tap,
  // so the hold only engages after HOLD_MS — the same threshold that decides
  // "tap = navigate, hold = pause".
  const [holding, setHolding] = useState(false);
  const [pausedBySpace, setPausedBySpace] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [viewersOpen, setViewersOpen] = useState(false);
  const [muted, setMuted] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const holdTimerRef = useRef<number | null>(null);
  const dragRef = useRef(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const activeBarRef = useRef<HTMLSpanElement | null>(null);
  const progressTrackRef = useRef<HTMLDivElement | null>(null);
  const pointerStart = useRef<{
    x: number;
    y: number;
    at: number;
    moved: boolean;
    onButton: boolean;
  } | null>(null);
  // Two inputs can mean one intent (click + pointerup, or a fast double tap).
  // A short lock mirrors Telegram's slide transition and stops the player from
  // skipping a slide or closing on a stray second event.
  const navLockRef = useRef(0);

  // The slide may not be in the store yet (deep link, a group the rail has not
  // fetched). One owner-scoped fetch is enough; a 404/timeout shows the error
  // state instead of an endless spinner.
  useEffect(() => {
    if (story) return;
    let cancelled = false;
    const request =
      viewer.ownerType === "gosub"
        ? loadBoardStories(viewer.ownerId)
        : loadUserStories(viewer.ownerId);
    const timeout = window.setTimeout(() => {
      if (!cancelled) setLoadFailed(true);
    }, 8000);
    void request
      .then(() => {
        if (!cancelled && !resolveStory(useStoriesStore.getState(), viewer)) setLoadFailed(true);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      })
      .finally(() => window.clearTimeout(timeout));
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [story, viewer, loadBoardStories, loadUserStories]);

  useEffect(() => {
    if (story) void markViewed(story);
  }, [story?.id, story, markViewed]);

  useEffect(() => {
    const onHidden = () => setHidden(document.visibilityState === "hidden");
    onHidden();
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      if (holdTimerRef.current !== null) window.clearTimeout(holdTimerRef.current);
    };
  }, []);

  const overlayOpen = menuOpen || privacyOpen || deleteOpen || viewersOpen;
  const isPaused = holding || pausedBySpace || hidden || overlayOpen;
  const showPauseBadge = holding || pausedBySpace || overlayOpen;

  const navigateOnce = useCallback((move: () => void) => {
    const now = Date.now();
    if (now - navLockRef.current < NAV_LOCK_MS) return;
    navLockRef.current = now;
    move();
  }, []);

  const goNext = useCallback(() => navigateOnce(viewerNext), [navigateOnce, viewerNext]);
  const goPrev = useCallback(() => navigateOnce(viewerPrev), [navigateOnce, viewerPrev]);

  const isVideo = story?.kind === "video";
  useStoryProgress({
    duration: story && !isVideo ? IMAGE_DURATION_MS : 0,
    paused: isPaused,
    onComplete: goNext,
    resetKey: story?.id ?? "none",
    targetRef: activeBarRef,
    ariaRef: progressTrackRef,
  });

  // The video bar follows the element's own clock on every frame: pausing or
  // buffering stops `currentTime`, so the bar freezes with the picture, and a
  // 60-second clip still gets a smooth bar (timeupdate alone fires ~4×/s).
  useEffect(() => {
    if (!isVideo || !story) return;
    let frame = 0;
    const tick = () => {
      const video = videoRef.current;
      if (video && video.duration > 0) {
        const value = Math.min(1, video.currentTime / video.duration);
        if (activeBarRef.current) activeBarRef.current.style.transform = `scaleX(${value})`;
        progressTrackRef.current?.setAttribute("aria-valuenow", String(Math.round(value * 100)));
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [isVideo, story]);

  // Video follows the element's own clock: pausing the element pauses the bar,
  // and buffering cannot desynchronise the two.
  useEffect(() => {
    if (!isVideo) return;
    const video = videoRef.current;
    if (!video) return;
    if (isPaused) video.pause();
    else void video.play().catch(() => undefined);
  }, [isPaused, isVideo, story?.id]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeViewer();
      else if (event.key === "ArrowRight") goNext();
      else if (event.key === "ArrowLeft") goPrev();
      else if (event.key === " ") {
        event.preventDefault();
        setPausedBySpace((value) => !value);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeViewer, goNext, goPrev]);

  // Warm the next slide (and the next owner's first slide) so navigation feels
  // instant — the same idea as Telegram's story preloader.
  useEffect(() => {
    if (!story) return;
    const list = useStoriesStore.getState().byOwner[ownerKey(viewer.ownerType, viewer.ownerId)] ?? [];
    const index = list.findIndex((candidate) => candidate.id === story.id);
    const next = list[index + 1];
    if (next?.kind === "photo" && next.media_key) {
      const img = new Image();
      img.src = storageUrl("stories", next.media_key) || "";
    }
  }, [story, viewer.ownerType, viewer.ownerId]);

  const groups = useStoriesStore((state) => state.rail);
  const group = useMemo(
    () =>
      groups.find(
        (candidate) =>
          candidate.owner.type === viewer.ownerType && candidate.owner.id === viewer.ownerId,
      ),
    [groups, viewer.ownerType, viewer.ownerId],
  );
  // Index from the owner's live list, not from the rail group: a story opened
  // from a profile (or a board) is not necessarily in the rail.
  const ownerStories = useStoriesStore(
    (state) => state.byOwner[ownerKey(viewer.ownerType, viewer.ownerId)] ?? EMPTY_STORIES,
  );
  const slideIndex = ownerStories.findIndex((candidate) => candidate.id === story?.id);
  const totalSlides = ownerStories.length;

  if (!story) {
    return (
      <div
        className="fixed inset-0 z-[200] flex items-center justify-center bg-black text-white"
        role="dialog"
        aria-modal="true"
        aria-label={t("stories.viewerTitle")}
      >
        {loadFailed ? (
          <div className="space-y-3 text-center">
            <p className="text-sm text-white/80">{t("stories.unavailable")}</p>
            <Button variant="secondary" size="sm" onClick={closeViewer}>
              {t("common.close")}
            </Button>
          </div>
        ) : (
          <Loader2 className="h-7 w-7 animate-spin text-white/70" />
        )}
      </div>
    );
  }

  const ownerName =
    group?.owner.name ??
    viewer.ownerName ??
    story.author?.display_name ??
    story.author?.username ??
    "";
  const isGosub = story.owner_type === "gosub";
  const canEdit = story.is_own;

  const onPointerDown = (event: ReactPointerEvent) => {
    const target = event.target as HTMLElement | null;
    pointerStart.current = {
      x: event.clientX,
      y: event.clientY,
      at: Date.now(),
      moved: false,
      onButton: Boolean(target?.closest("button")),
    };
    if (holdTimerRef.current !== null) window.clearTimeout(holdTimerRef.current);
    holdTimerRef.current = window.setTimeout(() => setHolding(true), HOLD_MS);
  };
  const onPointerMove = (event: ReactPointerEvent) => {
    const start = pointerStart.current;
    if (!start) return;
    const dy = event.clientY - start.y;
    if (Math.abs(dy) > 8) start.moved = true;
    if (dy > 0 && Math.abs(dy) > Math.abs(event.clientX - start.x)) {
      // Direct write: a swipe produces ~60 pointer events/second and must not
      // re-render the player each time.
      dragRef.current = dy;
      if (rootRef.current) {
        rootRef.current.style.transition = "none";
        rootRef.current.style.transform = `translateY(${dy}px)`;
      }
    }
  };
  const onPointerUp = (event: ReactPointerEvent) => {
    const start = pointerStart.current;
    pointerStart.current = null;
    if (holdTimerRef.current !== null) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    setHolding(false);
    if (!start) return;
    const dragged = dragRef.current;
    dragRef.current = 0;
    if (rootRef.current) {
      rootRef.current.style.transition = "transform 180ms ease";
      rootRef.current.style.transform = "";
    }
    if (dragged > SWIPE_CLOSE_PX) {
      closeViewer();
      return;
    }
    // A press that STARTED on a control (prev/next/close) navigates through
    // that control's click handler; running the half-screen tap too would
    // double-advance and, at the end of the queue, close the viewer.
    if (start.onButton) return;
    const held = Date.now() - start.at;
    if (held < HOLD_MS && !start.moved) {
      const rect = event.currentTarget.getBoundingClientRect();
      const x = event.clientX - rect.left;
      if (x < rect.width / 2) goPrev();
      else goNext();
    }
  };

  const onDelete = async () => {
    setDeleteOpen(false);
    await removeStory(story).catch(() => undefined);
    viewerNext();
  };

  const onSavePrivacy = async (privacy: StoryPrivacy) => {
    setPrivacyOpen(false);
    await updateStory(story, { privacy }).catch(() => undefined);
  };

  return (
    <div
      ref={rootRef}
      className="fixed inset-0 z-[200] flex flex-col bg-black text-white"
      role="dialog"
      aria-modal="true"
      aria-label={t("stories.viewerTitle")}
      data-testid="story-viewer"
    >
      {/* Header */}
      <div className="relative z-20 flex items-start gap-3 px-3 pt-[max(0.75rem,env(safe-area-inset-top))] sm:px-5">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <UserAvatar
            src={group?.owner.avatar_url ?? story.author?.avatar_url}
            userId={isGosub ? null : story.author_id}
            alt={ownerName}
            className="h-9 w-9 border border-white/20"
          />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{ownerName}</p>
            <p className="flex items-center gap-1.5 truncate text-[11px] text-white/70">
              {isGosub && story.author && <span>@{story.author.username}</span>}
              <span>
                {formatDistanceToNow(safeDate(story.created_at), {
                  addSuffix: true,
                  locale,
                })}
              </span>
              {story.is_own && <StoryPrivacyBadge privacy={story.privacy} />}
            </p>
          </div>
        </div>

        {isVideo && (
          <button
            type="button"
            onClick={() => setMuted((value) => !value)}
            aria-label={muted ? t("stories.unmute") : t("stories.mute")}
            className="grid h-9 w-9 place-items-center rounded-full bg-black/30 text-white transition-colors hover:bg-black/50"
          >
            {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
          </button>
        )}

        {canEdit && (
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={t("stories.menu")}
                className="grid h-9 w-9 place-items-center rounded-full bg-black/30 text-white transition-colors hover:bg-black/50"
              >
                <MoreVertical className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="z-[260]">
              {!isGosub && (
                <DropdownMenuItem onSelect={() => setPrivacyOpen(true)}>
                  {t("stories.menuPrivacy")}
                </DropdownMenuItem>
              )}
              {!isGosub && (
                <DropdownMenuItem
                  onSelect={() =>
                    void updateStory(story, { is_pinned: !story.is_pinned }).catch(() => undefined)
                  }
                >
                  {story.is_pinned ? t("stories.menuUnpin") : t("stories.menuPin")}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => setDeleteOpen(true)}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="mr-2 h-4 w-4" />
                {t("stories.menuDelete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        <button
          type="button"
          onClick={closeViewer}
          aria-label={t("common.close")}
          className="grid h-9 w-9 place-items-center rounded-full bg-black/30 text-white transition-colors hover:bg-black/50"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Progress segments */}
      <div
        ref={progressTrackRef}
        className="relative z-20 mt-2 flex gap-1 px-3 sm:px-5"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={0}
      >
        {Array.from({ length: Math.max(totalSlides, 1) }, (_, index) => {
          const before = slideIndex !== -1 && index < slideIndex;
          const current = index === slideIndex;
          return (
            <span key={index} className="h-0.5 flex-1 overflow-hidden rounded-full bg-white/30">
              {/* scaleX is written straight to the DOM by useStoryProgress —
                  no React render per frame. */}
              <span
                ref={current ? activeBarRef : undefined}
                className={`block h-full rounded-full bg-white ${before ? "scale-x-100" : "scale-x-0"}`}
                style={{ transformOrigin: "left center" }}
              />
            </span>
          );
        })}
      </div>

      {/* Media */}
      <div
        data-testid="story-media"
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {story.kind !== "text" && (
          // Telegram's desktop look: a blurred copy of the slide fills the
          // letterbox instead of flat black, so the media reads as a card.
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 scale-110 bg-cover bg-center opacity-25 blur-2xl"
            style={{
              backgroundImage: `url(${storageUrl("stories", story.preview_key ?? story.media_key) ?? ""})`,
            }}
          />
        )}
        {story.kind === "text" ? (
          <div
            className="flex h-full w-full items-center justify-center px-8 text-center text-2xl font-semibold sm:text-3xl"
            style={{ background: storyPresetBackground(story.text_style?.preset) }}
          >
            <p className="max-w-lg whitespace-pre-wrap break-words">{story.text}</p>
          </div>
        ) : isVideo ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption -- user stories carry no caption track
          <video
            ref={videoRef}
            src={story.media_key ? storageUrl("stories", story.media_key) ?? undefined : undefined}
            poster={story.preview_key ? storageUrl("stories", story.preview_key) ?? undefined : undefined}
            className="max-h-full max-w-full object-contain"
            playsInline
            autoPlay
            muted={muted}
            onEnded={goNext}
            data-testid="story-video"
          />
        ) : (
          <img
            src={story.media_key ? storageUrl("stories", story.media_key) ?? undefined : undefined}
            alt=""
            className="max-h-full max-w-full object-contain"
            data-testid="story-image"
          />
        )}

        {/* Tap zones (keyboard-accessible) */}
        <button
          type="button"
          aria-label={t("stories.previous")}
          onClick={goPrev}
          className="absolute left-0 top-0 z-10 flex h-full w-1/5 items-center justify-start pl-2 text-white/0 transition-colors hover:text-white/70 focus-visible:text-white/80"
        >
          <ChevronLeft className="h-6 w-6" />
        </button>
        <button
          type="button"
          aria-label={t("stories.next")}
          onClick={goNext}
          className="absolute right-0 top-0 z-10 flex h-full w-1/5 items-center justify-end pr-2 text-white/0 transition-colors hover:text-white/70 focus-visible:text-white/80"
        >
          <ChevronRight className="h-6 w-6" />
        </button>

        {showPauseBadge && (
          <span
            data-testid="story-paused"
            className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-black/40 p-4"
          >
            <Pause className="h-7 w-7" />
          </span>
        )}

        {/* Caption scrim */}
        {story.text && story.kind !== "text" && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/80 via-black/40 to-transparent px-4 pb-4 pt-16">
            <p className="mx-auto max-w-lg whitespace-pre-wrap break-words text-sm">{story.text}</p>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="relative z-20 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:px-5">
        {story.is_own ? (
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setViewersOpen(true)}
              className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-2 text-sm font-medium transition-colors hover:bg-white/20"
            >
              <Eye className="h-4 w-4" />
              {t("stories.viewsCount", { count: story.views_count })}
            </button>
            {story.reactions_count > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-white/10 px-3 py-2 text-sm">
                ❤️ {story.reactions_count}
              </span>
            )}
            {story.is_pinned && (
              <span className="text-xs text-white/60">{t("stories.pinnedHint")}</span>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-1" role="group" aria-label={t("stories.reactionsTitle")}>
              {STORY_REACTIONS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  aria-pressed={story.my_reaction === emoji}
                  aria-label={emoji}
                  onClick={() => void react(story, emoji)}
                  className={`grid h-9 w-9 place-items-center rounded-full text-lg transition-transform hover:scale-110 ${
                    story.my_reaction === emoji ? "bg-white/25" : "bg-white/10 hover:bg-white/20"
                  }`}
                >
                  {emoji}
                </button>
              ))}
            </div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="rounded-full"
              onClick={() => {
                closeViewer();
                if (story.author?.id) navigate(`/messages?user=${story.author.id}`);
              }}
            >
              <Send className="mr-1.5 h-4 w-4" />
              {t("stories.reply")}
            </Button>
          </div>
        )}
      </div>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent className="z-[260]" overlayClassName="z-[250]">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("stories.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("stories.deleteHint")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void onDelete()} className="bg-destructive text-destructive-foreground">
              {t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={privacyOpen} onOpenChange={setPrivacyOpen}>
        <DialogContent className="z-[260] sm:max-w-sm" overlayClassName="z-[250]">
          <DialogHeader>
            <DialogTitle>{t("stories.menuPrivacy")}</DialogTitle>
          </DialogHeader>
          <StoryPrivacyPicker value={story.privacy} onChange={(value) => void onSavePrivacy(value)} />
        </DialogContent>
      </Dialog>

      <StoryViewersSheet open={viewersOpen} onOpenChange={setViewersOpen} story={story} />
    </div>
  );
}
