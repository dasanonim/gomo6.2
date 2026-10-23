import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { motion, useReducedMotion } from "motion/react";
import {
  Blend,
  Clock,
  Dices,
  Globe,
  Languages,
  LayoutGrid,
  Monitor,
  Moon,
  Palette,
  PanelTop,
  PlayCircle,
  RotateCcw,
  Search,
  Send,
  Shuffle,
  Star,
  Sun,
  Type,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { TransitionPreview } from "@/components/TransitionPreview";
import { PublishButton } from "@/components/PublishButton";
import { LANGUAGES } from "@/i18n/languages";
import { HEADER_BEHAVIORS, type HeaderBehavior } from "@/lib/headerBehavior";
import { PUBLISH_BUTTON_STYLES, type PublishButtonStyle } from "@/lib/publishButtonStyle";
import { TRANSITION_STYLES, isPerfLite, supportsViewTransitions, type TransitionStyle } from "@/lib/viewTransitions";
import { MR_RANDOM_COUNT_OPTIONS } from "@/lib/mrRandom";
import { springFor, whisperRowVariants } from "@/lib/motion";
import {
  CUSTOM_THEMES_EVENT,
  THEME_COLLECTIONS_EVENT,
  THEME_GROUP_LABEL_KEYS,
  THEME_GROUP_ORDER,
  getAllThemes,
  getFavorites,
  prefersDarkSystem,
  resolveTheme,
  toggleFavorite,
  type ThemeDef,
  type ThemeGroup,
  type ThemeModePref,
} from "@/theme";
import { OptionCard, Segmented, SETTING_BLOCK_CHROME, SettingBlock, SettingGroup, SettingRow } from "./SettingRow";
import { handleNavArrowKeys } from "./navKeyboard";
import { ThemeBuilder } from "./ThemeBuilder";
import type { AppearanceSettings } from "./useAppearanceSettings";
import { cn } from "@/lib/utils";

/* ── Local data ──────────────────────────────────────────────────────────── */

/**
 * The appearance section hosts too many settings for a single scroll, so it is
 * split into three sub-views. `view` lives in the section owner (Settings.tsx)
 * so the URL — and the global settings search — can point straight at one.
 */
export type AppearanceSubView = "themes" | "text" | "interface";

const APPEARANCE_SUB_VIEWS: Array<{ value: AppearanceSubView; labelKey: string }> = [
  { value: "themes", labelKey: "settings2.appearanceTabThemes" },
  { value: "text", labelKey: "settings2.appearanceTabText" },
  { value: "interface", labelKey: "settings2.appearanceTabInterface" },
];

export const resolveAppearanceSubView = (raw: string | null): AppearanceSubView =>
  APPEARANCE_SUB_VIEWS.some((v) => v.value === raw) ? (raw as AppearanceSubView) : "themes";

/**
 * A miniature of the real UI painted with the theme's own tokens. The tokens
 * are set as scoped CSS variables on the wrapper, so every Tailwind colour
 * inside (`bg-background`, `bg-card`, `text-foreground`, …) resolves to that
 * theme — no hand-drawn gradient. Single-mode themes render in their mode.
 */
const ThemeSwatch = ({ theme, dark, compact }: { theme: ThemeDef; dark: boolean; compact?: boolean }) => {
  const preferred = dark ? "dark" : "light";
  const mode = theme.supports.includes(preferred) ? preferred : theme.supports[0];
  const tokens = theme.tokens[mode];
  if (!tokens) return null;
  const vars: Record<string, string> = { ...tokens, "--radius": theme.radius };
  return (
    <span className="block overflow-hidden rounded-xl border border-border" style={vars as CSSProperties}>
      <span className={cn("flex flex-col justify-center gap-1.5 bg-background px-2.5", compact ? "h-[52px] py-0" : "h-[72px]")}>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-primary" />
          <span className="h-1.5 w-10 rounded-full bg-foreground/80" />
          <span className="ml-auto h-3 w-7 rounded-[calc(var(--radius)*0.7)] bg-primary/25" />
        </span>
        <span className="rounded-[var(--radius)] border border-border bg-card px-2 py-1">
          <span className="block h-1.5 w-16 rounded-full bg-foreground/70" />
          <span className="mt-1 block h-1.5 w-10 rounded-full bg-muted-foreground" />
        </span>
        {!compact && (
          <span className="flex items-center gap-1">
            <span className="h-1 w-6 rounded-full bg-link/70" />
            <span className="h-1 w-4 rounded-full bg-success/70" />
            <span className="h-1 w-4 rounded-full bg-warning/70" />
          </span>
        )}
      </span>
    </span>
  );
};

const HEADER_PILL = "rounded-full bg-surface border-border/60 hover:bg-surface/80";
/** Inputs / selects in the settings shell — site style: pill, surface, soft border. */
const SITE_INPUT = "h-10 rounded-[1.25rem] border-border/60 bg-surface";

const MODE_OPTIONS: Array<{ value: ThemeModePref; labelKey: string; icon: typeof Sun }> = [
  { value: "light", labelKey: "settings2.modeLight", icon: Sun },
  { value: "dark", labelKey: "settings2.modeDark", icon: Moon },
  { value: "system", labelKey: "settings2.modeSystem", icon: Monitor },
];

/** Favourites, kept in sync across tabs and with the picker. */
const useThemeFavorites = () => {
  const [favorites, setFavorites] = useState<string[]>(() => getFavorites());

  useEffect(() => {
    const sync = () => setFavorites(getFavorites());
    window.addEventListener(THEME_COLLECTIONS_EVENT, sync);
    return () => window.removeEventListener(THEME_COLLECTIONS_EVENT, sync);
  }, []);

  const toggle = useCallback((id: string) => setFavorites(toggleFavorite(id)), []);

  return { favorites, toggleFavorite: toggle };
};

const HEADER_KEYS: Record<HeaderBehavior, { label: string; desc: string }> = {
  fixed: { label: "settings2.headerFixed", desc: "settings2.headerFixedDesc" },
  "auto-hide": { label: "settings2.headerAutoHide", desc: "settings2.headerAutoHideDesc" },
};

const TRANSITION_KEYS: Record<TransitionStyle, { label: string; desc: string }> = {
  fade: { label: "settings2.transFade", desc: "settings2.transFadeDesc" },
  "view-transition": { label: "settings2.transView", desc: "settings2.transViewDesc" },
  rise: { label: "settings2.transRise", desc: "settings2.transRiseDesc" },
  slide: { label: "settings2.transSlide", desc: "settings2.transSlideDesc" },
  none: { label: "settings2.transNone", desc: "settings2.transNoneDesc" },
};

const PUBLISH_KEYS: Record<PublishButtonStyle, { label: string; desc: string }> = {
  "gradient-pill": { label: "settings2.pubGradient", desc: "settings2.pubGradientDesc" },
  "send-circle": { label: "settings2.pubCircle", desc: "settings2.pubCircleDesc" },
  "text-link": { label: "settings2.pubText", desc: "settings2.pubTextDesc" },
  "neon-pill": { label: "settings2.pubNeon", desc: "settings2.pubNeonDesc" },
  "icon-pill": { label: "settings2.pubIcon", desc: "settings2.pubIconDesc" },
};

/* ── Section ─────────────────────────────────────────────────────────────── */

interface AppearanceSectionProps {
  appearance: AppearanceSettings;
  view: AppearanceSubView;
  onViewChange: (view: AppearanceSubView) => void;
}

export const AppearanceSection = ({ appearance, view, onViewChange }: AppearanceSectionProps) => {
  const { t } = useTranslation();
  const prefersReducedMotion = useReducedMotion();
  const { resetAppearance } = appearance;

  const { favorites, toggleFavorite: onToggleFavorite } = useThemeFavorites();
  const [allThemes, setAllThemes] = useState<ThemeDef[]>(() => getAllThemes());

  // Swatches (and the builder preview) follow the chosen mode button — not the
  // current theme's resolved mode — so a single-mode theme can't force every
  // preview into its own mode.
  const previewDark = appearance.modePref === "dark" ? true : appearance.modePref === "light" ? false : prefersDarkSystem();

  useEffect(() => {
    const sync = () => setAllThemes(getAllThemes());
    window.addEventListener(CUSTOM_THEMES_EVENT, sync);
    return () => window.removeEventListener(CUSTOM_THEMES_EVENT, sync);
  }, []);

  return (
    <div className="space-y-5">
      {/* Sub-view tabs — Telegram-style sliding underline, like the
          notification tabs. */}
      <div className="flex rounded-2xl border border-border/60 bg-card/50 p-1" role="tablist" aria-label={t("settings.appearance")}>
        {APPEARANCE_SUB_VIEWS.map((sub) => {
          const active = sub.value === view;
          return (
            <button
              key={sub.value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onViewChange(sub.value)}
              className={cn(
                "relative flex-1 rounded-xl px-3 py-2 text-sm font-medium transition-colors",
                active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t(sub.labelKey)}
              {active && (
                <motion.span
                  layoutId="settings-appearance-tab-underline"
                  transition={springFor("snappy", prefersReducedMotion)}
                  className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-primary"
                />
              )}
            </button>
          );
        })}
      </div>

      <motion.div
        key={view}
        initial={prefersReducedMotion ? false : { opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={springFor("soft", prefersReducedMotion)}
        className="space-y-5"
      >
        {view === "themes" && (
          <ThemesView
            appearance={appearance}
            previewDark={previewDark}
            favorites={favorites}
            allThemes={allThemes}
            onToggleFavorite={onToggleFavorite}
          />
        )}
        {view === "text" && <TextView appearance={appearance} />}
        {view === "interface" && <InterfaceView appearance={appearance} />}
      </motion.div>

      {/* ── Сброс ──────────────────────────────────────────────────────── */}
      <SettingGroup divided={false}>
        <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <div className="flex items-center gap-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-destructive/10 text-destructive ring-1 ring-inset ring-destructive/20">
              <RotateCcw className="h-4 w-4" />
            </span>
            <div>
              <h3 className="text-sm font-semibold">{t("settings2.resetTitle")}</h3>
              <p className="text-xs text-muted-foreground">{t("settings2.resetDesc")}</p>
            </div>
          </div>
          <Button
            variant="outline"
            className={cn("shrink-0 gap-2 text-destructive hover:bg-destructive/10 hover:text-destructive", HEADER_PILL)}
            onClick={resetAppearance}
          >
            <RotateCcw className="h-4 w-4" />
            {t("settings2.resetAction")}
          </Button>
        </div>
      </SettingGroup>
    </div>
  );
};

/* ── Themes view ─────────────────────────────────────────────────────────── */

type ThemeFilter = "all" | "favorites" | "custom" | ThemeGroup;

function ThemesView({
  appearance,
  previewDark,
  favorites,
  allThemes,
  onToggleFavorite,
}: {
  appearance: AppearanceSettings;
  previewDark: boolean;
  favorites: string[];
  allThemes: ThemeDef[];
  onToggleFavorite: (id: string) => void;
}) {
  const { t } = useTranslation();
  const rowClass = SETTING_BLOCK_CHROME;
  const {
    colorTheme, modePref, timeAuto,
    setColorTheme, setModePref, setTimeAuto, randomTheme,
  } = appearance;

  // Gallery state: one filter chip + a name search replace the old wall of
  // grouped headers — everything is one flat, dense grid now.
  const [filter, setFilter] = useState<ThemeFilter>("all");
  const [nameQuery, setNameQuery] = useState("");

  const themeTitle = useCallback(
    (theme: ThemeDef) => theme.custom ? theme.name || t("settings2.builderUntitled") : t(`settings.${theme.nameKey}`),
    [t],
  );

  const groupChips = useMemo(
    () => THEME_GROUP_ORDER.filter((group) => allThemes.some((theme) => theme.group === group && !theme.custom)),
    [allThemes],
  );

  const visibleThemes = useMemo(() => {
    const q = nameQuery.trim().toLowerCase();
    return allThemes.filter((theme) => {
      if (filter === "favorites") {
        if (!favorites.includes(theme.id)) return false;
      } else if (filter === "custom") {
        if (!theme.custom) return false;
      } else if (filter !== "all") {
        if (theme.group !== filter) return false;
      }
      if (q && !themeTitle(theme).toLowerCase().includes(q)) return false;
      return true;
    });
  }, [allThemes, filter, favorites, nameQuery, themeTitle]);

  const renderTile = (theme: ThemeDef, index: number) => {
    const favorite = favorites.includes(theme.id);
    const title = themeTitle(theme);
    return (
      <motion.button
        key={theme.id}
        type="button"
        role="radio"
        aria-checked={colorTheme === theme.id}
        tabIndex={0}
        data-nav-item
        onClick={() => setColorTheme(theme.id)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setColorTheme(theme.id);
          }
        }}
        variants={whisperRowVariants(index)}
        initial="hidden"
        animate="show"
        className={cn(
          "group/tile relative flex cursor-pointer flex-col rounded-2xl border p-2 text-left outline-none transition-all duration-200",
          "focus-visible:ring-2 focus-visible:ring-ring/60",
          colorTheme === theme.id
            ? "border-primary/60 bg-primary/[0.06] ring-1 ring-primary/25"
            : "border-border/60 bg-background/40 hover:-translate-y-0.5 hover:border-primary/30 hover:bg-foreground/[0.03] hover:shadow-md",
        )}
      >
        <ThemeSwatch theme={theme} dark={previewDark} compact />
        <span className="mt-1.5 flex min-w-0 items-center justify-between gap-1">
          <span className="min-w-0 truncate text-xs font-medium" title={title}>
            {title}
          </span>
          <button
            type="button"
            aria-label={favorite ? t("settings2.themeFavoriteRemove") : t("settings2.themeFavoriteAdd")}
            aria-pressed={favorite}
            onClick={(event) => {
              event.stopPropagation();
              onToggleFavorite(theme.id);
            }}
            className={cn(
              "grid h-5 w-5 shrink-0 place-items-center transition-colors",
              favorite ? "text-yellow-400" : "text-foreground/25 hover:text-foreground/70",
            )}
          >
            <Star className={cn("h-3.5 w-3.5", favorite && "fill-current")} />
          </button>
        </span>
        {colorTheme === theme.id && (
          <span className="absolute right-1.5 top-1.5 grid h-4 w-4 place-items-center rounded-full border border-primary bg-primary text-primary-foreground" />
        )}
      </motion.button>
    );
  };

  return (
    <>
      <SettingGroup divided={false}>
        <SettingRow
          className={rowClass}
          id="set-mode"
          icon={Moon}
          title={t("settings.darkMode")}
          description={t("settings2.darkModeDesc")}
        >
          <Segmented
            aria-label={t("settings.darkMode")}
            value={modePref}
            onChange={setModePref}
            options={MODE_OPTIONS.map((option) => ({ value: option.value, label: t(option.labelKey), icon: option.icon }))}
          />
        </SettingRow>

        {resolveTheme(colorTheme).supports.length === 1 && (
          <p className="px-4 pb-1 text-xs text-muted-foreground sm:px-5">
            {t("settings2.themeSingleModeHint")}
          </p>
        )}

        <SettingRow
          className={rowClass}
          id="set-time-auto"
          icon={Clock}
          title={t("settings2.themeTimeAuto")}
          description={t("settings2.themeTimeAutoDesc")}
        >
          <Switch checked={timeAuto} onCheckedChange={setTimeAuto} aria-label={t("settings2.themeTimeAuto")} />
        </SettingRow>
      </SettingGroup>

      <div id="set-theme" className={cn(SETTING_BLOCK_CHROME, "rounded-2xl border border-border/60 bg-card/50 px-4 py-4 scroll-mt-28 sm:px-5")}>
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <Palette className="h-4 w-4 text-muted-foreground" />
            <div>
              <h3 className="text-sm font-semibold">{t("settings.themes")}</h3>
              <p className="text-xs text-muted-foreground">{t("settings.themesDescription")}</p>
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button variant="outline" size="sm" className={cn("shrink-0 gap-2 h-9", HEADER_PILL)} onClick={randomTheme}>
              <Shuffle className="h-4 w-4" />
              {t("settings2.themeRandom")}
            </Button>
          </div>
        </div>

        {/* Filter chips + name search */}
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          {(
            [
              { value: "all" as const },
              { value: "favorites" as const },
              { value: "custom" as const },
            ] as Array<{ value: ThemeFilter }>
          ).map((chip) => (
            <FilterChip
              key={chip.value}
              active={filter === chip.value}
              label={t(chip.value === "all" ? "settings2.themeFilterAll" : chip.value === "favorites" ? "settings2.themeFavorites" : "settings2.themeFilterMine")}
              count={chip.value === "all" ? allThemes.length : chip.value === "favorites" ? favorites.length : allThemes.filter((theme) => theme.custom).length}
              onClick={() => setFilter(chip.value)}
            />
          ))}
          {groupChips.map((group) => (
            <FilterChip
              key={group}
              active={filter === group}
              label={t(THEME_GROUP_LABEL_KEYS[group])}
              count={allThemes.filter((theme) => theme.group === group && !theme.custom).length}
              onClick={() => setFilter(group)}
            />
          ))}
        </div>
        <div className="relative mb-4">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={nameQuery}
            onChange={(event) => setNameQuery(event.target.value)}
            placeholder={t("settings2.themeSearchPlaceholder")}
            aria-label={t("settings2.themeSearchPlaceholder")}
            className="pl-9 pr-9 h-9 rounded-full border-border/60 bg-surface text-sm focus-visible:border-primary/50"
          />
          {nameQuery && (
            <button
              type="button"
              aria-label={t("settings2.clearSearch")}
              onClick={() => setNameQuery("")}
              className="absolute right-3 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* Flat dense grid: 2 tiles on a phone, up to 4 on desktop. */}
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4" onKeyDown={handleNavArrowKeys}>
          {visibleThemes.map(renderTile)}
        </div>
        {visibleThemes.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">{t("settings2.themeSearchEmpty")}</p>
        )}

        {/* The builder stays in the themes view but collapsed — its open
            state is internal and docks below the gallery. */}
        <div className="mt-4">
          <ThemeBuilder
            colorTheme={colorTheme}
            modePref={modePref}
            isDarkMode={previewDark}
            setColorTheme={setColorTheme}
          />
        </div>
      </div>
    </>
  );
};

function FilterChip({ active, label, count, onClick }: { active: boolean; label: string; count: number; onClick: () => void }) {
  return (
    <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    className={cn(
      "flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
      active
        ? "border-primary/40 bg-primary/10 text-primary"
        : "border-border/60 text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground",
    )}
  >
    {label}
    <span className={cn("tabular-nums", active ? "text-primary/70" : "text-muted-foreground/60")}>{count}</span>
  </button>
  );
}

/* ── Text view (шрифт + язык) ────────────────────────────────────────────── */

function TextView({ appearance }: { appearance: AppearanceSettings }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { customFont, language, setFont, setLanguage } = appearance;
  const rowClass = SETTING_BLOCK_CHROME;

  return (
    <div className="space-y-5">
      <SettingGroup divided={false}>
        <SettingBlock id="set-font" title={t("settings.font")} description={t("settings2.fontDesc")} icon={Type}>
          <Input
            value={customFont}
            onChange={(event) => setFont(event.target.value)}
            placeholder={t("settings.googleFontPlaceholder")}
            aria-label={t("settings.googleFont")}
            className={SITE_INPUT}
          />
          <p className="mt-2 text-xs text-muted-foreground">
            {t("settings.googleFontHint")}{" "}
            <a href="https://fonts.google.com/" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
              Google Fonts
            </a>
            . {t("settings.googleFontEmptyHint")}
          </p>
          <div className="mt-3 rounded-xl border border-border/50 bg-background/40 px-3 py-3">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{t("settings2.fontSampleLabel")}</p>
            <p className="mt-1 text-lg leading-snug">{t("settings2.fontSample")}</p>
          </div>
        </SettingBlock>
      </SettingGroup>

      <SettingGroup divided={false}>
        <SettingRow
          className={rowClass}
          id="set-language"
          icon={Globe}
          title={t("settings.language")}
          description={t("settings.languageDescription")}
        >
          <Select value={language} onValueChange={setLanguage}>
            <SelectTrigger className={cn(SITE_INPUT, "w-[min(220px,55vw)]")} aria-label={t("settings.language")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LANGUAGES.map((item) => (
                <SelectItem key={item.code} value={item.code}>
                  <span className="inline-flex items-center gap-2">
                    <span>{item.flag}</span>
                    <span>{item.nativeName}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>

        <SettingRow
          className={rowClass}
          icon={Languages}
          title={t("settings.translations")}
          description={t("settings.translationsDescription")}
          onClick={() => navigate("/translate")}
        />
      </SettingGroup>
    </div>
  );
};

/* ── Interface view (поведение интерфейса + медиа) ───────────────────────── */

function InterfaceView({ appearance }: { appearance: AppearanceSettings }) {
  const { t } = useTranslation();
  const {
    autoplayMode, headerBehavior, mrRandomCount, profileViewMode, publishStyle, transitionStyle,
    setAutoplayMode, setHeaderBehavior, setMrRandomCount, setProfileViewMode, setPublishStyle, setTransitionStyle,
  } = appearance;
  const rowClass = SETTING_BLOCK_CHROME;

  return (
    <div className="space-y-5">
      <SettingGroup divided={false}>
        <SettingBlock id="set-header" title={t("settings2.headerBehavior")} description={t("settings2.headerBehaviorDesc")} icon={PanelTop}>
          <div className="grid gap-3 sm:grid-cols-2" onKeyDown={handleNavArrowKeys}>
            {HEADER_BEHAVIORS.map((behavior) => (
              <OptionCard
                key={behavior.id}
                selected={headerBehavior === behavior.id}
                title={t(HEADER_KEYS[behavior.id].label)}
                description={t(HEADER_KEYS[behavior.id].desc)}
                onClick={() => setHeaderBehavior(behavior.id)}
              >
                <span className="block h-14 overflow-hidden rounded-xl border border-border/50 bg-background/40 p-1.5">
                  <span
                    className={cn(
                      "flex items-center justify-between rounded-md border border-border/50 bg-primary/25 px-2 py-1 transition-all duration-300",
                      behavior.id === "auto-hide" && "-translate-y-3 opacity-40",
                    )}
                  >
                    <span className="h-1.5 w-8 rounded-full bg-foreground/40" />
                    <span className="h-1.5 w-1.5 rounded-full bg-foreground/40" />
                  </span>
                  <span className="mt-2 block space-y-1.5 px-1">
                    <span className="block h-1.5 w-3/4 rounded-full bg-foreground/15" />
                    <span className="block h-1.5 w-1/2 rounded-full bg-foreground/15" />
                  </span>
                </span>
              </OptionCard>
            ))}
          </div>
        </SettingBlock>

        <SettingBlock id="set-transitions" title={t("settings2.transitions")} description={t("settings2.transitionsDesc")} icon={Blend}>
          <div className="grid gap-3 sm:grid-cols-2" onKeyDown={handleNavArrowKeys}>
            {TRANSITION_STYLES.map((style) => (
              <OptionCard
                key={style.id}
                selected={transitionStyle === style.id}
                title={t(TRANSITION_KEYS[style.id].label)}
                description={t(TRANSITION_KEYS[style.id].desc)}
                onClick={() => setTransitionStyle(style.id)}
              />
            ))}
          </div>
          <div className="mt-3">
            <TransitionPreview style={transitionStyle} />
          </div>
          {!supportsViewTransitions() && (
            <p className="mt-2 text-xs text-muted-foreground">{t("settings2.transitionsUnsupported")}</p>
          )}
          {isPerfLite() && <p className="mt-1 text-xs text-muted-foreground">{t("settings2.transitionsPerfLite")}</p>}
        </SettingBlock>
      </SettingGroup>

      <SettingGroup divided={false}>
        <SettingBlock id="set-mrrandom" title={t("settings2.mrRandom")} description={t("settings2.mrRandomDesc")} icon={Dices}>
          <Segmented
            aria-label={t("settings2.mrRandom")}
            value={mrRandomCount}
            onChange={setMrRandomCount}
            options={MR_RANDOM_COUNT_OPTIONS.map((count) => ({ value: count, label: String(count) }))}
          />
        </SettingBlock>

        <SettingBlock id="set-publish" title={t("settings2.publishButton")} description={t("settings2.publishButtonDesc")} icon={Send}>
          <div className="grid gap-3 sm:grid-cols-2" onKeyDown={handleNavArrowKeys}>
            {PUBLISH_BUTTON_STYLES.map((style) => (
              <OptionCard
                key={style.id}
                selected={publishStyle === style.id}
                title={t(PUBLISH_KEYS[style.id].label)}
                description={t(PUBLISH_KEYS[style.id].desc)}
                onClick={() => setPublishStyle(style.id)}
              >
                <span className="flex min-h-[52px] items-center justify-center rounded-xl border border-border/50 bg-background/40 p-2">
                  <PublishButton style={style.id} onClick={() => {}} />
                </span>
              </OptionCard>
            ))}
          </div>
        </SettingBlock>

        <SettingRow
          className={rowClass}
          id="set-autoplay"
          icon={PlayCircle}
          title={t("settings.autoplayMedia")}
          description={t("settings.autoplayMediaDescription")}
        >
          <Segmented
            aria-label={t("settings.autoplayMedia")}
            value={autoplayMode}
            onChange={setAutoplayMode}
            options={[
              { value: "always", label: t("settings.autoplayAlways") },
              { value: "wifi", label: t("settings.autoplayWifi") },
              { value: "never", label: t("settings.autoplayNever") },
            ]}
          />
        </SettingRow>
      </SettingGroup>

      {/* Least-used control — parked at the very bottom of the tab. */}
      <SettingGroup divided={false}>
        <SettingRow
          className={rowClass}
          id="set-profile-view"
          icon={LayoutGrid}
          title={t("settings2.profileDefaultView")}
          description={t("settings2.profileDefaultViewDesc")}
        >
          <Segmented
            aria-label={t("settings2.profileDefaultView")}
            value={profileViewMode}
            onChange={setProfileViewMode}
            options={[
              { value: "social", label: t("settings2.profileViewSocial") },
              { value: "forum", label: t("settings2.profileViewForum") },
            ]}
          />
        </SettingRow>
      </SettingGroup>
    </div>
  );
};
