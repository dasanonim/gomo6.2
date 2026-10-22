import { memo } from "react";
import { Hash, Lock, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NavigationLink } from "@/components/NavigationLink";
import { storageUrl } from "@/utils/storage";
import { formatCompactCount } from "@/utils/formatCount";
import { cn } from "@/lib/utils";
import type { GomoSubDirectoryItem } from "@/routes/data/gomosubData";

interface GomoSubCardProps {
  sub: GomoSubDirectoryItem;
  /** Membership request in flight — disables the toggle button only. */
  isToggling?: boolean;
  onToggleJoin?: (sub: GomoSubDirectoryItem) => void;
  className?: string;
}

/**
 * One community in the /g catalog. The whole card is a link into the sub; the
 * join/leave button floats above it in the corner, so the card itself stays a
 * single large hit target.
 */
export const GomoSubCard = memo(({ sub, isToggling = false, onToggleJoin, className }: GomoSubCardProps) => {
  const cover = sub.cover_image_url ? storageUrl("post-images", sub.cover_image_url) : null;
  const avatar = sub.gomosub_avatar_url ? storageUrl("post-images", sub.gomosub_avatar_url) : null;
  const tags = (sub.gomosub_tags ?? []).filter((t) => typeof t === "string" && t.trim()).slice(0, 3);

  return (
    <article
      className={cn(
        "group relative flex flex-col overflow-hidden rounded-2xl border border-border/70 bg-surface shadow-sm",
        "transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-lg",
        className,
      )}
    >
      {/* Cover band. Without an image the community's own accent tint carries
          the identity; the big first letter sits behind the avatar. */}
      <div className="relative h-24 shrink-0 overflow-hidden sm:h-28">
        {cover ? (
          <img src={cover || undefined} alt="" className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" loading="lazy" />
        ) : (
          <div className="relative h-full w-full bg-gradient-to-br from-primary/20 via-primary/10 to-muted">
            <span
              aria-hidden
              className="absolute -bottom-4 right-3 select-none text-7xl font-black uppercase leading-none tracking-tight text-primary/20"
            >
              {(sub.name?.[0] || sub.slug[0] || "g").toUpperCase()}
            </span>
          </div>
        )}
        {sub.visibility === "private" && (
          <span className="absolute right-2 top-2 flex items-center gap-1 rounded-full bg-background/80 px-2 py-0.5 text-xs text-foreground backdrop-blur-sm">
            <Lock className="h-3 w-3" />
            Приватный
          </span>
        )}
      </div>

      {/* Avatar straddles the cover/content boundary — the community mark.
          Reserves no layout row: content grid compensates with pt-8. */}
      <div className="pointer-events-none relative z-0 -mb-2 px-4">
        <div className="absolute -top-[1.75rem] h-14 w-14 overflow-hidden rounded-2xl border-2 border-background bg-muted shadow-md sm:h-16 sm:w-16 sm:-top-[2rem]">
          {avatar ? (
            <img src={avatar || undefined} alt={sub.name} className="h-full w-full object-cover" loading="lazy" />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-primary/30 to-muted text-lg font-bold text-primary">
              {(sub.name?.[0] || sub.slug[0] || "g").toUpperCase()}
            </div>
          )}
        </div>
      </div>

      <div className="relative z-0 flex flex-1 flex-col px-4 pb-4 pt-10 sm:pt-12">
        <h3 className="min-w-0 truncate text-[15px] font-bold">{sub.name}</h3>
        <div className="text-sm font-semibold text-primary">g/{sub.slug}</div>

        {sub.description && (
          <p className="mt-1.5 line-clamp-2 min-h-[2.5rem] text-sm text-muted-foreground">{sub.description}</p>
        )}

        {tags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {tags.map((tag) => (
              <span
                key={tag}
                className="rounded-full border border-border/60 bg-muted/50 px-2 py-0.5 text-xs text-muted-foreground"
              >
                {tag}
              </span>
            ))}
          </div>
        )}

        <div className="mt-auto flex items-center gap-3 pt-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Users className="h-3.5 w-3.5" />
            {formatCompactCount(sub.member_count)}
          </span>
          <span className="flex items-center gap-1">
            <Hash className="h-3.5 w-3.5" />
            {formatCompactCount(sub.channel_count)}
          </span>
        </div>
      </div>

      {/* Whole-card link sits above the text; the button above the link. */}
      <NavigationLink
        to={`/g/${sub.slug}`}
        prefetchOnViewport
        className="absolute inset-0 z-10"
        aria-label={`Открыть сообщество ${sub.name}`}
      />
      <Button
        variant={sub.joined ? "secondary" : "default"}
        size="sm"
        disabled={isToggling}
        onClick={() => onToggleJoin?.(sub)}
        className={cn(
          "absolute bottom-3.5 right-3.5 z-20 h-8 rounded-full px-3.5 text-xs",
          sub.joined &&
            "border border-primary/35 bg-primary/10 text-primary hover:bg-primary/20",
        )}
      >
        {sub.joined ? "В сабе" : "Вступить"}
      </Button>
    </article>
  );
});

GomoSubCard.displayName = "GomoSubCard";
