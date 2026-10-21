import { motion, useReducedMotion } from "motion/react";
import { Bookmark } from "lucide-react";

import { favoriteKey, useFavoritesStore, type FavoriteItemType } from "@/stores/favoritesStore";
import { syncFavoriteNote } from "@/utils/favoriteNotes";
import { pressFeedback, springFor } from "@/lib/motion";

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
  const reduceMotion = useReducedMotion();

  return (
    <motion.button
      type="button"
      aria-label={isFavorited ? "Убрать из избранного" : "В избранное"}
      aria-pressed={isFavorited}
      title={isFavorited ? "Убрать из избранного" : "В избранное"}
      {...pressFeedback(reduceMotion, 0.9)}
      transition={springFor("snappy", reduceMotion)}
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
      {/* Saved → the bookmark snaps in with a tiny rotation; unsaved → rest. */}
      <motion.span
        key={isFavorited ? "saved" : "rest"}
        initial={isFavorited && !reduceMotion ? { scale: 0.4, rotate: -14 } : false}
        animate={{ scale: 1, rotate: 0 }}
        transition={springFor("bouncy", reduceMotion)}
        className="inline-flex"
      >
        <Bookmark className={`h-4 w-4 ${isFavorited ? "fill-current" : ""}`} />
      </motion.span>
    </motion.button>
  );
};
