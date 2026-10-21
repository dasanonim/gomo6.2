import { useEffect, useState } from "react";
import { useStoriesStore } from "@/stores/storiesStore";
import { ownerKey, type Story, type StoryOwnerType } from "@/types/stories";

const EMPTY: Story[] = [];

/**
 * Live stories of one owner, kept in the stories store so the ring, the viewer
 * and the rail all read the same list (marking a slide viewed updates the ring
 * everywhere at once).
 */
export function useOwnerStories(
  ownerType: StoryOwnerType,
  ownerId: string | null | undefined,
  options: { load?: boolean } = {},
): { stories: Story[]; loading: boolean } {
  const load = options.load ?? true;
  const stories = useStoriesStore((state) =>
    ownerId ? (state.byOwner[ownerKey(ownerType, ownerId)] ?? EMPTY) : EMPTY,
  );
  const loadUserStories = useStoriesStore((state) => state.loadUserStories);
  const loadBoardStories = useStoriesStore((state) => state.loadBoardStories);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!load || !ownerId) return;
    let cancelled = false;
    setLoading(true);
    const request =
      ownerType === "gosub" ? loadBoardStories(ownerId) : loadUserStories(ownerId);
    void request
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ownerType, ownerId, load, loadUserStories, loadBoardStories]);

  return { stories, loading };
}
