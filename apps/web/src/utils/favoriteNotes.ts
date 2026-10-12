// ─── Favorite → Notes bridge ────────────────────────────────────────────────
//
// Issue #509: a post or thread added to «Избранное» is mirrored as a note in the
// personal «Заметки» self-chat, filed under the «Избранное» folder with a
// «пост» / «тема» tag. Removing the favorite removes the note again.
//
// The note body is the existing share token (`__SHARE__:<type>:<id>`), so the
// notes chat renders it through the same X-style ShareCard used by the share
// sheet — a rich preview with cover, author and a text snippet that links back
// to the original. No backend work is needed: notes already carry
// client-side-encrypted content + meta and render share tokens.

import { buildShareToken } from "@/components/share/share";
import { useMessengerStore } from "@/stores/messengerStore";
import type { FavoriteItemType } from "@/stores/favoritesStore";
import type { NotesMeta } from "@/utils/notesCrypto";

/** Folder every auto-created favorite note is filed under. */
export const FAVORITES_NOTE_FOLDER = "Избранное";

/** Tag applied to an auto-created note, by item type. */
const FAVORITES_NOTE_TAG: Record<FavoriteItemType, string> = {
  thread: "тема",
  wall_post: "пост",
};

/** The notes wire content + encrypted meta for a favorited item. */
export interface FavoriteNoteSpec {
  /** Share token the notes chat renders as a rich card. */
  content: string;
  /** Organization meta: the «Избранное» folder + the «тема»/«пост» tag. */
  meta: NotesMeta;
}

/**
 * buildFavoriteNoteSpec maps a favorited item to its note payload. Pure — the
 * share token is deterministic for a given (type, id), so the same item always
 * produces the same note body (used to find/delete the note later).
 */
export function buildFavoriteNoteSpec(itemType: FavoriteItemType, itemId: string): FavoriteNoteSpec {
  return {
    content: buildShareToken({ type: itemType === "thread" ? "thread" : "wall", id: itemId }),
    meta: { folder: FAVORITES_NOTE_FOLDER, tags: [FAVORITES_NOTE_TAG[itemType]] },
  };
}

/**
 * syncFavoriteNote mirrors a favorite change into the notes chat.
 *
 * Best-effort by design (matches favoritesStore's fire-and-forget style): a
 * failure to write or delete the note must never surface as an error to the
 * user or block the favorite toggle, so everything is swallowed here.
 */
export async function syncFavoriteNote(args: {
  itemType: FavoriteItemType;
  itemId: string;
  nowFavorited: boolean;
}): Promise<void> {
  const { content, meta } = buildFavoriteNoteSpec(args.itemType, args.itemId);
  const store = useMessengerStore.getState();
  try {
    if (args.nowFavorited) {
      await store.createFavoriteNote(content, meta);
    } else {
      await store.deleteFavoriteNote(content);
    }
  } catch {
    // Best-effort — the favorite itself already succeeded.
  }
}
