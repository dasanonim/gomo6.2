import type { ReactNode } from "react";
import { Globe2, Lock, Star, Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { StoryPrivacy } from "@/types/stories";

const OPTIONS: Array<{ value: StoryPrivacy; icon: ReactNode; key: string }> = [
  { value: "everyone", icon: <Globe2 className="h-3.5 w-3.5" />, key: "stories.privacyEveryone" },
  { value: "friends", icon: <Users className="h-3.5 w-3.5" />, key: "stories.privacyFriends" },
  {
    value: "close_friends",
    icon: <Star className="h-3.5 w-3.5" />,
    key: "stories.privacyCloseFriends",
  },
  { value: "only_me", icon: <Lock className="h-3.5 w-3.5" />, key: "stories.privacyOnlyMe" },
];

export type StoryPrivacyPickerProps = {
  value: StoryPrivacy;
  onChange: (value: StoryPrivacy) => void;
  disabled?: boolean;
  className?: string;
};

/** The four audiences, in one place so the composer and the viewer's privacy
 * editor cannot drift apart. */
export function StoryPrivacyPicker({ value, onChange, disabled, className }: StoryPrivacyPickerProps) {
  const { t } = useTranslation();
  return (
    <div
      role="radiogroup"
      aria-label={t("stories.composerAudience")}
      className={`flex flex-wrap gap-1.5 ${className ?? ""}`}
    >
      {OPTIONS.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={`flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors disabled:opacity-50 ${
              active
                ? "border-primary bg-primary/10 font-medium text-primary"
                : "border-border/70 text-muted-foreground hover:text-foreground"
            }`}
          >
            {option.icon}
            {t(option.key)}
          </button>
        );
      })}
    </div>
  );
}

/** Icon + label for the current audience, used as a badge in the viewer header. */
export function StoryPrivacyBadge({ privacy }: { privacy: StoryPrivacy }) {
  const { t } = useTranslation();
  if (privacy === "close_friends") {
    return (
      <span className="inline-flex items-center gap-1 text-[var(--story-ring-close-to)]">
        <Star className="h-3.5 w-3.5" />
        {t("stories.privacyCloseFriends")}
      </span>
    );
  }
  if (privacy === "only_me") {
    return (
      <span className="inline-flex items-center gap-1">
        <Lock className="h-3.5 w-3.5" />
        {t("stories.privacyOnlyMe")}
      </span>
    );
  }
  if (privacy === "friends") {
    return (
      <span className="inline-flex items-center gap-1">
        <Users className="h-3.5 w-3.5" />
        {t("stories.privacyFriends")}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1">
      <Users className="h-3.5 w-3.5" />
      {t("stories.privacyEveryone")}
    </span>
  );
}
