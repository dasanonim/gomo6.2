import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  ChevronLeft,
  Globe2,
  ImagePlus,
  Loader2,
  Lock,
  Palette,
  Pause,
  Play,
  Send,
  Star,
  Type,
  Users,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { UserAvatar } from "@/components/UserAvatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/hooks/useAuth";
import { uploadFile } from "@/utils/storage";
import { useStoriesStore } from "@/stores/storiesStore";
import type { CreateStoryInput, StoryPrivacy, StoryTextStyle } from "@/types/stories";
import { CloseFriendsDialog } from "./CloseFriendsDialog";
import { VideoTimeline } from "./VideoTimeline";
import { useVideoFrames } from "./useVideoFrames";
import {
  STORY_TEXT_PRESETS,
  storyPresetBackground,
  type StoryTextPreset,
} from "./storyPresets";
import "./stories.css";

const MAX_VIDEO_SECONDS = 60;
const MAX_FILE_BYTES = 50 * 1024 * 1024;


type Mode = "media" | "text";

const AUDIENCES: Array<{ value: StoryPrivacy; icon: typeof Globe2; key: string }> = [
  { value: "everyone", icon: Globe2, key: "stories.privacyEveryone" },
  { value: "friends", icon: Users, key: "stories.privacyFriends" },
  { value: "close_friends", icon: Star, key: "stories.privacyCloseFriends" },
  { value: "only_me", icon: Lock, key: "stories.privacyOnlyMe" },
];

/**
 * Full-screen story composer, in the spirit of Telegram's: the slide is the
 * screen, the controls float over it, and everything else stays out of the way.
 *
 * Two slide kinds share one canvas — media (photo/video with a caption pill) and
 * text (typed straight onto the gradient) — and the audience lives in a compact
 * dropdown instead of a row of four buttons. A GomoSub story has no audience
 * picker: the board is the audience and the server enforces it.
 */
export function StoryComposer() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const target = useStoriesStore((state) => state.composer);
  const closeComposer = useStoriesStore((state) => state.closeComposer);
  const publish = useStoriesStore((state) => state.publish);
  const openViewer = useStoriesStore((state) => state.openViewer);
  const publishing = useStoriesStore((state) => state.publishing);

  const [mode, setMode] = useState<Mode>("media");
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isVideo, setIsVideo] = useState(false);
  const [videoDuration, setVideoDuration] = useState<number | null>(null);
  const [videoTime, setVideoTime] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [muted, setMuted] = useState(false);
  const [text, setText] = useState("");
  const [preset, setPreset] = useState<StoryTextPreset>("sunset");
  const [privacy, setPrivacy] = useState<StoryPrivacy>("everyone");
  const [progress, setProgress] = useState<number | null>(null);
  const [closeFriendsOpen, setCloseFriendsOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const textRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!target) return;
    setMode("media");
    setFile(null);
    setPreviewUrl(null);
    setIsVideo(false);
    setVideoDuration(null);
    setVideoTime(0);
    setPlaying(true);
    setMuted(true);
    setText("");
    setPreset("sunset");
    setPrivacy("everyone");
    setProgress(null);
  }, [target]);

  // Object URLs must be revoked or a long session leaks every picked file.
  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // Keep the contentEditable in sync when the composer reopens or the user
  // switches modes (typing itself is never written back into the node).
  useEffect(() => {
    const node = textRef.current;
    if (node && readEditable(node) !== text) node.innerText = text;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on mode/target changes
  }, [mode, target]);

  useEffect(() => {
    if (!isVideo || !previewUrl) return;
    const video = videoRef.current;
    if (!video) return;
    if (!playing) {
      video.pause();
      return;
    }
    void (async () => {
      video.muted = muted;
      try {
        const result = video.play();
        if (result && typeof result.then === "function") await result;
      } catch {
        // The preview may not autoplay with sound before the user interacts;
        // fall back to muted rather than a frozen frame.
        if (!muted) {
          video.muted = true;
          setMuted(true);
          try {
            await video.play();
          } catch {
            /* leave paused */
          }
        }
      }
    })();
  }, [playing, isVideo, previewUrl, muted]);

  useEffect(() => {
    if (!target) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [target]);

  useEffect(() => {
    if (!target) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeComposer();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [target, closeComposer]);

  const frames = useVideoFrames(isVideo && previewUrl ? previewUrl : null);
  const timelineDuration = videoDuration ?? 0;

  if (!target) return null;

  const isGosub = target.ownerType === "gosub";
  const canPublish =
    !publishing &&
    progress === null &&
    (mode === "text" ? text.trim().length > 0 : Boolean(file)) &&
    (mode === "text" || videoDuration === null || videoDuration <= MAX_VIDEO_SECONDS);

  const pickFile = (picked: File | null) => {
    if (!picked) return;
    if (picked.size > MAX_FILE_BYTES) {
      toast.error(t("stories.errorFileTooLarge"));
      return;
    }
    const video = picked.type.startsWith("video/");
    if (!video && !picked.type.startsWith("image/")) {
      toast.error(t("stories.errorUnsupportedType"));
      return;
    }
    if (video) {
      const probeUrl = URL.createObjectURL(picked);
      const probe = document.createElement("video");
      probe.preload = "metadata";
      probe.onloadedmetadata = () => {
        setVideoDuration(probe.duration);
        if (probe.duration > MAX_VIDEO_SECONDS) {
          toast.error(t("stories.errorVideoTooLong", { seconds: MAX_VIDEO_SECONDS }));
        }
        URL.revokeObjectURL(probeUrl);
      };
      probe.onerror = () => URL.revokeObjectURL(probeUrl);
      probe.src = probeUrl;
    } else {
      setVideoDuration(null);
    }
    setIsVideo(video);
    setPlaying(true);
    setFile(picked);
  };

  const handlePublish = async () => {
    try {
      let input: CreateStoryInput;
      if (mode === "text") {
        const style: StoryTextStyle = { preset, align: "center" };
        input = {
          owner_type: target.ownerType,
          board_id: target.ownerType === "gosub" ? target.ownerId : undefined,
          kind: "text",
          text: text.trim(),
          text_style: style,
          privacy: isGosub ? "everyone" : privacy,
        };
      } else {
        if (!file) return;
        if (!user?.id) throw new Error("not authenticated");
        setProgress(0);
        const ext = (file.name.split(".").pop() || (isVideo ? "mp4" : "jpg")).toLowerCase();
        // The key prefix is the author's id — the upload endpoint's ownership
        // proof (a GomoSub story is still uploaded by a person).
        const key = `${user.id}/story_${Date.now()}.${ext}`;
        const uploaded = await uploadFile(
          "stories",
          key,
          file,
          undefined,
          true,
          (percent) => setProgress(Math.min(99, percent)),
          () => setProgress(99),
        );
        input = {
          owner_type: target.ownerType,
          board_id: target.ownerType === "gosub" ? target.ownerId : undefined,
          kind: isVideo ? "video" : "photo",
          media_key: uploaded.path,
          preview_key: uploaded.variants?.preview_key ?? uploaded.video?.poster_key,
          thumb_hash: uploaded.variants?.thumb_hash,
          width: uploaded.variants?.width ?? uploaded.video?.width,
          height: uploaded.variants?.height ?? uploaded.video?.height,
          duration: isVideo ? (videoDuration ?? undefined) : undefined,
          content_type: uploaded.video?.content_type ?? file.type,
          text: text.trim() || undefined,
          privacy: isGosub ? "everyone" : privacy,
        };
      }

      const story = await publish(input, target);
      setProgress(null);
      closeComposer();
      openViewer({
        ownerType: story.owner_type,
        ownerId: story.owner_id,
        ownerName: target.ownerName,
        storyId: story.id,
        origin: "composer",
      });
    } catch {
      setProgress(null);
      toast.error(t("stories.errorPublish"));
    }
  };

  const audience = AUDIENCES.find((option) => option.value === privacy) ?? AUDIENCES[0];
  const AudienceIcon = audience.icon;

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex flex-col bg-black text-white"
      role="dialog"
      aria-modal="true"
      aria-label={t("stories.composerTitle", { name: target.ownerName })}
      data-testid="story-composer"
    >
      {/* The picked media tints the whole screen, so the canvas never looks flat. */}
      {previewUrl && mode === "media" && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 scale-110 bg-cover bg-center opacity-30 blur-3xl"
          style={{ backgroundImage: `url("${previewUrl}")` }}
        />
      )}

      <header className="relative z-10 flex items-center gap-3 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-2">
        <button
          type="button"
          onClick={closeComposer}
          aria-label={t("common.close")}
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <UserAvatar
          src={target.ownerType === "user" && user?.id === target.ownerId ? user.avatar_url : null}
          userId={target.ownerType === "user" ? target.ownerId : null}
          alt={target.ownerName}
          className="h-9 w-9 border border-white/15"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold leading-tight">{target.ownerName}</p>
          <p className="truncate text-[11px] text-white/55">{t("stories.composerNew")}</p>
        </div>
        {isGosub ? (
          <span className="hidden items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-xs text-white/80 sm:flex">
            <Users className="h-3.5 w-3.5" />
            {t("stories.composerBoardAudience")}
          </span>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-white/20"
              >
                <AudienceIcon className="h-3.5 w-3.5" />
                {t(audience.key)}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="z-[260]">
              {AUDIENCES.map((option) => {
                const Icon = option.icon;
                return (
                  <DropdownMenuItem key={option.value} onSelect={() => setPrivacy(option.value)}>
                    <Icon className="mr-2 h-4 w-4" />
                    {t(option.key)}
                  </DropdownMenuItem>
                );
              })}
              {privacy === "close_friends" && (
                <DropdownMenuItem onSelect={() => setCloseFriendsOpen(true)}>
                  <Star className="mr-2 h-4 w-4" />
                  {t("stories.closeFriendsConfigure")}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </header>

      {/* Canvas */}
      <div
        className="relative z-10 flex min-h-0 flex-1 items-center justify-center px-3"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          pickFile(event.dataTransfer.files?.[0] ?? null);
        }}
      >
        {mode === "text" ? (
          <div
            className="mx-auto flex h-full w-full max-w-[560px] items-center justify-center overflow-hidden rounded-3xl px-6 py-8"
            style={{ background: storyPresetBackground(preset) }}
          >
            {/* A contentEditable block (not a textarea) so the text sits in the
                middle of the card like a real slide; a textarea is always
                top-aligned and made short stories look broken. */}
            <div
              ref={textRef}
              contentEditable
              role="textbox"
              aria-multiline="true"
              aria-label={t("stories.composerTextPlaceholder")}
              data-placeholder={t("stories.composerTextPlaceholder")}
              suppressContentEditableWarning
              onInput={(event) => {
                const node = event.currentTarget;
                const raw = readEditable(node);
                const value = raw.slice(0, 1024);
                if (raw.length > 1024) node.innerText = value;
                setText(value);
              }}
              onPaste={(event) => {
                event.preventDefault();
                const pasted = event.clipboardData.getData("text").slice(0, 1024);
                document.execCommand("insertText", false, pasted);
              }}
              className="max-h-full w-full overflow-y-auto whitespace-pre-wrap break-words text-center text-2xl font-semibold leading-snug text-white outline-none empty:before:pointer-events-none empty:before:text-white/60 empty:before:content-[attr(data-placeholder)] sm:text-3xl"
              style={{ textShadow: "0 1px 10px rgba(0,0,0,0.25)", minHeight: "1.5em" }}
            />
          </div>
        ) : previewUrl ? (
          <div className="relative flex max-h-full max-w-full items-center justify-center">
            {isVideo ? (
              <>
                {/* eslint-disable-next-line jsx-a11y/media-has-caption -- user media has no caption track */}
                <video
                  ref={videoRef}
                  src={previewUrl}
                  className="max-h-[62vh] max-w-full rounded-3xl object-contain"
                  playsInline
                  autoPlay
                  loop
                  muted={muted}
                  onClick={() => setPlaying((value) => !value)}
                  onTimeUpdate={(event) => setVideoTime(event.currentTarget.currentTime)}
                  onCanPlay={(event) => {
                    // Same autoplay-policy fallback as the player: if the sound
                    // attempt was aborted while loading, start muted instead of
                    // leaving a frozen frame.
                    const video = event.currentTarget;
                    if (playing && video.paused) {
                      video.muted = true;
                      setMuted(true);
                      void video.play().catch(() => undefined);
                    }
                  }}
                />
                <div className="absolute right-2 top-2 flex gap-1.5">
                  <RoundButton
                    label={playing ? t("stories.pause") : t("stories.play")}
                    onClick={() => setPlaying((value) => !value)}
                  >
                    {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                  </RoundButton>
                  <RoundButton label={muted ? t("stories.unmute") : t("stories.mute")} onClick={() => setMuted((v) => !v)}>
                    {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
                  </RoundButton>
                </div>
              </>
            ) : (
              <img
                src={previewUrl}
                alt=""
                className="max-h-[62vh] max-w-full rounded-3xl object-contain"
              />
            )}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="absolute bottom-2 left-2 rounded-full bg-black/45 px-3 py-1.5 text-xs font-medium text-white backdrop-blur transition-colors hover:bg-black/65"
            >
              {t("stories.composerReplace")}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="mx-auto flex h-full w-full max-w-[560px] flex-col items-center justify-center gap-4 px-6 text-center outline-none"
          >
            <span className="grid h-20 w-20 place-items-center rounded-full bg-white/[0.07] text-white/75 transition-colors hover:bg-white/[0.12]">
              <ImagePlus className="h-9 w-9" />
            </span>
            <span className="text-base font-medium">{t("stories.composerPickMedia")}</span>
            <span className="text-xs text-white/45">{t("stories.composerPickMediaHint")}</span>
          </button>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,video/*"
        className="hidden"
        onChange={(event) => pickFile(event.target.files?.[0] ?? null)}
      />

      {/* Controls */}
      <footer className="relative z-10 mt-3 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto w-full max-w-[640px] space-y-2.5">
        {progress !== null && (
          <div className="h-1 overflow-hidden rounded-full bg-white/15">
            <div
              className="h-full rounded-full bg-white transition-[width] duration-200"
              style={{ width: `${progress}%` }}
            />
          </div>
        )}

        {isVideo && mode === "media" && (
          <VideoTimeline
            frames={frames}
            progress={timelineDuration > 0 ? videoTime / timelineDuration : 0}
            currentTime={videoTime}
            duration={timelineDuration}
            onSeek={(ratio) => {
              const video = videoRef.current;
              if (!video || !video.duration) return;
              video.currentTime = ratio * video.duration;
              setVideoTime(video.currentTime);
            }}
          />
        )}

        {mode === "media" ? (
          <div className="flex items-center gap-2 rounded-full bg-white/10 px-4 py-2.5 backdrop-blur">
            <input
              value={text}
              onChange={(event) => setText(event.target.value)}
              maxLength={1024}
              placeholder={t("stories.composerCaptionPlaceholder")}
              className="min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-white/45"
            />
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white/10 text-[10px] font-semibold text-white/80">
              24h
            </span>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-center gap-2" role="group" aria-label={t("stories.composerBackground")}>
            {STORY_TEXT_PRESETS.map((option) => (
              <button
                key={option}
                type="button"
                aria-label={t(`stories.preset${option.charAt(0).toUpperCase()}${option.slice(1)}`)}
                aria-pressed={preset === option}
                onClick={() => setPreset(option)}
                className={`h-7 w-7 rounded-full ring-2 transition-transform ${
                  preset === option ? "scale-110 ring-white" : "ring-transparent"
                }`}
                style={{ background: storyPresetBackground(option) }}
              />
            ))}
          </div>
        )}

        <div className="flex items-center gap-2">
          <div className="flex flex-1 items-center justify-center gap-1 rounded-full bg-white/10 p-1">
            <ToolButton
              active={mode === "media"}
              icon={<ImagePlus className="h-5 w-5" />}
              label={t("stories.composerMedia")}
              onClick={() => setMode("media")}
            />
            <ToolButton
              active={mode === "text"}
              icon={<Type className="h-5 w-5" />}
              label={t("stories.composerText")}
              onClick={() => {
                setMode("text");
                // A text slide has no caption: keep whatever was typed as the
                // slide body so switching modes never loses the words.
              }}
            />
            {mode === "text" && (
              <ToolButton
                icon={<Palette className="h-5 w-5" />}
                label={t("stories.composerBackground")}
                onClick={() => {
                  const index = STORY_TEXT_PRESETS.indexOf(preset);
                  setPreset(STORY_TEXT_PRESETS[(index + 1) % STORY_TEXT_PRESETS.length]);
                }}
              />
            )}
          </div>

          <button
            type="button"
            onClick={() => void handlePublish()}
            disabled={!canPublish}
            aria-label={t("stories.composerPublish")}
            className="flex h-11 shrink-0 items-center gap-2 rounded-full bg-primary px-4 font-semibold text-primary-foreground transition-transform hover:scale-[1.02] disabled:opacity-40 disabled:hover:scale-100 sm:px-5"
          >
            {publishing ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            <span className="hidden sm:inline">{t("stories.composerPublish")}</span>
          </button>
        </div>
        </div>
      </footer>

      <CloseFriendsDialog open={closeFriendsOpen} onOpenChange={setCloseFriendsOpen} />
    </div>,
    document.body,
  );
}

/** `innerText` keeps line breaks in a contentEditable; jsdom does not implement
 * it, so tests (and any non-layout DOM) fall back to `textContent`. */
function readEditable(node: HTMLElement): string {
  return (node.innerText ?? node.textContent ?? "").trim();
}

function RoundButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="grid h-9 w-9 place-items-center rounded-full bg-black/45 text-white backdrop-blur transition-colors hover:bg-black/65"
    >
      {children}
    </button>
  );
}

function ToolButton({
  icon,
  label,
  active,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={`grid h-9 w-9 place-items-center rounded-full transition-colors ${
        active ? "bg-white text-black" : "text-white/80 hover:bg-white/10 hover:text-white"
      }`}
    >
      {icon}
    </button>
  );
}
