import { useEffect, useMemo, useRef } from "react";
import { wsService, type WebSocketMessage } from "@/services/websocket";
import { useStoriesStore } from "@/stores/storiesStore";

/** Room name of a story owner (must match websocket.StoriesRoom on the server). */
export function storiesRoom(ownerType: "user" | "gosub", ownerId: string): string {
  return ownerType === "gosub" ? `stories_board_${ownerId}` : `stories_user_${ownerId}`;
}

const STORY_EVENTS = [
  "new_story",
  "story_updated",
  "story_deleted",
  "story_viewed",
  "story_reaction",
] as const;

/**
 * Subscribes the rail to the owners it currently shows, plus the viewer's own
 * counters room, and refreshes the rail when the tab becomes visible again.
 *
 * Rooms (and not a global broadcast) are deliberate: the server only accepts a
 * subscription when the profile / board is visible to this user, so a private
 * story's existence never reaches someone outside its audience.
 */
export function useStoriesRealtime(userId: string | undefined): void {
  const rail = useStoriesStore((state) => state.rail);
  const loadRail = useStoriesStore((state) => state.loadRail);
  const applyRealtimeEvent = useStoriesStore((state) => state.applyRealtimeEvent);
  const roomsKey = useMemo(
    () =>
      rail
        .map((group) => storiesRoom(group.owner.type, group.owner.id))
        .concat(userId ? [`stories_owner_${userId}`] : [])
        .sort()
        .join("|"),
    [rail, userId],
  );
  const lastRefreshRef = useRef(0);

  useEffect(() => {
    if (!userId) return;
    const rooms = roomsKey ? roomsKey.split("|") : [];
    rooms.forEach((room) => wsService.subscribe(room));
    const offs = STORY_EVENTS.map((type) =>
      wsService.on(type, (message: WebSocketMessage) => {
        applyRealtimeEvent(type, (message.data ?? {}) as Record<string, unknown>);
      }),
    );
    return () => {
      offs.forEach((off) => off());
      rooms.forEach((room) => wsService.unsubscribe(room));
    };
  }, [userId, roomsKey, applyRealtimeEvent]);

  // A follow made in another tab, or a story published while this tab was in
  // the background, has no room to arrive through yet — one throttled refetch
  // on focus keeps the rail honest without polling on a timer.
  useEffect(() => {
    if (!userId) return;
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      if (now - lastRefreshRef.current < 30_000) return;
      lastRefreshRef.current = now;
      void loadRail(true).catch(() => undefined);
    };
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [userId, loadRail]);
}
