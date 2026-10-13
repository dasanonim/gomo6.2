import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Hash, MessageSquare } from "lucide-react";
import { api } from "@/integrations/api/compat";
import { storageUrl } from "@/utils/storage";
import { formatShortRelativeTime } from "@/utils/relativeTimeShort";
import { messengerPlainPreview } from "@/components/messenger/messengerRichTextUtils";
import type { ShareTarget } from "./share";
import { entityParam } from "@/utils/entityUrl";
import { wallPostUrl } from "@/utils/entityUrl";

// ─── Entity shapes (mirror what the feed/wall pages select) ─────────────────

interface ShareCardThread {
  id: string;
  public_id?: number | null;
  user_id?: string | null;
  user_public_id?: number | null;
  title: string | null;
  content: string | null;
  created_at?: string | null;
  image_url?: string | null;
  image_urls?: string[] | null;
  attachments?: unknown;
  boards?: { name: string; slug: string; is_gomosub: boolean } | null;
  section?: { name: string; slug?: string | null } | null;
  subsection?: { name: string; slug?: string | null } | null;
  // Author fields arrive FLAT on the threads row (GET /api/v1/threads embeds no
  // `profiles` relation), unlike wall posts which expose `author:profiles!author_id`.
  username?: string | null;
  display_name?: string | null;
  nickname_emoji_id?: string | null;
  is_anonymous?: boolean | null;
  avatar_url?: string | null;
}

/** Normalized author shape the card renders (from either entity). */
interface ShareCardAuthor {
  username: string;
  display_name?: string | null;
  is_anonymous: boolean;
  avatar_url?: string | null;
}

interface ShareCardWallPost {
  id: string;
  public_id?: number | null;
  user_id: string;
  user_public_id?: number | null;
  author_id?: string;
  title?: string | null;
  content?: string | null;
  created_at?: string | null;
  image_url?: string | null;
  attachments?: unknown;
  author?: {
    username: string;
    display_name?: string | null;
    is_anonymous: boolean;
    avatar_url?: string | null;
  } | null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function firstImageFromAttachments(attachments: unknown): string | null {
  if (!Array.isArray(attachments)) return null;
  const first = attachments.find(
    (att): att is { type?: string; url?: string } =>
      typeof att === "object" && att !== null && (att as { type?: string }).type === "image",
  );
  return first?.url ?? null;
}

/** Resolve a stored key/path through the same bucket mapping WallAttachments uses. */
function resolveImageUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return storageUrl("content", raw) || raw;
}

// ─── The card ───────────────────────────────────────────────────────────────

interface ShareCardProps {
  target: ShareTarget;
}

/**
 * Renders a shared thread / wall post inside a messenger bubble (X-style
 * quote card). The card fetches the entity by id — the recipient only ever
 * sees what the API allows them to (RLS), and deleted/inaccessible posts fall
 * back to a muted placeholder instead of breaking the message.
 *
 * Sizing contract with the virtualizer: the card uses a fixed-height 16:9
 * thumbnail (object-cover) and clamped text lines, so its rendered height is
 * deterministic — MessageList estimates it with a constant before the entity
 * is fetched, and the measured height matches it almost exactly.
 */
export const ShareCard = ({ target }: ShareCardProps) => {
  const navigate = useNavigate();
  const { t } = useTranslation();

  const { data, isLoading, isError } = useQuery({
    queryKey: ["share-card", target.type, target.id],
    queryFn: async (): Promise<{ thread?: ShareCardThread; wall?: ShareCardWallPost } | null> => {
      if (target.type === "thread") {
        const { data: rows } = await api
          .from("threads")
          .select(
            "id, public_id, user_id, user_public_id, title, content, created_at, image_url, image_urls, attachments, boards(name, slug, is_gomosub), section(name, slug), subsection(name, slug), username, display_name, nickname_emoji_id, is_anonymous, avatar_url",
          )
          .eq("id", target.id)
          .limit(1);
        const thread = rows?.[0] as ShareCardThread | undefined;
        return thread ? { thread } : null;
      }
      const { data: rows } = await api
        .from("profile_wall_posts")
        .select(
          "id, public_id, user_id, user_public_id, author_id, title, content, created_at, image_url, attachments, author:profiles!author_id(username, display_name, is_anonymous, avatar_url)",
        )
        .eq("id", target.id)
        .limit(1);
      const wall = rows?.[0] as ShareCardWallPost | undefined;
      return wall ? { wall } : null;
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    refetchOnMount: false,
    retry: false,
  });

  const card = useMemo(() => {
    const thread = data?.thread;
    const wall = data?.wall;
    if (!thread && !wall) return null;

    const author: ShareCardAuthor | null | undefined = thread
      ? (thread.user_id
        ? {
            username: thread.username ?? "",
            display_name: thread.display_name,
            is_anonymous: Boolean(thread.is_anonymous),
            avatar_url: thread.avatar_url,
          }
        : null)
      : wall!.author;
    const title = thread?.title || wall?.title || "";
    const content = thread?.content || wall?.content || "";
    const snippet = messengerPlainPreview(content, 220);
    const rawImage = thread
      ? firstImageFromAttachments(thread.attachments)
        ?? thread.image_urls?.[0] ?? thread.image_url
      : firstImageFromAttachments(wall!.attachments) ?? wall!.image_url;
    const image = resolveImageUrl(rawImage);

    const board = thread?.boards;
    const hasBoard = Boolean(thread && board?.slug);

    // Trail after the handle: the section (· subsection) a thread was posted in
    // and when. Wall posts carry no section, so they show only the date.
    const sectionLabel = thread
      ? ([thread.section?.name, thread.subsection?.name].filter(Boolean) as string[]).join(" · ") || null
      : null;
    const createdIso = (thread?.created_at ?? wall?.created_at) ?? null;

    const url = thread
      ? hasBoard
        ? `${board?.is_gomosub ? "/g" : ""}/${board?.slug}/thread/${entityParam(thread)}`
        : `/thread/${entityParam(thread)}`
      : wallPostUrl({ id: wall!.user_id, public_id: wall!.user_public_id }, wall!);

    return { author, title, snippet, image, url, sectionLabel, createdIso };
  }, [data]);

  if (!card) {
    // Loading skeleton or unresolvable share: keep a fixed-height placeholder
    // so the virtualizer's estimate holds while the entity is fetched.
    const unavailable = !isLoading && (isError || !data);
    return (
      <button
        type="button"
        className={`msg-share-card msg-share-card-muted${isLoading ? " is-loading" : ""}`}
        aria-busy={isLoading}
        disabled={!isLoading}
      >
        <span className="msg-share-card-icon">
          {target.type === "thread" ? <Hash size={14} /> : <MessageSquare size={14} />}
        </span>
        <span className="msg-share-card-label">
          {isLoading ? t("common.loading") : unavailable ? t("share.unavailable") : t("share.sharedPost")}
        </span>
      </button>
    );
  }

  // The handle line shows the actual @username (not the display name), matching
  // how the feed's post header renders it.
  const handle = card.author?.username ? `@${card.author.username}` : "";
  const avatarUrl = storageUrl("post-images", card.author?.avatar_url ?? null);
  // "@user · Раздел · Подраздел · 2ч" — the author, where it was posted and when.
  const metaLine = [
    card.author ? (card.author.is_anonymous ? t("common.anonymous") : handle) : "",
    card.sectionLabel,
    card.createdIso ? formatShortRelativeTime(card.createdIso) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <button
      type="button"
      className="msg-share-card"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        navigate(card.url);
      }}
    >
      {/* Header: author avatar on the left, with the post title and the
          author's handle stacked to its right. */}
      <div className="msg-share-card-head">
        <span className="msg-share-card-avatar-wrap">
          {avatarUrl ? (
            <img src={avatarUrl} alt="" className="msg-share-card-avatar" loading="lazy" />
          ) : (
            <span className="msg-share-card-avatar msg-share-card-avatar-fallback">
              {(card.author?.username?.[0] || card.title?.[0] || "?").toUpperCase()}
            </span>
          )}
        </span>
        <span className="msg-share-card-heading">
          {card.title && <span className="msg-share-card-title line-clamp-2">{card.title}</span>}
          {metaLine && <span className="msg-share-card-meta">{metaLine}</span>}
        </span>
      </div>

      {card.snippet && <div className="msg-share-card-text line-clamp-3">{card.snippet}</div>}

      {/* No placeholder when the post has no image — the card simply ends after
          the text instead of showing an empty 16:9 box. */}
      {card.image && (
        <div className="msg-share-card-image">
          <img src={card.image} alt="" loading="lazy" decoding="async" />
        </div>
      )}
    </button>
  );
};
