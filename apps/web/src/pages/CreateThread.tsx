// Global topic composer. Replaces the old forum-board CreateThread: a topic
// now belongs to a раздел (and, optionally, one of its подразделы) instead of
// a board. The composer is a portal sheet over the content underneath — the
// feed/board stays mounted when opened as an overlay (backgroundLocation,
// same as wall posts), so creating never swaps the page out from under you:
//
//   1. Open → the section dialog appears over the sheet (unless ?section=&sub=
//      already placed it, then the editor is up straight away).
//   2. Pick a раздел; if it has подразделы they slide in, picking one is
//      optional. Until a раздел is chosen the header offers «Выбрать раздел»
//      and publishing stays disabled.
//   3. Title + body editor (the shared RichComposer).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "@/integrations/api/compat";
import { invalidateByPrefix } from "@/integrations/api/queryCache";
import { toast } from "sonner";
import { ChevronDown } from "lucide-react";
import type { AttachmentMeta } from "@/utils/mediaUpload";
import { RichComposer, type RichComposerPayload } from "@/components/composer/RichComposer";
import { SectionPicker } from "@/components/topic/SectionPicker";
import { SectionIcon } from "@/components/topic/sectionIcons";
import { useThreadSections, type ThreadSection, type ThreadSubsection } from "@/hooks/useThreadSections";
import { Input } from "@/components/ui/input";
import { entityParam } from "@/utils/entityUrl";

const DRAFT_PREFIX = "gomo6:topic-draft:";

interface TopicDraft {
  title: string;
  contentJson: unknown;
  attachments: AttachmentMeta[];
}

const CreateThread = () => {
  const navigate = useNavigate();
  const { sections, loading } = useThreadSections();
  const [searchParams] = useSearchParams();
  // «Создать тему» clicked inside a раздел passes it in the URL (?section=&sub=)
  // so the editor opens straight away with the right placement — no picker.
  const presetSectionSlug = searchParams.get("section");
  const presetSubSlug = searchParams.get("sub");
  const presetAppliedRef = useRef(false);

  const [section, setSection] = useState<ThreadSection | null>(null);
  const [subsection, setSubsection] = useState<ThreadSubsection | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [contentJson, setContentJson] = useState<unknown>(null);
  const [restored, setRestored] = useState<TopicDraft | null>(null);

  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftKey = DRAFT_PREFIX + "new";

  // Apply the раздел/подраздел from the URL once the catalog is loaded.
  useEffect(() => {
    if (presetAppliedRef.current || loading || !presetSectionSlug) return;
    const match = sections.find((s) => s.slug === presetSectionSlug);
    if (!match) return;
    presetAppliedRef.current = true;
    setSection(match);
    if (presetSubSlug) {
      const sub = match.subsections.find((ss) => ss.slug === presetSubSlug);
      if (sub) setSubsection(sub);
    }
  }, [loading, sections, presetSectionSlug, presetSubSlug]);

  // The panel is the first thing the user sees on the create page — unless a
  // раздел was already picked from the URL, in which case the editor opens.
  useEffect(() => {
    if (loading || section) return;
    if (presetSectionSlug && sections.some((s) => s.slug === presetSectionSlug)) return;
    setPickerOpen(true);
  }, [loading, section, presetSectionSlug, sections]);

  // Restore the autosaved draft (title + body).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(draftKey);
      if (!raw) return;
      const draft = JSON.parse(raw) as TopicDraft;
      if (draft?.title || draft?.contentJson) {
        setTitle(draft.title || "");
        setContentJson(draft.contentJson ?? null);
        setRestored({ title: draft.title || "", contentJson: draft.contentJson ?? null, attachments: [] });
      }
    } catch {
      // Corrupt draft — ignore.
    }
  }, [draftKey]);

  // Autosave (debounced).
  useEffect(() => {
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(() => {
      try {
        localStorage.setItem(draftKey, JSON.stringify({ title, contentJson, attachments: [] } satisfies TopicDraft));
      } catch {
        // Storage full — publishing still works.
      }
    }, 350);
    return () => {
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    };
  }, [title, contentJson, draftKey]);

  const placementLabel = useMemo(() => {
    if (!section) return "";
    return subsection ? `${section.name} · ${subsection.name}` : section.name;
  }, [section, subsection]);

  // Closing returns to whatever is underneath: the background page in overlay
  // mode, or the previous entry for a direct visit. A bookmarked /create has
  // no history to go back to — fall back to the feed instead of a dead X.
  const handleClose = useCallback(() => {
    if (typeof window !== "undefined" && window.history.length > 1) {
      navigate(-1);
    } else {
      navigate("/feed", { replace: true });
    }
  }, [navigate]);

  const handlePublish = useCallback(
    async ({ json, text, attachments }: RichComposerPayload) => {
      if (!section) {
        toast.error("Выберите раздел");
        return;
      }
      if (!title.trim()) {
        toast.error("Введите заголовок темы");
        return;
      }
      // The body may be media-only — only the title is mandatory.
      if (!text.trim() && attachments.length === 0) {
        toast.error("Добавьте текст или медиафайл");
        return;
      }

      const imageAttachments = attachments.filter((att) => att.type === "image");
      const payload: Record<string, unknown> = {
        section_id: section.id,
        title: title.trim(),
        content: text.trim(),
        content_json: json,
        image_urls: imageAttachments.map((a) => a.url),
        attachments: attachments.length ? attachments : null,
      };
      if (subsection) payload.subsection_id = subsection.id;

      const session = await api.auth.getSession();
      const token = session.data.session?.access_token;
      if (!token) {
        toast.error("Нужно войти в аккаунт");
        navigate("/auth");
        return;
      }

      try {
        const response = await fetch("/api/rpc/create_thread", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          const errData = await response.json().catch(() => ({}));
          toast.error(errData.error || "Ошибка при создании темы");
          return;
        }

        const responseData = await response.json();
        const threadData = responseData.data || responseData;
        if (!threadData?.id) {
          toast.error("Не удалось получить ID темы");
          return;
        }

        toast.success("Тема создана");
        try {
          localStorage.removeItem(draftKey);
        } catch {
          // ignore
        }
        invalidateByPrefix("/api/v1/threads");
        invalidateByPrefix("/api/v1/feed");
        navigate(`/thread/${entityParam(threadData)}`, { replace: true });
      } catch (err) {
        console.error("CreateThread error:", err);
        toast.error("Ошибка при создании темы");
      }
    },
    [navigate, section, subsection, title, draftKey],
  );

  // The composer is always the page: it is a portal sheet over the content
  // underneath (the feed/board when opened as an overlay, the layout when
  // visited directly). There is no bare intermediate screen — placement is
  // picked in the dialog, which opens by itself until a раздел is chosen.
  return (
    <>
      <RichComposer
        bucket="content"
        testId="topic-composer"
        headerLabel={
          section ? (
            <span className="inline-flex items-center justify-center gap-1.5">
              <SectionIcon name={section.icon} className="h-4 w-4" />
              {placementLabel}
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="inline-flex items-center justify-center gap-1 rounded-full border border-dashed border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            >
              Выбрать раздел
              <ChevronDown className="h-3 w-3" />
            </button>
          )
        }
        headerRight={
          section ? (
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="inline-flex items-center gap-1 rounded-full border border-border/60 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
              title="Сменить раздел"
            >
              Сменить
              <ChevronDown className="h-3 w-3" />
            </button>
          ) : undefined
        }
        placeholder="Текст темы…"
        escapeDisabled={pickerOpen}
        initialContentJson={restored?.contentJson ?? contentJson}
        publishDisabled={!title.trim() || !section}
        onChange={({ json }) => setContentJson(json)}
        onPublish={handlePublish}
        onClose={handleClose}
      >
        <div className="px-4 pt-2.5 shrink-0">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            placeholder="Заголовок темы"
            autoFocus
            className="border-0 bg-transparent px-0 text-lg sm:text-xl font-semibold focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:border-0 shadow-none"
          />
          {title.length > 0 && (
            <div className={`text-right text-[11px] pr-1 -mt-0.5 ${title.length > 190 ? "text-destructive" : "text-muted-foreground"}`}>
              {title.length}/200
            </div>
          )}
        </div>
      </RichComposer>

      <SectionPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        sections={sections}
        loading={loading}
        currentSectionId={section?.id}
        currentSubsectionId={subsection?.id}
        onSelect={(s, sub) => {
          setSection(s);
          setSubsection(sub);
        }}
      />
    </>
  );
};

export default CreateThread;
