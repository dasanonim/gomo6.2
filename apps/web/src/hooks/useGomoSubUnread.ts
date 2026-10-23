import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/integrations/api/compat";
import type { ChannelRow } from "@/routes/data/boardData";

/** Timestamp server activity per channel → sidebar unread dots. */
type ChannelActivity = { channel_id: string; last_activity_at: string };

export const seenKey = (userId: string, channelId: string) =>
  `gomosub-seen:${userId}:${channelId}`;

const readSeenStamp = (userId: string, channelId: string): string | null => {
  try {
    return localStorage.getItem(seenKey(userId, channelId));
  } catch {
    return null; // storage unavailable — no dot, no crash
  }
};

/**
 * Unread state for the workspace sidebar. The server reports the last activity
 * of every readable channel (messages + threads); a row is unread while that
 * timestamp is newer than the viewer's last-seen record — and no record at all
 * means the channel was never opened. Board calls `markSeen(activeChannelId)`
 * when the viewer opens a channel; any error just hides the dot.
 */
export const useGomoSubUnread = (
  userId: string | null,
  boardId: string | null,
  channels: ChannelRow[],
): { unread: Set<string>; markSeen: (channelId: string | null) => void } => {
  const [lastActivity, setLastActivity] = useState<Map<string, string> | null>(null);
  const [seenVersion, setSeenVersion] = useState(0);

  useEffect(() => {
    if (!userId || !boardId || channels.length === 0) {
      setLastActivity(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const { data: { session } } = await api.auth.getSession();
        if (!session?.access_token) return;
        const res = await fetch(
          `/api/rpc/get_gomosub_channel_activity?_board_id=${encodeURIComponent(boardId)}`,
          { headers: { Authorization: `Bearer ${session.access_token}` } },
        );
        if (!res.ok) return;
        const json = await res.json();
        if (cancelled) return;
        const map = new Map<string, string>();
        for (const item of (json.data as ChannelActivity[]) ?? []) {
          map.set(item.channel_id, item.last_activity_at);
        }
        setLastActivity(map);
      } catch { /* dots are cosmetic — stay silent */ }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [userId, boardId, channels.length]);

  const unread = useMemo(() => {
    const set = new Set<string>();
    if (!lastActivity) return set;
    for (const [channelId, at] of lastActivity) {
      const lastSeen = userId ? readSeenStamp(userId, channelId) : null;
      if (!lastSeen || Date.parse(at) > Date.parse(lastSeen)) {
        set.add(channelId);
      }
    }
    return set; // seenVersion forces a re-check after markSeen
  }, [lastActivity, userId, seenVersion]);

  const markSeen = useCallback(
    (channelId: string | null) => {
      if (!userId || !channelId) return;
      try {
        localStorage.setItem(seenKey(userId, channelId), new Date().toISOString());
      } catch { /* storage unavailable */ }
      setSeenVersion((v) => v + 1);
    },
    [userId],
  );

  return { unread, markSeen };
};
