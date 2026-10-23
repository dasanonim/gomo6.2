import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { motion } from "motion/react";
import { api } from "@/integrations/api/compat";
import { invalidateByPrefix } from "@/integrations/api/queryCache";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { storageUrl, uploadFile } from "@/utils/storage";
import { apiErrorMessage } from "@/utils/apiErrors";
import { cn } from "@/lib/utils";
import { Loader2, CheckCircle2, XCircle, Upload, Minus as MinusIcon, Globe, Lock } from "lucide-react";

const RESERVED_SLUGS = [
  "b", "pol", "a", "v", "mu", "fit", "d", "tv", "co", "int",
  "rules", "faq", "bugs", "g", "tech", "meta", "admin", "mod", "news"
];

const SLUG_REGEX = /^[a-z0-9][a-z0-9_-]{1,24}$/;

type Step = "requirements" | "form";
type Visibility = "public" | "private";

const GomoSubCreate = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>("requirements");
  const [creating, setCreating] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [uploadingCover, setUploadingCover] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [guideRead, setGuideRead] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement | null>(null);
  const coverInputRef = useRef<HTMLInputElement | null>(null);

  const [coverImages, setCoverImages] = useState<string[]>([]);
  const [avatarImages, setAvatarImages] = useState<string[]>([]);
  const [form, setForm] = useState({
    slug: "",
    name: "",
    description: "",
    standardRules: "Уважай участников, соблюдай тему саба и не публикуй запрещенный контент.",
  });
  const [visibility, setVisibility] = useState<Visibility>("public");

  const [allowedRules, setAllowedRules] = useState<string[]>([""]);
  const [forbiddenRules, setForbiddenRules] = useState<string[]>([""]);
  const [garma, setGarma] = useState<number>(0);
  const [profileCreatedAt, setProfileCreatedAt] = useState<string | null>(null);

  const [showImportDialog, setShowImportDialog] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importInfo, setImportInfo] = useState<Record<string, unknown> | null>(null);
  const [importing, setImporting] = useState(false);
  const [importLoading, setImportLoading] = useState(false);

  const garmaOk = useMemo(() => garma >= 10, [garma]);
  const slugOk = useCallback(
    () => SLUG_REGEX.test(form.slug.trim()) && !RESERVED_SLUGS.includes(form.slug.trim()),
    [form.slug],
  );
  const ageOk = useMemo(() => {
    if (!profileCreatedAt) return false;
    return Date.now() - new Date(profileCreatedAt).getTime() >= 14 * 24 * 60 * 60 * 1000;
  }, [profileCreatedAt]);
  // TODO: uncomment to restore garma (&gt;=10) and account age (&gt;2 weeks) checks
  // const canProceed = garmaOk && ageOk && guideRead;
  const canProceed = guideRead;

  useEffect(() => {
    const load = async () => {
      const { data: { session } } = await api.auth.getSession();
      if (!session?.user) return;
      const { data } = await api
        .from("profiles")
        .select("garma, created_at")
        .eq("id", session.user.id)
        .single();
      setGarma((data?.garma as number) ?? 0);
      setProfileCreatedAt((data?.created_at as string) ?? null);
    };
    load();
  }, []);

  const validate = () => {
    const trimmedSlug = form.slug.trim().toLowerCase();
    if (!SLUG_REGEX.test(trimmedSlug)) {
      toast.error("Слаг: латиница, цифры, - или _, от 2 до 25 символов");
      return null;
    }
    if (RESERVED_SLUGS.includes(trimmedSlug)) {
      toast.error("Слаг зарезервирован системой");
      return null;
    }
    if (!form.name.trim()) {
      toast.error("Название обязательно");
      return null;
    }
    if (!form.description.trim()) {
      toast.error("Описание обязательно");
      return null;
    }
    return trimmedSlug;
  };

  const buildRulesMarkdown = () => {
    const allowed = allowedRules.map((x) => x.trim()).filter(Boolean);
    const forbidden = forbiddenRules.map((x) => x.trim()).filter(Boolean);

    const blocks: string[] = [];
    if (form.standardRules.trim()) {
      blocks.push(form.standardRules.trim());
    }
    if (allowed.length) {
      blocks.push(`Можно\n${allowed.map((x) => `- ${x}`).join("\n")}`);
    }
    if (forbidden.length) {
      blocks.push(`Нельзя\n${forbidden.map((x) => `- ${x}`).join("\n")}`);
    }
    return blocks.join("\n\n").trim() || null;
  };

  const handleImportFileSelect = async (file: File) => {
    setImportFile(file);
    setImportInfo(null);
    setImportLoading(true);
    try {
      const { data: { session } } = await api.auth.getSession();
      const token = session?.access_token;
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/v1/boards/import/info", {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      });
      const data = await res.json();
      if (data.success) {
        setImportInfo(data.data);
      } else {
        toast.error(data.error || "Не удалось прочитать архив");
      }
    } catch (e) {
      toast.error("Ошибка чтения архива");
    } finally {
      setImportLoading(false);
    }
  };

  const handleImport = async () => {
    if (!importFile) return;
    setImporting(true);
    try {
      const { data: { session } } = await api.auth.getSession();
      const token = session?.access_token;
      const formData = new FormData();
      formData.append("file", importFile);
      const res = await fetch("/api/v1/boards/backup/import", {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      });
      const importResult = await res.json();
      if (importResult.success) {
        toast.success("G-саб импортирован");
        setShowImportDialog(false);
        navigate(`/g/${importResult.data.board_slug}`);
      } else {
        toast.error(importResult.error || "Ошибка импорта");
      }
    } catch (e) {
      toast.error("Ошибка импорта");
    } finally {
      setImporting(false);
    }
  };

  const uploadSingleImage = async (file: File, kind: "avatar" | "cover") => {
    const validTypes = ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"];
    if (!validTypes.includes(file.type)) {
      toast.error("Неподдерживаемый формат. Используйте JPG, PNG, WEBP или GIF");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast.error("Файл слишком большой. Максимум 10MB");
      return;
    }

    if (kind === "avatar") setUploadingAvatar(true);
    else setUploadingCover(true);

    try {
      const { data: { user } } = await api.auth.getUser();
      if (!user) {
        toast.error("Нужно войти в аккаунт");
        return;
      }

      const ext = file.name.split(".").pop() || "jpg";
      const fileName = `${user.id}/${Date.now()}_${kind}.${ext}`;
      // The upload pipeline may re-encode the image (JPEG → WebP) and store it
      // under a renamed key — always persist the actual stored path returned by
      // the server, never the pre-computed key (a stale extension 404s later).
      const uploaded = await uploadFile("post-images", fileName, file);
      const storedPath = uploaded.path;

      if (kind === "avatar") setAvatarImages([storedPath]);
      else setCoverImages([storedPath]);
      toast.success(kind === "avatar" ? "Аватар загружен" : "Фон загружен");
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      toast.error(errMsg || "Не удалось загрузить изображение");
    } finally {
      if (kind === "avatar") setUploadingAvatar(false);
      else setUploadingCover(false);
    }
  };

  const handleCreate = async () => {
    const { data: { user } } = await api.auth.getUser();
    if (!user) {
      toast.error("Войдите, чтобы создать g-саб");
      navigate("/auth");
      return;
    }
    // TODO: uncomment to restore garma & age checks
    // if (!(garmaOk && ageOk)) {
    //   toast.error("Для создания нужно >=10 gармы и аккаунт старше 2 недель");
    //   return;
    // }

    const slug = validate();
    if (!slug) return;

    setCreating(true);
    try {
      const { data: { session } } = await api.auth.getSession();
      const token = session?.access_token;

      const res = await fetch('/api/rpc/create_gomosub', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          slug,
          name: form.name.trim(),
          description: form.description.trim(),
          visibility,
          rules_markdown: visibility === "private" ? null : buildRulesMarkdown(),
          cover_image_url: coverImages[0] ?? null,
          gomosub_avatar_url: avatarImages[0] ?? null,
          gomosub_tags: [],
        }),
      });

      const data = await res.json();

      if (!res.ok || data.success === false) {
        const err = new Error(data.error || `HTTP ${res.status}`) as Error & {
          code?: string;
          params?: unknown;
        };
        err.code = data.code;
        err.params = data.params;
        throw err;
      }

      toast.success("G-саб создан");
      // Raw RPC write bypasses query-builder — drop boards GET cache.
      invalidateByPrefix('/api/v1/boards');
      navigate(`/g/${slug}`);
    } catch (error) {
      toast.error(apiErrorMessage(error, t, "error.generic"));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto w-full px-3 sm:px-5 pb-32 md:pb-10">
      {step === "requirements" && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
          className="space-y-4 pt-2"
        >
          <Card className="overflow-hidden rounded-2xl border-border/70 bg-surface">
            <div className="relative h-20 bg-gradient-to-br from-primary/20 via-primary/10 to-muted">
              <span aria-hidden className="absolute -bottom-5 left-5 select-none text-5xl font-black uppercase leading-none tracking-tight text-primary/25">
                g
              </span>
            </div>
            <div className="px-5 pb-5 pt-3">
              <h1 className="text-xl font-bold tracking-tight">Своя тематическая зона</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                g-саб — отдельное сообщество под твой фандом, игру или тему: свои каналы, свои правила, свои теги.
              </p>

              <div className="mt-4 space-y-2">
                {[
                  { ok: garmaOk, done: "10+ gармы", note: `Текущая gарма: ${garma}` },
                  { ok: ageOk, done: "Аккаунт старше 2 недель", note: profileCreatedAt ? `Создан: ${new Date(profileCreatedAt).toLocaleDateString()}` : "Нет данных" },
                ].map((req) => (
                  <div
                    key={req.done}
                    className={cn(
                      "flex items-center gap-3 rounded-xl border px-3.5 py-2.5 transition-colors",
                      req.ok ? "border-emerald-500/30 bg-emerald-500/[0.06]" : "border-border/60 bg-surface",
                    )}
                  >
                    {req.ok ? (
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-500/15">
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                      </span>
                    ) : (
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted">
                        <XCircle className="h-3.5 w-3.5 text-muted-foreground" />
                      </span>
                    )}
                    <div className="min-w-0">
                      <div className="text-sm font-medium leading-tight">{req.done}</div>
                      <div className="text-xs text-muted-foreground">{req.note}</div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:items-center">
                <Button
                  onClick={() => setStep("form")}
                  disabled={!canProceed}
                  className="h-10 flex-1 rounded-full"
                >
                  {canProceed ? "Поехали" : "Правила пока не прочитаны"}
                </Button>
                <Button
                  variant="outline"
                  className="h-10 shrink-0 rounded-full"
                  onClick={() => setShowGuide(true)}
                >
                  Прочитать правила
                </Button>
              </div>
              <div className="mt-3 text-center text-xs text-muted-foreground">
                Или{" "}
                <button type="button" onClick={() => setShowImportDialog(true)} className="text-primary hover:underline inline-flex items-center gap-1">
                  <Upload className="h-3 w-3" />
                  импортировать саб из архива
                </button>
              </div>
            </div>
          </Card>
        </motion.div>
      )}

      {step === "form" && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
          className="space-y-4 pt-2"
        >
          <Card className="overflow-hidden rounded-2xl border-border/70 bg-surface">
            {/* фон + аватар */}
            <div className="h-24 sm:h-28 border-b border-border relative">
              <input
                ref={coverInputRef}
                type="file"
                accept="image/jpeg,image/jpg,image/png,image/webp,image/gif"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) uploadSingleImage(file, "cover");
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                onClick={() => coverInputRef.current?.click()}
                className="group relative w-full h-full text-left"
              >
                {coverImages[0] ? (
                  <img src={storageUrl("post-images", coverImages[0]) ?? undefined} alt="cover" className="w-full h-full object-cover" />
                ) : (
                  <div className="relative flex h-full w-full items-center justify-center gap-2 bg-gradient-to-br from-primary/20 via-primary/10 to-muted text-sm text-muted-foreground">
                    <Upload className="h-4 w-4" />
                    {uploadingCover ? "Загружаем…" : "Загрузить фон"}
                  </div>
                )}
                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors" />
              </button>
              <div className="absolute -bottom-7 left-4 h-14 w-14 sm:h-16 sm:w-16 overflow-hidden rounded-2xl border-[3px] border-background bg-muted shadow-md">
                <input
                  ref={avatarInputRef}
                  type="file"
                  accept="image/jpeg,image/jpg,image/png,image/webp,image/gif"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) uploadSingleImage(file, "avatar");
                    e.target.value = "";
                  }}
                />
                <button type="button" onClick={() => avatarInputRef.current?.click()} className="group relative h-full w-full">
                  {avatarImages[0] ? (
                    <img src={storageUrl("post-images", avatarImages[0]) ?? undefined} alt="avatar" className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-primary/30 to-muted text-lg font-bold text-primary">
                      {uploadingAvatar ? "…" : (form.name.trim()[0] || "g").toUpperCase()}
                    </div>
                  )}
                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors" />
                </button>
              </div>
            </div>

            <div className="space-y-5 px-5 pb-5 pt-11">
              {/* Название */}
              <div className="space-y-1.5">
                <div className="flex items-baseline justify-between">
                  <label htmlFor="gs-name" className="text-sm font-medium">Название</label>
                  <span className={cn("text-[10px]", form.name.length ? "text-muted-foreground" : "text-muted-foreground/40")}>
                    {form.name.length}/80
                  </span>
                </div>
                <Input id="gs-name" value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} maxLength={80} />
              </div>

              {/* Слаг */}
              <div className="space-y-1.5">
                <div className="flex items-baseline justify-between">
                  <label htmlFor="gs-slug" className="text-sm font-medium">Адрес</label>
                  <span className={cn("inline-flex items-center gap-1 text-[10px]", slugOk() ? "text-emerald-600" : "text-muted-foreground/50")}>
                    {slugOk() ? (
                      <>
                        <CheckCircle2 className="h-3 w-3" /> свободен для набора
                      </>
                    ) : (
                      "латиница, цифры, - или _"
                    )}
                  </span>
                </div>
                <div className="relative">
                  <span aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 select-none text-sm font-semibold text-muted-foreground/60">
                    g/
                  </span>
                  <Input
                    id="gs-slug"
                    value={form.slug}
                    onChange={(e) => setForm((p) => ({ ...p, slug: e.target.value.toLowerCase().replace(/\s+/g, "-") }))}
                    placeholder="my-fandom"
                    maxLength={25}
                    className="pl-8"
                  />
                </div>
              </div>

              {/* Описание */}
              <div className="space-y-1.5">
                <div className="flex items-baseline justify-between">
                  <label htmlFor="gs-desc" className="text-sm font-medium">Описание</label>
                  <span className={cn("text-[10px]", form.description.length ? "text-muted-foreground" : "text-muted-foreground/40")}>
                    {form.description.length}/240
                  </span>
                </div>
                <Textarea id="gs-desc" value={form.description} onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))} rows={3} maxLength={240} />
              </div>

              {/* Тип саба */}
              <div className="grid gap-2 sm:grid-cols-2">
                {([
                  { value: "public", label: "Публичный", note: "Виден всем на /g, любой может вступить" },
                  { value: "private", label: "Приватный", note: "Только по приглашениям, без правил" },
                ] as const).map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setVisibility(opt.value)}
                    className={cn(
                      "rounded-xl border p-3 text-left transition-colors",
                      visibility === opt.value
                        ? "border-primary/50 bg-primary/[0.06]"
                        : "border-border/60 bg-surface hover:bg-muted/40",
                    )}
                  >
                    <div className="flex items-center gap-1.5 text-sm font-medium">
                      {opt.value === "public" ? <Globe className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5 text-amber-500" />}
                      {opt.label}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">{opt.note}</div>
                  </button>
                ))}
              </div>

              {/* Правила — только публичным */}
              {visibility === "public" && (
                <div className="space-y-3 rounded-xl border border-border/60 bg-surface p-4">
                  <div className="space-y-1.5">
                    <label htmlFor="gs-rules" className="text-sm font-medium">Главное правило</label>
                    <Textarea
                      id="gs-rules"
                      value={form.standardRules}
                      onChange={(e) => setForm((p) => ({ ...p, standardRules: e.target.value }))}
                      rows={2}
                      placeholder="Уважай участников, соблюдай тему саба…"
                    />
                  </div>

                  {([
                    { kind: "allowed" as const, label: "Можно", tilde: <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />, items: allowedRules, set: setAllowedRules, placeholder: "что в сабе приветствуется" },
                    { kind: "forbidden" as const, label: "Нельзя", tilde: <XCircle className="h-3.5 w-3.5 text-destructive" />, items: forbiddenRules, set: setForbiddenRules, placeholder: "с чего начинается бан" },
                  ]).map((col) => (
                    <div key={col.kind} className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="inline-flex items-center gap-1.5 text-sm font-medium">
                          {col.tilde}
                          {col.label}
                        </span>
                        {col.items.length > 1 && (
                          <button
                            type="button"
                            onClick={() => col.set(col.items.slice(0, -1).length ? col.items.slice(0, -1) : [""])}
                            title="Убрать последнее"
                            aria-label={`Убрать последнее правило из «${col.label}»`}
                            className="flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground"
                          >
                            <MinusIcon className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                      {col.items.map((rule, index) => (
                        <Input
                          key={`${col.kind}-${index}`}
                          value={rule}
                          onChange={(e) => col.set(col.items.map((item, i) => (i === index ? e.target.value : item)))}
                          placeholder={col.placeholder}
                        />
                      ))}
                    </div>
                  ))}
                </div>
              )}

              {visibility === "private" && (
                <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.05] px-4 py-3">
                  <p className="text-xs text-muted-foreground">
                    Приватный саб не виден в общем списке. Пригласительные ссылки создашь в настройках после создания — и разошлёшь их тем, кому открыто.
                  </p>
                </div>
              )}

              <div className="flex items-center justify-between gap-2 pt-1">
                <Button variant="outline" className="h-10 rounded-full" onClick={() => setStep("requirements")}>
                  Назад
                </Button>
                <Button onClick={handleCreate} disabled={creating} className="h-10 min-w-44 rounded-full">
                  {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : "Создать саб"}
                </Button>
              </div>
            </div>
          </Card>
        </motion.div>
      )}

      <Dialog open={showGuide} onOpenChange={setShowGuide}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Что такое g-саб</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>g-саб напоминает доску и запись одновременно, но создается для крупного фандома или обсуждения конкретной темы.</p>
            <p>Если тебе нужна отдельная тематическая зона с собственными правилами и тегами - g-саб это нужный формат.</p>
            <Badge variant={guideRead ? "default" : "outline"} className="cursor-pointer" onClick={() => setGuideRead((prev) => !prev)}>
              {guideRead ? "Прочитано" : "Отметить как прочитано"}
            </Badge>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={showImportDialog} onOpenChange={setShowImportDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Импорт g-sub из архива</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Загрузите tar.gz архив, экспортированный из другого g-саба. Будет создана новая копия с вашим аккаунтом владельцем.
            </p>
            <div
              className="border-2 border-dashed rounded-lg p-8 text-center cursor-pointer hover:border-primary/50 transition-colors"
              onClick={() => {
                const input = document.createElement("input");
                input.type = "file";
                input.accept = ".tar.gz,.tgz";
                input.onchange = (e) => {
                  const file = (e.target as HTMLInputElement).files?.[0];
                  if (file) handleImportFileSelect(file);
                };
                input.click();
              }}
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
              onDrop={(e) => {
                e.preventDefault();
                const file = e.dataTransfer.files[0];
                if (file) handleImportFileSelect(file);
              }}
            >
              {importLoading ? (
                <Loader2 className="w-8 h-8 mx-auto animate-spin text-muted-foreground" />
              ) : importFile ? (
                <div className="space-y-2">
                  <Upload className="w-8 h-8 mx-auto text-primary" />
                  <p className="text-sm font-medium">{importFile.name}</p>
                  <p className="text-xs text-muted-foreground">{(importFile.size / 1024 / 1024).toFixed(1)} MB</p>
                </div>
              ) : (
                <div className="space-y-2">
                  <Upload className="w-8 h-8 mx-auto text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">Нажмите или перетащите .tar.gz файл</p>
                </div>
              )}
            </div>

            {importInfo && (
              <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-2">
                <div className="font-medium text-sm">{String(importInfo.board_name || importInfo.board_slug)}</div>
                <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                  <div>Записей: <span className="text-foreground">{String(importInfo.thread_count)}</span></div>
                  <div>Постов: <span className="text-foreground">{String(importInfo.post_count)}</span></div>
                  <div>Участников: <span className="text-foreground">{String(importInfo.member_count)}</span></div>
                  <div>Каналов: <span className="text-foreground">{String(importInfo.channel_count)}</span></div>
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => { setShowImportDialog(false); setImportFile(null); setImportInfo(null); }}>
                Отмена
              </Button>
              <Button onClick={handleImport} disabled={!importFile || !importInfo || importing}>
                {importing && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                Импортировать
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default GomoSubCreate;
