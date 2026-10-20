import { useEffect, useRef, useState, type ReactNode } from "react";
import { Globe2, ImagePlus, Loader2, Lock, Star, Type, Users, Video } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAuth } from "@/hooks/useAuth";
import { uploadFile } from "@/utils/storage";
import { useStoriesStore } from "@/stores/storiesStore";
import type { CreateStoryInput, StoryPrivacy, StoryTextStyle } from "@/types/stories";
import { CloseFriendsDialog } from "./CloseFriendsDialog";
import { STORY_TEXT_PRESETS, storyPresetBackground, type StoryTextPreset } from "./storyPresets";
import "./stories.css";

const MAX_VIDEO_SECONDS = 60;
const MAX_FILE_BYTES = 50 * 1024 * 1024;

type Mode = "media" | "text";

/**
 * Story composer: pick a photo/video (or write a text slide), add a caption and
 * an audience, publish. The audience picker is hidden for a GomoSub — the board
 * is the audience there, and the server enforces it regardless of what the
 * client sends.
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
  const [text, setText] = useState("");
  const [preset, setPreset] = useState<StoryTextPreset>("sunset");
  const [privacy, setPrivacy] = useState<StoryPrivacy>("everyone");
  const [progress, setProgress] = useState<number | null>(null);
  const [closeFriendsOpen, setCloseFriendsOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reset whenever a new composer target opens.
  useEffect(() => {
    if (!target) return;
    setMode("media");
    setFile(null);
    setPreviewUrl(null);
    setIsVideo(false);
    setVideoDuration(null);
    setText("");
    setPreset("sunset");
    setPrivacy("everyone");
    setProgress(null);
  }, [target]);

  // Object URLs must be revoked or a long session leaks every picked file.
  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  if (!target) return null;

  const isGosub = target.ownerType === "gosub";
  const canPublish =
    !publishing &&
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
        // The key must start with the *author's* id — that prefix is the
        // ownership proof the upload endpoint checks (a GomoSub story is still
        // uploaded by a person, not by the board).
        const key = `${user.id}/story_${Date.now()}.${ext}`;
        // Upload into the private stories bucket under the *author's* namespace:
        // the backend rejects a key owned by someone else, so this prefix is
        // also the ownership proof.
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

      // The media key belongs to the *author*, not to the board: for a GomoSub
      // story the server checks the key prefix against the authenticated user.
      const story = await publish(input, target);
      setProgress(null);
      closeComposer();
      openViewer({
        ownerType: story.owner_type,
        ownerId: story.owner_id,
        storyId: story.id,
        origin: "composer",
      });
    } catch {
      setProgress(null);
      toast.error(t("stories.errorPublish"));
    }
  };

  return (
    <>
      <Dialog open onOpenChange={(open) => (!open ? closeComposer() : undefined)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="truncate">{t("stories.composerTitle", { name: target.ownerName })}</DialogTitle>
          </DialogHeader>

          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant={mode === "media" ? "default" : "outline"}
              onClick={() => setMode("media")}
            >
              <Video className="mr-1.5 h-4 w-4" />
              {t("stories.composerMedia")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={mode === "text" ? "default" : "outline"}
              onClick={() => setMode("text")}
            >
              <Type className="mr-1.5 h-4 w-4" />
              {t("stories.composerText")}
            </Button>
          </div>

          {mode === "media" ? (
            <div className="relative overflow-hidden rounded-xl border border-border/70 bg-muted/30">
              <div className="relative flex min-h-[240px] items-center justify-center">
                {previewUrl ? (
                  isVideo ? (
                    <video
                      src={previewUrl}
                      className="max-h-[45vh] w-full object-contain"
                      controls
                      playsInline
                      muted
                    />
                  ) : (
                    <img src={previewUrl} alt="" className="max-h-[45vh] w-full object-contain" />
                  )
                ) : (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="flex flex-col items-center gap-2 px-6 py-10 text-sm text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <ImagePlus className="h-8 w-8" />
                    {t("stories.composerPickMedia")}
                    <span className="text-xs">{t("stories.composerPickMediaHint")}</span>
                  </button>
                )}
                {previewUrl && (
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="absolute right-2 top-2"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    {t("stories.composerReplace")}
                  </Button>
                )}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,video/*"
                className="hidden"
                onChange={(event) => pickFile(event.target.files?.[0] ?? null)}
              />
            </div>
          ) : (
            <div
              className="grid min-h-[220px] place-items-center rounded-xl p-4 text-center text-xl font-semibold text-white"
              style={{ background: storyPresetBackground(preset) }}
            >
              <span className="break-words whitespace-pre-wrap">{text || t("stories.composerTextPlaceholder")}</span>
            </div>
          )}

          {mode === "text" && (
            <div className="flex flex-wrap gap-2" role="group" aria-label={t("stories.composerBackground")}>
              {STORY_TEXT_PRESETS.map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-label={t(`stories.preset${option.charAt(0).toUpperCase()}${option.slice(1)}`)}
                  aria-pressed={preset === option}
                  onClick={() => setPreset(option)}
                  className={`h-7 w-7 rounded-full ring-2 transition-transform ${
                    preset === option ? "scale-110 ring-primary" : "ring-transparent"
                  }`}
                  style={{ background: storyPresetBackground(option) }}
                />
              ))}
            </div>
          )}

          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            maxLength={1024}
            rows={3}
            placeholder={mode === "text" ? t("stories.composerTextPlaceholder") : t("stories.composerCaptionPlaceholder")}
            className="w-full resize-none rounded-lg border border-border/70 bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          />

          <div className="flex flex-wrap items-center justify-between gap-2">
            {isGosub ? (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Users className="h-3.5 w-3.5" />
                {t("stories.composerBoardAudience")}
              </span>
            ) : (
              <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t("stories.composerAudience")}>
                <PrivacyButton
                  active={privacy === "everyone"}
                  icon={<Globe2 className="h-3.5 w-3.5" />}
                  label={t("stories.privacyEveryone")}
                  onClick={() => setPrivacy("everyone")}
                />
                <PrivacyButton
                  active={privacy === "friends"}
                  icon={<Users className="h-3.5 w-3.5" />}
                  label={t("stories.privacyFriends")}
                  onClick={() => setPrivacy("friends")}
                />
                <PrivacyButton
                  active={privacy === "close_friends"}
                  icon={<Star className="h-3.5 w-3.5" />}
                  label={t("stories.privacyCloseFriends")}
                  onClick={() => setPrivacy("close_friends")}
                />
                <PrivacyButton
                  active={privacy === "only_me"}
                  icon={<Lock className="h-3.5 w-3.5" />}
                  label={t("stories.privacyOnlyMe")}
                  onClick={() => setPrivacy("only_me")}
                />
              </div>
            )}
            {!isGosub && privacy === "close_friends" && (
              <button
                type="button"
                onClick={() => setCloseFriendsOpen(true)}
                className="text-xs font-medium text-primary underline-offset-2 hover:underline"
              >
                {t("stories.closeFriendsConfigure")}
              </button>
            )}
          </div>

          {progress !== null && (
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-200"
                style={{ width: `${progress}%` }}
              />
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={closeComposer} disabled={publishing}>
              {t("common.cancel")}
            </Button>
            <Button onClick={handlePublish} disabled={!canPublish}>
              {publishing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("stories.composerPublish")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <CloseFriendsDialog open={closeFriendsOpen} onOpenChange={setCloseFriendsOpen} />
    </>
  );
}

function PrivacyButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={`flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors ${
        active
          ? "border-primary bg-primary/10 font-medium text-primary"
          : "border-border/70 text-muted-foreground hover:text-foreground"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
