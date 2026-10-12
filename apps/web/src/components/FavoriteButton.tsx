import { Bookmark } from "lucide-react";

import { favoriteKey, useFavoritesStore, type FavoriteItemType } from "@/stores/favoritesStore";
import { syncFavoriteNote } from "@/utils/favoriteNotes";

interface FavoriteButtonProps {
  itemType: FavoriteItemType;
  itemId: string;
}

/**
 * Floating bookmark shown in a card's bottom-right corner on hover. Filled when
 * the item is favorited; clicking toggles it (optimistically, via the store).
 */
export const FavoriteButton = ({ itemType, itemId }: FavoriteButtonProps) => {
  const isFavorited = useFavoritesStore((state) => state.ids.has(favoriteKey(itemType, itemId)));
  const toggle = useFavoritesStore((state) => state.toggle);

  return (
    <button
      type="button"
      aria-label={isFavorited ? "Убрать из избранного" : "В избранное"}
      aria-pressed={isFavorited}
      title={isFavorited ? "Убрать из избранного" : "В избранное"}
      onClick={(event) => {
        event.stopPropagation();
        const wasFavorited = isFavorited;
        void toggle(itemType, itemId).then((nowFavorited) => {
          // A failed toggle rolls back to the pre-click state; skip note churn
          // so a failed add never deletes a note and a failed remove never
          // re-creates one (issue #509).
          if (nowFavorited === wasFavorited) return;
          void syncFavoriteNote({ itemType, itemId, nowFavorited });
        });
      }}
      className={`grid h-8 w-8 place-items-center transition-colors ${
        isFavorited ? "text-primary" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      <Bookmark className={`h-4 w-4 transition-transform duration-150 ${isFavorited ? "fill-current" : ""}`} />
    </button>
  );
};
