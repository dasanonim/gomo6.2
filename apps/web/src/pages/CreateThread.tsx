// Global topic composer. Replaces the old forum-board CreateThread: a topic
// now belongs to a раздел (and, optionally, one of its подразделы) instead of
// a board. The composer is a portal sheet over the content underneath — the
// feed/board stays mounted when opened as an overlay (backgroundLocation,
// same as wall posts), so creating never swaps the page out from under you:
//
//   1. Open → the composer sheet is up straight away, unplaced unless
//      ?section=&sub= already chose.
//   2. Pick a section in the dialog; if it has subsections they expand inline,
//      picking one is optional. Until a section is chosen the header offers
//      «Выбрать раздел» and publishing stays disabled.
//   3. Title + body editor (the shared RichComposer).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "@/integrations/api/compat";
import { invalidateByPrefix } from "@/integrations/api/queryCache";
import { toast } from "sonner";
import { ChevronDown, Plus } from "lucide-react";
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

  // The picker never opens by itself: the composer is the first thing the
  // user sees, and the placement is chosen on demand through the header pill.

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

  // The placement pill is the single entry point: unchosen it invites
  // («Выбрать раздел»), chosen it shows the placement — tapping either opens
  // the picker. No separate «Сменить» button.
  const placementPill = (
    <button
      type="button"
      onClick={() => setPickerOpen(true)}
      title={section ? "Сменить раздел" : "Выбрать раздел"}
      className={`inline-flex max-w-full items-center justify-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold transition-colors ${
        section
          ? "border-border/60 bg-foreground/[0.04] hover:bg-foreground/[0.08]"
          : "border-primary/30 bg-primary/10 text-primary hover:bg-primary/15"
      }`}
    >
      {section ? (
        <>
          <SectionIcon name={section.icon} className="h-3.5 w-3.5 shrink-0 text-primary" />
          <span className="truncate">{placementLabel}</span>
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        </>
      ) : (
        <>
          <Plus className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">Выбрать раздел</span>
        </>
      )}
    </button>
  );

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
  // picked on demand through the header pill, which opens the dialog.
  return (
    <>
      <RichComposer
        bucket="content"
        testId="topic-composer"
        headerLabel={placementPill}
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
