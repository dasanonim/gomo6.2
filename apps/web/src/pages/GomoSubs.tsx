import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { invalidateByPrefix } from "@/integrations/api/queryCache";
import { api } from "@/integrations/api/compat";
import { X, Search, Plus, ArrowUpDown, ChevronDown, Check } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { NavigationLink } from "@/components/NavigationLink";
import { storageUrl } from "@/utils/storage";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { STREAM_CASCADE_VARIANTS, STREAM_ITEM_VARIANTS, springFor } from "@/lib/motion";
import { GomoSubCard } from "@/components/gomosub/GomoSubCard";
import { cn } from "@/lib/utils";
import { useCachedQuery } from "@/hooks/useCachedQuery";
import {
  fetchGomoSubsDirectory,
  GOMOSUBS_DIRECTORY_KEY,
  GOMOSUBS_STALE_MS,
  GOMOSUBS_TTL_MS,
  type GomoSubDirectoryItem,
} from "@/routes/data/gomosubData";

type ViewTab = "all" | "mine";
type SortKey = "popular" | "new" | "alpha";

/** Cards animated on entry — the visible first rows of the grid. */
const INITIAL_CASCADE_LIMIT = 9;

const SORTS: { key: SortKey; label: string }[] = [
  { key: "popular", label: "Популярные" },
  { key: "new", label: "Новые" },
  { key: "alpha", label: "По алфавиту" },
];

const GomoSubs = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [userId, setUserId] = useState<string | null>(null);
  const [joinedBySub, setJoinedBySub] = useState<Record<string, boolean>>({});
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const q = (searchParams.get("q") ?? "").trim();
  const inputQuery = searchParams.get("q") ?? "";
  const tab = (searchParams.get("tab") as ViewTab | null) ?? "all";
  const sort = (searchParams.get("sort") as SortKey | null) ?? "popular";

  // SWR: instant on a warm cache (the route preloader warmed /g), background
  // revalidation otherwise. Returning to the catalog is instant.
  const { data: subsData, error: subsError } = useCachedQuery<GomoSubDirectoryItem[]>(
    GOMOSUBS_DIRECTORY_KEY,
    fetchGomoSubsDirectory,
    { ttlMs: GOMOSUBS_TTL_MS, staleTtlMs: GOMOSUBS_STALE_MS },
  );
  const subs = useMemo(() => subsData ?? [], [subsData]);
  const loading = subsData === undefined && !subsError;

  useEffect(() => {
    const load = async () => {
      const { data: { session } } = await api.auth.getSession();
      setUserId(session?.user?.id ?? null);
    };
    load();
  }, []);

  // Local join/leave state, seeded from the directory rows (owner updates are
  // optimistic; the directory cache itself refreshes after every toggle).
  useEffect(() => {
    setJoinedBySub((prev) => {
      const next: Record<string, boolean> = { ...prev };
      for (const sub of subs) {
        if (prev[sub.id] === undefined) next[sub.id] = sub.joined;
      }
      return next;
    });
  }, [subs]);

  const isJoined = useCallback((sub: GomoSubDirectoryItem) => joinedBySub[sub.id] ?? sub.joined, [joinedBySub]);

  const prefersReducedMotion = useReducedMotion();

  const setQueryState = useCallback(
    (updates: { q?: string; tab?: ViewTab; sort?: SortKey }) => {
      const next = new URLSearchParams(searchParams);
      for (const [key, value] of Object.entries(updates)) {
        const defaults = { tab: "all", sort: "popular", q: "" }[key] ?? "";
        if (!value || value === defaults) next.delete(key);
        else next.set(key, value);
      }
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const switchTab = useCallback(
    (value: ViewTab) => {
      // Switching to a (often much shorter) list while stranded deep in the
      // page reads as a broken jump — glide back to the top instead. Only
      // when the page is meaningfully scrolled; the tab change itself stays
      // in place.
      if (tab !== value && window.scrollY > 240 && !prefersReducedMotion && "scrollBehavior" in document.documentElement.style) {
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
      setQueryState({ tab: value });
    },
    [tab, prefersReducedMotion, setQueryState],
  );

  const handleSearchChange = (value: string) => {
    setQueryState({ q: value });
  };

  const toggleMembership = async (sub: GomoSubDirectoryItem) => {
    if (!userId) {
      toast.error("Войди в аккаунт, чтобы вступать в сабы");
      navigate("/auth");
      return;
    }
    if (togglingId) return;
    setTogglingId(sub.id);
    const joined = isJoined(sub);

    const { error } = joined
      ? await api
          .from("gomosub_memberships")
          .delete()
          .eq("board_id", sub.id)
          .eq("user_id", userId)
      : await api.from("gomosub_memberships").insert({ board_id: sub.id, user_id: userId });

    setTogglingId(null);
    if (error) {
      toast.error(joined ? "Не удалось выйти из саба" : "Не удалось вступить в саб");
      return;
    }
    setJoinedBySub((prev) => ({ ...prev, [sub.id]: !joined }));
    toast.success(joined ? `Ты вышел из g/${sub.slug}` : `Добро пожаловать в g/${sub.slug}`);
    invalidateByPrefix(GOMOSUBS_DIRECTORY_KEY);
  };

  // ── Derived views ──
  const normalized = (s: string) => s.toLowerCase();
  const filtered = useMemo(() => {
    let list = subs;
    if (tab === "mine") list = list.filter((sub) => isJoined(sub));
    if (q) {
      const needle = normalized(q);
      list = list.filter(
        (sub) =>
          normalized(sub.name).includes(needle) ||
          normalized(sub.slug).includes(needle) ||
          (sub.description ?? "").toLowerCase().includes(needle) ||
          (sub.gomosub_tags ?? []).some((t) => t.toLowerCase().includes(needle)),
      );
    }
    const sorted = [...list];
    if (sort === "popular") sorted.sort((a, b) => b.member_count - a.member_count);
    if (sort === "new") sorted.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    if (sort === "alpha") sorted.sort((a, b) => a.name.localeCompare(b.name, "ru"));
    return sorted;
  }, [subs, tab, q, sort, isJoined]);

  const mine = useMemo(() => subs.filter((sub) => isJoined(sub)), [subs, isJoined]);

  const hasQuery = Boolean(q);

  // Telegram-style lift+scale cascade: only once, when the first real data
  // lands (same latch pattern as the feed / conversation list). Search changes
  // afterwards must not re-cascade.
  const didAnimateRef = useRef(false);
  const runInitialCascade =
    subsData !== undefined && subs.length > 0 && !prefersReducedMotion && !didAnimateRef.current;

  return (
    <div className="max-w-6xl mx-auto w-full px-3 sm:px-5">
      {/* ── Floating search + view controls (no catalog header по правке UI) ── */}
      <div className="sticky top-[var(--app-header-pad,60px)] z-30 py-2.5">
        <div className="rounded-2xl border border-border/50 bg-surface/85 p-2 shadow-sm backdrop-blur-md">
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                ref={searchInputRef}
                value={inputQuery}
                onChange={(e) => handleSearchChange(e.target.value)}
                placeholder="Найти саб — название, slug или тег"
                className="h-9 w-full rounded-full border border-border/60 bg-surface pl-10 pr-10 text-sm outline-none transition-colors placeholder:text-muted-foreground focus:border-primary/50"
                aria-label="Поиск сообществ"
              />
              {inputQuery && (
                <button
                  onClick={() => {
                    handleSearchChange("");
                    searchInputRef.current?.focus();
                  }}
                  aria-label="Очистить поиск"
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            {userId && (
              <div className="grid shrink-0 grid-cols-2 rounded-full border border-border/50 bg-surface p-0.5" role="tablist" aria-label="Фильтр сообществ">
                {(["all", "mine"] as const).map((t) => (
                  <button
                    key={t}
                    role="tab"
                    aria-selected={tab === t}
                    onClick={() => switchTab(t)}
                    className="relative h-9 rounded-full px-3.5 text-sm"
                  >
                    {/* Telegram-style thumb: one shared layoutId element slides
                        and morphs between the two labels instead of two fades. */}
                    {tab === t && (
                      <motion.span
                        layoutId="gomosub-view-thumb"
                        className="absolute inset-0 rounded-full bg-primary"
                        transition={springFor("snappy", prefersReducedMotion)}
                      />
                    )}
                    <span
                      className={cn(
                        "relative z-10 transition-colors duration-200",
                        tab === t ? "font-medium text-primary-foreground" : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {t === "all" ? "Все" : "Мои"}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
          {tab === "all" && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className="mt-1.5 inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                aria-label="Сортировка"
              >
                <ArrowUpDown className="h-3 w-3" />
                {SORTS.find((s) => s.key === sort)?.label ?? SORTS[0].label}
                <ChevronDown className="h-3 w-3 opacity-70" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-44 rounded-xl">
                {SORTS.map((s) => (
                  <DropdownMenuItem
                    key={s.key}
                    onClick={() => setQueryState({ sort: s.key })}
                    className={cn("text-sm", sort === s.key && "font-medium text-primary")}
                  >
                    {sort === s.key && <Check className="h-3.5 w-3.5 text-primary" />}
                    {s.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {/* ── Joined rail (always visible: with subs or as a create entry) ── */}
      <section>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-muted-foreground">Мои сообщества</h2>
          <button
            onClick={() => navigate("/g/create")}
            title="Создать новый саб"
            aria-label="Создать новый саб"
            className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
        {mine.length > 0 ? (
          <div className="mt-2 flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
            {mine.map((sub) => {
              const avatar = sub.gomosub_avatar_url
                ? storageUrl("post-images", sub.gomosub_avatar_url)
                : null;
              return (
                <NavigationLink
                  key={sub.id}
                  to={`/g/${sub.slug}`}
                  prefetchOnViewport
                  className="group flex shrink-0 items-center gap-2 rounded-full border border-border/60 bg-surface py-1.5 pl-2 pr-3.5 transition-colors hover:border-primary/40"
                >
                  <span className="h-7 w-7 overflow-hidden rounded-full bg-muted">
                    {avatar ? (
                      <img src={avatar || undefined} alt="" className="h-full w-full object-cover" loading="lazy" />
                    ) : (
                      <span className="flex h-full w-full items-center justify-center text-xs font-bold text-primary">
                        {(sub.name?.[0] || sub.slug[0] || "g").toUpperCase()}
                      </span>
                    )}
                  </span>
                  <span className="text-sm font-medium text-primary">g/{sub.slug}</span>
                </NavigationLink>
              );
            })}
          </div>
        ) : (
          <button
            onClick={() => navigate("/g/create")}
            className="mt-2 flex h-11 items-center gap-2 rounded-full border border-dashed border-border/70 px-4 text-sm text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
          >
            <Plus className="h-4 w-4 text-primary" />
            Создай первый саб
          </button>
        )}
      </section>

      {/* ── Catalog grid ── */}
      <main className="mt-4 pb-10">
        {loading ? (
          <div className="grid gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="overflow-hidden rounded-2xl border border-border/70 bg-surface">
                <Skeleton className="h-24 w-full rounded-none sm:h-28" />
                <div className="space-y-2.5 px-4 pb-4 pt-10">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-3 w-1/3" />
                  <Skeleton className="h-3 w-full" />
                </div>
              </div>
            ))}
          </div>
        ) : subsError ? (
          <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-8 text-center">
            <p className="font-semibold">Не удалось загрузить каталог сабов</p>
            <p className="mt-1 text-sm text-muted-foreground">Проверь соединение и обнови страницу</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border/70 bg-surface/50 p-10 text-center">
            <p className="text-lg font-semibold">
              {hasQuery ? "Ничего не нашлось" : tab === "mine" ? "Ты пока не в сабах" : "Пока нет публичных сабов"}
            </p>
            <p className="mt-1.5 text-sm text-muted-foreground">
              {hasQuery
                ? "Попробуй другой запрос или сбрось фильтры"
                : tab === "mine"
                  ? "Найди свой саб во вкладке «Все» и вступи"
                  : "Создай первый — и он появится здесь"}
            </p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {hasQuery && (
                <Button variant="outline" size="sm" onClick={() => handleSearchChange("")}>
                  Сбросить поиск
                </Button>
              )}
              {tab === "all" && !hasQuery && (
                <Button size="sm" onClick={() => navigate("/g/create")}>
                  <Plus className="mr-1.5 h-4 w-4" />
                  Создать саб
                </Button>
              )}
            </div>
          </div>
        ) : (
          <motion.div
            className="grid gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3"
            variants={runInitialCascade ? STREAM_CASCADE_VARIANTS : undefined}
            initial={runInitialCascade ? "hidden" : false}
            animate={runInitialCascade ? "show" : undefined}
            onAnimationComplete={() => { didAnimateRef.current = true; }}
          >
            {filtered.map((sub, index) => {
              const card = (
                <GomoSubCard
                  sub={{ ...sub, joined: isJoined(sub) }}
                  isToggling={togglingId === sub.id}
                  onToggleJoin={toggleMembership}
                />
              );
              if (runInitialCascade && index < INITIAL_CASCADE_LIMIT) {
                return (
                  <motion.div key={sub.id} variants={STREAM_ITEM_VARIANTS} data-motion="cascade-row">
                    {card}
                  </motion.div>
                );
              }
              return <div key={sub.id}>{card}</div>;
            })}
          </motion.div>
        )}
      </main>
    </div>
  );
};

export default GomoSubs;
