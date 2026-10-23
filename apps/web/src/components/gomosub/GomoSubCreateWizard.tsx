import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { api } from "@/integrations/api/compat";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { uploadFile, storageUrl } from "@/utils/storage";
import { apiErrorMessage } from "@/utils/apiErrors";
import { cn } from "@/lib/utils";
import { Check, Globe, Hash, Lock, Pencil, Users } from "lucide-react";

/* ------------------------------------------------------------------ */
/* Presets                                                             */
/* ------------------------------------------------------------------ */

/** Channel created with the sub. `kind` matches the channels table column. */
export interface PresetChannel {
  slug: string;
  name: string;
  kind: "text" | "forum";
}

interface Template {
  id: "fandom" | "games" | "project" | "friends";
  emoji: string;
  title: string;
  note: string;
  desc: string;
  rules: string;
  /** Simple channel set — «близкий круг». */
  small: PresetChannel[];
  /** Full channel set — «большое сообщество». */
  big: PresetChannel[];
}

export const TEMPLATES: Template[] = [
  {
    id: "fandom",
    emoji: "✨",
    title: "Фандом",
    note: "Аниме, сериалы, книги, кумиры — всему жанру сюда",
    desc: "Комьюнити фандома: обсуждения, фан-арт и свежие новости.",
    rules:
      "Уважай участников и держись темы фандома. Новичков мы радуем, а не пугаем.\n\nМожно\n- Фан-арт, косплей и свои работы\n- Обсуждения серий, глав и новостей\n\nНельзя\n- Спам и реклама без разрешения\n- Оскорбления и травля участников",
    small: [
      { slug: "chat", name: "Чат", kind: "text" },
      { slug: "offtopic", name: "Оффтоп", kind: "text" },
    ],
    big: [
      { slug: "chat", name: "Чат", kind: "text" },
      { slug: "discussions", name: "Обсуждения", kind: "forum" },
      { slug: "fan-art", name: "Фан-арт", kind: "forum" },
      { slug: "news", name: "Новости", kind: "text" },
      { slug: "offtopic", name: "Оффтоп", kind: "text" },
    ],
  },
  {
    id: "games",
    emoji: "🎮",
    title: "Игры",
    note: "Гайды, билды, катки и поиск тимы",
    desc: "Игровое комьюнити: гайды, скрины, поиск тимы и новости патчей.",
    rules:
      "Уважай тиммейтов: не хами, не сливай чужие матчи.\n\nМожно\n- Гайды, билды и советы\n- Скрины и клипы из игры\n- Поиск тимы\n\nНельзя\n- Читы и обсуждение читов\n- Спам и реклама\n- Оскорбления в чате",
    small: [
      { slug: "chat", name: "Чат", kind: "text" },
      { slug: "offtopic", name: "Оффтоп", kind: "text" },
    ],
    big: [
      { slug: "chat", name: "Чат", kind: "text" },
      { slug: "guides", name: "Обсуждения и гайды", kind: "forum" },
      { slug: "screens", name: "Лут и скрины", kind: "forum" },
      { slug: "team-search", name: "Поиск тимы", kind: "text" },
      { slug: "offtopic", name: "Оффтоп", kind: "text" },
    ],
  },
  {
    id: "project",
    emoji: "🚀",
    title: "Проект / команда",
    note: "Работа, учеба, общий проект — по делу",
    desc: "Рабочая зона команды: задачи, инфо и обсуждения.",
    rules:
      "Коротко, по делу и уважительно. Договорились — делаем.\n\nМожно\n- Задачи, статусы и запросы на помощь\n- Полезные ссылки и документы\n\nНельзя\n- Спам и личные разборки\n- Флуд в рабочих каналах",
    small: [
      { slug: "chat", name: "Чат", kind: "text" },
      { slug: "tasks", name: "Задачи", kind: "forum" },
    ],
    big: [
      { slug: "chat", name: "Чат", kind: "text" },
      { slug: "tasks", name: "Задачи", kind: "forum" },
      { slug: "info", name: "Инфо и доки", kind: "text" },
      { slug: "ideas", name: "Идеи", kind: "forum" },
    ],
  },
  {
    id: "friends",
    emoji: "🛋",
    title: "Место для своих",
    note: "Локальный уголок для друзей — легко начать",
    desc: "Наш уголок: что видим — обсуждаем, что хотим — делаем.",
    rules:
      "Просто будь вежлив со своими. Место для отдыха, а не для разборок.\n\nНельзя\n- Спам и реклама",
    small: [
      { slug: "chat", name: "Чат", kind: "text" },
    ],
    big: [
      { slug: "chat", name: "Чат", kind: "text" },
      { slug: "offtopic", name: "Оффтоп", kind: "text" },
    ],
  },
];

export type ContextChoice = "small" | "big";

const CONTEXT_CODES = [
  {
    id: "small" as const,
    icon: Lock,
    title: "Близкий круг",
    note: "Приватный саб: вход по приглашению. Каналы — просто и по-домашнему.",
  },
  {
    id: "big" as const,
    icon: Globe,
    title: "Большое сообщество",
    note: "Публичный саб: виден в каталоге g, входит свободно. Полный набор каналов.",
  },
];

const SLUG_REGEX = /^[a-z0-9][a-z0-9_-]{1,24}$/;

const RESERVED_SLUGS = [
  "b", "pol", "a", "v", "mu", "fit", "d", "tv", "co", "int",
  "rules", "faq", "bugs", "g", "tech", "meta", "admin", "mod", "news",
];

/** Rough latinization so a Russian name still auto-suggests a usable slug. */
const TRANSLIT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z",
  и: "i", й: "i", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
  с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh",
  щ: "sh", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

const slugFromName = (name: string): string => {
  const base = name
    .toLowerCase()
    .split("")
    .map((ch) => TRANSLIT[ch] ?? ch)
    .join("")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 25)
    .replace(/^-|-$/g, "");
  if (!base || !SLUG_REGEX.test(base)) return "";
  return base;
};

const randomSlug = (): string =>
  `g-${Math.random().toString(36).slice(2, 8)}`;

/* ------------------------------------------------------------------ */
/* Result passed back to the page for the actual create call           */
/* ------------------------------------------------------------------ */

export interface WizardResult {
  slug: string;
  name: string;
  description: string;
  visibility: "public" | "private";
  rules_markdown: string;
  avatarPath: string | null;
  channels: PresetChannel[];
}

/* ------------------------------------------------------------------ */
/* Wizard                                                              */
/* ------------------------------------------------------------------ */

const STEPS = ["Шаблон", "Суть", "Финиш"] as const;

interface WizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Runs the actual creation; true → wizard closes with success. */
  onSubmit: (result: WizardResult) => Promise<boolean>;
}

export const GomoSubCreateWizard = ({ open, onOpenChange, onSubmit }: WizardProps) => {
  const { t } = useTranslation();
  const [index, setIndex] = useState(0);
  const [dir, setDir] = useState<1 | -1>(1);
  const [template, setTemplate] = useState<Template | null>(null);
  const [context, setContext] = useState<ContextChoice | null>(null);
  const [name, setName] = useState("");
  const [slugValue, setSlugValue] = useState<string | null>(null); // null → auto from name
  const [slugEditing, setSlugEditing] = useState(false);
  const [avatarPath, setAvatarPath] = useState<string | null>(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [creating, setCreating] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) {
      // Fresh slate for the next run.
      setIndex(0);
      setDir(1);
      setTemplate(null);
      setContext(null);
      setName("");
      setSlugValue(null);
      setSlugEditing(false);
      setAvatarPath(null);
      setUploadingAvatar(false);
      setCreating(false);
    }
  }, [open]);

  const visibility: "public" | "private" = context === "small" ? "private" : "public";
  const channels = useMemo(
    () => (template && context ? (context === "small" ? template.small : template.big) : []),
    [template, context],
  );

  const autoSlug = useMemo(() => slugFromName(name) || randomSlug(), [name]);
  const slug = slugValue ?? autoSlug;

  const slugValid =
    SLUG_REGEX.test(slug) &&
    !RESERVED_SLUGS.includes(slug) &&
    slug.length >= 2 &&
    slug.length <= 25;

  const canNext =
    (index === 0 && template !== null) ||
    (index === 1 && context !== null) ||
    (index === 2 && name.trim().length > 0 && slugValid);

  const go = (next: number) => {
    setDir(next > index ? 1 : -1);
    setIndex(next);
  };

  const handleAvatarFile = useCallback(async (file: File) => {
    const valid = ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"];
    if (!valid.includes(file.type)) {
      toast.error("Неподдерживаемый формат. Используйте JPG, PNG, WEBP или GIF");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast.error("Файл слишком большой. Максимум 10MB");
      return;
    }
    setUploadingAvatar(true);
    try {
      const { data: { user } } = await api.auth.getUser();
      if (!user) {
        toast.error("Нужно войти в аккаунт");
        return;
      }
      const ext = file.name.split(".").pop() || "jpg";
      const fileName = `${user.id}/${Date.now()}_avatar.${ext}`;
      const uploaded = await uploadFile("post-images", fileName, file);
      setAvatarPath(uploaded.path);
      toast.success("Аватар загружен");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setUploadingAvatar(false);
    }
  }, []);

  const handleCreate = async () => {
    if (!template || !context || !slugValid) return;
    const result: WizardResult = {
      slug,
      name: name.trim(),
      description: template.desc,
      visibility,
      rules_markdown: template.rules,
      avatarPath,
      channels,
    };
    setCreating(true);
    try {
      const ok = await onSubmit(result);
      if (ok) onOpenChange(false);
    } catch (e) {
      toast.error(apiErrorMessage(e as Error, t, "error.generic"));
    } finally {
      setCreating(false);
    }
  };

  const commitSlugEdit = () => setSlugEditing(false);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        overlayClassName="bg-background/95 backdrop-blur-sm"
        className="flex h-[min(680px,92dvh)] w-[96vw] flex-col gap-0 overflow-hidden rounded-2xl border-border/60 bg-surface p-0 shadow-2xl sm:max-w-lg"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Создание g-саба</DialogTitle>
        </DialogHeader>

        {/* Header: progress bar + step dot/title (× is the shared Dialog Close) */}
        <div className="relative shrink-0 px-5 pt-4">
          <div className="flex items-center justify-between pr-9">
            <span className="text-[13px] font-semibold text-foreground/90">
              <span className="text-muted-foreground">{index + 1} ·</span> {STEPS[index]}
            </span>
            <span className="text-[11px] tabular-nums text-muted-foreground/60">{index + 1}/{STEPS.length}</span>
          </div>
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all duration-300 ease-out"
              style={{ width: `${((index + 1) / STEPS.length) * 100}%` }}
            />
          </div>
        </div>

        {/* Body: one thought per screen, slide transitions.
            Outer frame clips the slides (no scrollbars mid-animation); the
            inner scroller owns vertical scrolling with a stable gutter so the
            classic scrollbar never flashes in/out while steps change. */}
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <div className="absolute inset-0 overflow-y-auto overflow-x-hidden px-5 py-5 [scrollbar-gutter:stable]">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={index}
                initial={{ opacity: 0, x: dir * 48 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: dir * -48 }}
                transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
              >
                {index === 0 && (
                  <WizardPickTemplate template={template} onPick={(t) => setTemplate(t)} />
                )}
                {index === 1 && (
                  <WizardPickContext
                    context={context}
                    template={template}
                    onPick={(ctx) => setContext(ctx)}
                  />
                )}
                {index === 2 && (
                  <WizardFinish
                    name={name}
                    setName={setName}
                    slug={slug}
                    slugValid={slugValid}
                    slugEditing={slugEditing}
                    onSlugStartEdit={() => { setSlugValue(slug); setSlugEditing(true); }}
                    onSlugEdit={(v) => setSlugValue(v.toLowerCase())}
                    onCancelSlugEdit={() => setSlugValue(null)}
                  onCommitSlug={commitSlugEdit}
                  avatarPath={avatarPath}
                  uploadingAvatar={uploadingAvatar}
                  onAvatarClick={() => avatarInputRef.current?.click()}
                  context={context}
                  channels={channels}
                />
              )}
            </motion.div>
          </AnimatePresence>
          </div>
        </div>

        {/* Footer: back / next */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border/60 px-5 py-3">
          <Button
            variant="ghost"
            className="h-10 rounded-full px-4"
            disabled={index === 0 || creating}
            onClick={() => go(index - 1)}
          >
            Назад
          </Button>
          {index < STEPS.length - 1 ? (
            <Button
              className="h-10 rounded-full px-6"
              disabled={!canNext}
              onClick={() => go(index + 1)}
            >
              Далее
            </Button>
          ) : (
            <Button
              className="h-10 rounded-full px-6"
              disabled={!canNext || creating}
              onClick={handleCreate}
            >
              {creating ? "Создаём…" : "Создать"}
            </Button>
          )}
        </div>

        <input
          ref={avatarInputRef}
          type="file"
          accept="image/jpeg,image/jpg,image/png,image/webp,image/gif"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleAvatarFile(file);
            e.target.value = "";
          }}
        />
      </DialogContent>
    </Dialog>
  );
};

/* ------------------------------------------------------------------ */
/* Step 1 — template grid                                              */
/* ------------------------------------------------------------------ */

const WizardPickTemplate = ({
  template,
  onPick,
}: {
  template: Template | null;
  onPick: (t: Template) => void;
}) => (
  <div>
    <h2 className="text-lg font-bold tracking-tight">С чего начинаем?</h2>
    <p className="mt-0.5 text-sm text-muted-foreground">
      Выбери вариант — сделаем стартовую заготовку каналов и правил. Дальше всё можно поменять в настройках.
    </p>
    <div className="mt-4 grid gap-2.5 sm:grid-cols-2">
      {TEMPLATES.map((t, i) => (
        <motion.button
          key={t.id}
          type="button"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.04, duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
          onClick={() => onPick(t)}
          className={cn(
            "rounded-2xl border p-4 text-left transition-all",
            template?.id === t.id
              ? "border-primary/60 bg-primary/[0.06] shadow-sm"
              : "border-border/60 bg-card hover:border-primary/40 hover:bg-muted/40",
          )}
        >
          <div className="flex items-start justify-between">
            <span aria-hidden className="text-2xl leading-none">{t.emoji}</span>
            {template?.id === t.id && (
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                <Check className="h-3 w-3" strokeWidth={3} />
              </span>
            )}
          </div>
          <div className="mt-2 text-sm font-bold leading-tight">{t.title}</div>
          <div className="mt-0.5 text-xs leading-snug text-muted-foreground">{t.note}</div>
        </motion.button>
      ))}
    </div>
  </div>
);

/* ------------------------------------------------------------------ */
/* Step 2 — context                                                    */
/* ------------------------------------------------------------------ */

const WizardPickContext = ({
  context,
  template,
  onPick,
}: {
  context: ContextChoice | null;
  template: Template | null;
  onPick: (c: ContextChoice) => void;
}) => {
  const channels = template && context ? (context === "small" ? template.small : template.big) : [];
  return (
    <div>
      <h2 className="text-lg font-bold tracking-tight">Для кого этот саб?</h2>
      <p className="mt-0.5 text-sm text-muted-foreground">
        От этого решается видимость и стартовый набор каналов.
      </p>
      <div className="mt-4 space-y-2.5">
        {CONTEXT_CODES.map((c, i) => (
          <motion.button
            key={c.id}
            type="button"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.04, duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            onClick={() => onPick(c.id)}
            className={cn(
              "flex w-full items-start gap-3.5 rounded-2xl border p-4 text-left transition-all",
              context === c.id
                ? "border-primary/60 bg-primary/[0.06] shadow-sm"
                : "border-border/60 bg-card hover:border-primary/40 hover:bg-muted/40",
            )}
          >
            <span className={cn(
              "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
              context === c.id ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground",
            )}>
              <c.icon className="h-5 w-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-bold leading-tight">{c.title}</span>
              <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">{c.note}</span>
            </span>
            {context === c.id && (
              <span className="mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                <Check className="h-3 w-3" strokeWidth={3} />
              </span>
            )}
          </motion.button>
        ))}
      </div>

      {template && context && channels.length > 0 && (
        <div className="mt-4">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70">
            Стартовые каналы
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {channels.map((ch) => (
              <span
                key={ch.slug}
                className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2.5 py-1 text-xs text-foreground/80"
              >
                {ch.kind === "text" ? <Hash className="h-3 w-3 text-muted-foreground" /> : null}
                {ch.name}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Step 3 — finish                                                     */
/* ------------------------------------------------------------------ */

interface FinishProps {
  name: string;
  setName: (v: string) => void;
  slug: string;
  slugValid: boolean;
  slugEditing: boolean;
  onSlugStartEdit: () => void;
  onSlugEdit: (v: string) => void;
  onCancelSlugEdit: () => void;
  onCommitSlug: () => void;
  avatarPath: string | null;
  uploadingAvatar: boolean;
  onAvatarClick: () => void;
  context: ContextChoice | null;
  channels: PresetChannel[];
}

/** Static mini-preview in the same visual language as GomoSubCard. */
const WizardPreview = ({
  name,
  slug,
  avatarPath,
  context,
  channels,
}: {
  name: string;
  slug: string;
  avatarPath: string | null;
  context: ContextChoice | null;
  channels: PresetChannel[];
}) => {
  const letter = (name.trim()[0] || "g").toUpperCase();
  return (
    <article className="relative mx-auto flex w-full max-w-[17rem] flex-col overflow-hidden rounded-2xl border border-border/70 bg-surface shadow-md">
      <div className="relative h-20 overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-primary/20 via-primary/10 to-muted">
          <span
            aria-hidden
            className="absolute -bottom-4 right-3 select-none text-6xl font-black uppercase leading-none tracking-tight text-primary/20"
          >
            {letter}
          </span>
        </div>
        {context === "small" && (
          <span className="absolute right-2 top-2 flex items-center gap-1 rounded-full bg-background/80 px-2 py-0.5 text-[11px] backdrop-blur-sm">
            <Lock className="h-3 w-3" />
            Приватный
          </span>
        )}
      </div>
      <div className="pointer-events-none relative -mb-2 px-4">
        <div className="absolute -top-[1.5rem] h-12 w-12 overflow-hidden rounded-2xl border-2 border-background bg-muted shadow-md">
          {avatarPath ? (
            <img
              src={storageUrl("post-images", avatarPath) ?? undefined}
              alt=""
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-primary/30 to-muted text-base font-bold text-primary">
              {letter}
            </div>
          )}
        </div>
      </div>
      <div className="flex flex-col px-4 pb-3.5 pt-9">
        <h3 className="min-w-0 truncate text-[15px] font-bold">{name.trim() || "Название саба"}</h3>
        <div className="text-sm font-semibold text-primary">g/{slug || "адрес"}</div>
        <div className="mt-auto flex items-center gap-3 pt-2 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <Users className="h-3 w-3" />
            1
          </span>
          {channels.length > 0 && (
            <span className="flex items-center gap-1">
              <Hash className="h-3 w-3" />
              {channels.length}
            </span>
          )}
        </div>
      </div>
    </article>
  );
};

const WizardFinish = (props: FinishProps) => {
  const {
    name, setName, slug, slugValid, slugEditing,
    onSlugStartEdit, onSlugEdit, onCancelSlugEdit, onCommitSlug,
    avatarPath, uploadingAvatar, onAvatarClick,
    context, channels,
  } = props;
  const letter = (name.trim()[0] || "g").toUpperCase();

  return (
    <div>
      <h2 className="text-lg font-bold tracking-tight">Финиш</h2>
      <p className="mt-0.5 text-sm text-muted-foreground">
        Название, аватар и адрес — остальное уже решено. Правку можно вести потом в настройках.
      </p>

      <div className="mt-4 flex items-center gap-3.5">
        <button
          type="button"
          onClick={onAvatarClick}
          className="group relative h-16 w-16 shrink-0 overflow-hidden rounded-2xl border border-border/60 bg-muted shadow-sm"
          aria-label="Загрузить аватар"
        >
          {avatarPath ? (
            <img src={storageUrl("post-images", avatarPath) ?? undefined} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-primary/30 to-muted text-lg font-bold text-primary">
              {uploadingAvatar ? "…" : letter}
            </div>
          )}
          <div className="absolute inset-0 flex items-center justify-center bg-black/30 text-[10px] font-semibold text-white opacity-0 transition-opacity group-hover:opacity-100">
            {uploadingAvatar ? "…" : "Фото"}
          </div>
        </button>
        <div className="min-w-0 flex-1 space-y-1.5">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            placeholder="Название саба"
            autoFocus
          />
          {/* slug chip for public subs; editable by click */}
          {context === "big" ? (
            slugEditing ? (
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-muted-foreground">g/</span>
                <Input
                  value={slug}
                  onChange={(e) => onSlugEdit(e.target.value.toLowerCase())}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onCommitSlug();
                    if (e.key === "Escape") onCancelSlugEdit();
                  }}
                  onBlur={onCommitSlug}
                  autoFocus
                  className="h-7 w-40 text-xs"
                  placeholder="адрес-слаг"
                />
              </div>
            ) : (
              <button
                type="button"
                onClick={onSlugStartEdit}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors",
                  slugValid
                    ? "border-border/60 bg-muted/40 text-foreground/80 hover:border-primary/50"
                    : "border-destructive/50 bg-destructive/5 text-destructive",
                )}
              >
                <span className="text-muted-foreground">g/</span>{slug || "адрес"}
                <Pencil className="h-3 w-3 text-muted-foreground" />
              </button>
            )
          ) : (
            <span className="block text-xs text-muted-foreground">
              Приватный саб — в каталоге виден не будет
            </span>
          )}
        </div>
      </div>

      <div className="mt-5">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70">
          Так это будет выглядеть в каталоге
        </div>
        <div className="mt-2">
          <WizardPreview
            name={name}
            slug={slug}
            avatarPath={avatarPath}
            context={context}
            channels={channels}
          />
        </div>
      </div>
    </div>
  );
};
