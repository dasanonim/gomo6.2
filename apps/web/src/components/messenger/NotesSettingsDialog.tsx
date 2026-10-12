import { useCallback, useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { exportNotesKey, hasNotesKey, importNotesKey, NOTES_LOCKED } from "@/utils/notesCrypto";
import { useMessengerStore } from "@/stores/messengerStore";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Active notes conversation id — messages are reloaded after key restore. */
  conversationId?: string;
}

/**
 * Notes key panel. Two states, each a short blurb plus one control:
 *  - key present  → what the key is, and a «Скопировать ключ» button (copies
 *    to the clipboard without revealing it on screen);
 *  - no key       → what it is and where to get it, plus a paste field.
 */
export function NotesSettingsDialog({ open, onOpenChange, conversationId }: Props) {
  const [hasKey, setHasKey] = useState(false);
  const [copied, setCopied] = useState(false);
  const [importValue, setImportValue] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [importWarn, setImportWarn] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCopied(false);
    setImportError(null);
    setImportWarn(null);
    setRestored(false);
    setImportValue("");
    setHasKey(hasNotesKey());
  }, [open]);

  const handleCopy = useCallback(async () => {
    const key = await exportNotesKey();
    if (!key) return;
    try {
      await navigator.clipboard.writeText(key);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable — nothing to reveal, so just stay silent.
    }
  }, []);

  const handleImport = useCallback(async () => {
    if (!importValue.trim()) return;
    const ok = await importNotesKey(importValue);
    if (!ok) {
      setImportError("Неверный ключ");
      return;
    }
    setImportError(null);
    setImportWarn(null);
    setImportValue("");
    setRestored(true);
    setHasKey(hasNotesKey());
    // Reload messages + previews so the restored key takes effect immediately.
    const store = useMessengerStore.getState();
    if (conversationId) {
      try {
        await store.loadMessages(conversationId);
      } catch {
        // The chat's error banner covers network failures.
      }
    }
    void store.loadConversations();
    const locked = store.messages.filter((m) => m.content === NOTES_LOCKED).length;
    setImportWarn(locked > 0 ? `${locked} заметок не открылись — записаны другим ключом` : null);
    window.setTimeout(() => setRestored(false), 3000);
  }, [importValue, conversationId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="notes-settings-dialog max-w-sm" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Заметки</DialogTitle>
        </DialogHeader>

        <div className="notes-settings-body">
          {hasKey ? (
            <>
              <p className="notes-settings-text">
                Заметки шифруются на устройстве — ключ хранится только здесь и не отправляется
                на сервер. Скопируй и сохрани его: без копии заметки не восстановить.
              </p>
              {importWarn && <div className="notes-settings-import-warn">{importWarn}</div>}
              {restored && <div className="notes-settings-restored">Ключ сохранён</div>}
              <button type="button" className="notes-settings-action" onClick={handleCopy}>
                {copied ? "Скопировано" : "Скопировать ключ"}
              </button>
            </>
          ) : (
            <>
              <p className="notes-settings-text">
                Заметки шифруются на устройстве. Вставь ключ, сохранённый ранее на другом
                устройстве, чтобы прочитать их здесь.
              </p>
              <div className="notes-settings-import">
                <input
                  type="text"
                  value={importValue}
                  onChange={(e) => setImportValue(e.target.value)}
                  placeholder="Вставь ключ"
                  spellCheck={false}
                  enterKeyHint="done"
                  aria-label="Ключ шифрования заметок"
                />
                <button type="button" onClick={handleImport} disabled={!importValue.trim()}>
                  ОК
                </button>
              </div>
              {importError && <div className="notes-settings-import-error">{importError}</div>}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
