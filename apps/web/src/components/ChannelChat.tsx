import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { apiClient } from "@/integrations/api/client";
import { wsService } from "@/services/websocket";
import { Button } from "@/components/ui/button";
import { ChevronDown, Hash, Loader2, Pencil, SendHorizontal, Trash2, X } from "lucide-react";
import { safeDate } from "@/utils/safeDate";
import { useDateLocale } from "@/i18n/dateLocale";
import { format, formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { hasScrollAnchoring } from "@/lib/scrollAnchoring";
import { animateScroll, isAnimatingScroll } from "./messenger/core/animateScroll";
import { forceMeasure } from "./messenger/core/fasterdom";
import {
  isAtBottom as isScrolledToBottom,
  pinToBottom,
  readContainerScrollTop,
  setScrollTop,
} from "./messenger/core/scrollGeometry";
import {
  MAX_DOM_MESSAGES,
  PRUNE_BATCH,
  TAIL_WINDOW,
  WINDOW_STEP,
  resolveKeyWindow,
  sameKeyWindow,
  tailSlice,
  trimBottom,
  type KeyWindow,
  type MessageSlice,
} from "./messenger/core/slicing";

// Discord-style text channel.
//
// Two deliberate differences from the messenger list:
//
//  1. The chat lives in NORMAL document flow and scrolls with the WINDOW
//     (`document.scrollingElement`), not an inner overflow container. That is
//     the only layout iOS pans natively: focusing the composer (the page's last
//     flow element) makes Safari scroll the whole page up, so the bottom
//     message rides up with everything else — no fixed shell, no translate
//     lift, no --app-vh resizing.
//  2. The mounted window is DOM-sliced exactly like the messenger list
//     (see ./messenger/core/slicing): a keyed window of rows in normal flow,
//     `content-visibility` for the browser's own virtualization, native scroll
//     anchoring, and a single pre-paint compensation where the engine has no
//     anchoring (Safari). Nothing here owns the scroll position.
//
// Deliberately leaner than the messenger: no read receipts, no cross-session
// scroll restore, no pinned messages.

export interface ChannelMessage {
  id: number;
  channel_id: string;
  user_id: string;
  username: string;
  avatar_url?: string | null;
  content: string;
  edited_at?: string | null;
  deleted_at?: string | null;
  created_at: string;
}

const MAX_CONTENT_LENGTH = 4000;

const AT_BOTTOM_SLACK = 12; // px from the bottom still treated as "at bottom"
const TOP_LOAD_ZONE = 300; // px from the top that arms the history loader
const GROUP_WINDOW_MS = 5 * 60 * 1000; // same-author messages within this are compact
const LOAD_THROTTLE_MS = 500; // min gap between history page loads
const SCROLL_SETTLE_MS = 150; // quiet time before the heavy pass (GC)
/** An arrival keeps the follow state pinned for this long (Telegram's freeze). */
const FOLLOWING_FREEZE_MS = 350;
/** A scroll event this soon after our write, reporting its position, is its echo. */
const ECHO_WINDOW_MS = 250;

interface ChannelChatProps {
  channelId: string;
  /** Used for the Discord-style "Написать в #name" composer placeholder and welcome block */
  channelName?: string;
  currentUserId?: string | null;
  /** false renders a join-first notice instead of the composer */
  canPost?: boolean;
  /** board owner / can_delete_threads members may remove other people's messages */
  canDeleteOthers?: boolean;
}

function authHeaders(json = false): Record<string, string> {
  const headers: Record<string, string> = {};
  const token = apiClient.getToken();
  const csrf = apiClient.getCSRFToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (csrf) headers["X-CSRF-Token"] = csrf;
  if (json) headers["Content-Type"] = "application/json";
  return headers;
}

const HISTORY_URL = (channelId: string) =>
  `/api/v1/gomosubchat/channels/${channelId}/messages`;

function isGroupedWith(prev: ChannelMessage | null, m: ChannelMessage): boolean {
  return (
    !!prev &&
    prev.user_id === m.user_id &&
    safeDate(m.created_at).getTime() - safeDate(prev.created_at).getTime() < GROUP_WINDOW_MS
  );
}

/** The window scroll root: the document itself, never an inner container. */
function getScroller(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

const keyOf = (message: ChannelMessage): string => String(message.id);

export function ChannelChat({
  channelId,
  channelName,
  currentUserId,
  canPost = true,
  canDeleteOthers = false,
}: ChannelChatProps) {
  const dateLocale = useDateLocale();
  const [messages, setMessages] = useState<ChannelMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [newMessageCount, setNewMessageCount] = useState(0);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");

  // ── Mounted window (see ./messenger/core/slicing) ────────────────────────
  // `first: null` = the tail window; `last: null` = follow the tail.
  const [win, setWin] = useState<KeyWindow>(TAIL_WINDOW);

  const messagesRef = useRef<ChannelMessage[]>([]);
  messagesRef.current = messages;

  const keyIndex = useMemo(
    () => new Map(messages.map((message, index) => [keyOf(message), index])),
    [messages],
  );
  const keyIndexRef = useRef(keyIndex);
  keyIndexRef.current = keyIndex;

  const resolved = resolveKeyWindow(win, keyIndex, messages.length);
  const windowResolvable = resolved !== null;
  const slice: MessageSlice = resolved ?? tailSlice(messages.length);
  const sliceRef = useRef(slice);
  sliceRef.current = slice;

  // A window whose keys are gone (a full list replacement) falls back to a
  // fresh tail window for this render; re-seed the state so it stops pointing
  // at messages that no longer exist.
  useEffect(() => {
    if (windowResolvable) return;
    setWin((current) => (sameKeyWindow(current, TAIL_WINDOW) ? current : TAIL_WINDOW));
  }, [windowResolvable]);

  // True while pinned to the bottom: appends clamp to the real bottom, and the
  // "N new" pill counts messages only while the user is scrolled up.
  const followingRef = useRef(true);

  // A new channel starts the writer from scratch. This has to be synchronous
  // with the render: a mount effect runs after the first commit, and resetting
  // there would make the first content commit look like a placement again.
  const writerChannelRef = useRef(channelId);
  if (writerChannelRef.current !== channelId) {
    writerChannelRef.current = channelId;
  }

  const listRef = useRef<HTMLDivElement | null>(null);
  const topSentinelRef = useRef<HTMLDivElement | null>(null);
  const bottomSentinelRef = useRef<HTMLDivElement | null>(null);

  const hasMoreRef = useRef(false);
  hasMoreRef.current = hasMore;
  const loadingMoreRef = useRef(false);
  const lastLoadAtRef = useRef(0);
  const prevLastIdRef = useRef<number | null>(null);
  const userDraggingRef = useRef(false);

  // ── Scroll bookkeeping (the same model as the messenger list) ───────────
  /** A pointer is on the list: nothing may move content under it (WebKit). */
  const pointerDownRef = useRef(false);
  /** The position moved and has not been verified at rest yet. */
  const coastingRef = useRef(false);
  /**
   * The last position we wrote ourselves. A scroll event that reports exactly
   * that position right after the write is its echo, not the reader moving
   * (Telegram's `isScrollTopJustUpdated`). Comparing the position keeps a real
   * scroll — which always lands somewhere else — from being swallowed.
   */
  const lastPositionWriteRef = useRef<{ top: number; at: number } | null>(null);
  const bestPositionRef = useRef(0);
  const restTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRafRef = useRef<number | null>(null);
  /** A fetched page waiting for the scroller to come to rest (no anchoring). */
  const pendingOlderRef = useRef<ChannelMessage[] | null>(null);
  /** The anchor of the previous commit: the first row on screen, in viewport px. */
  const prevCommitRef = useRef<{
    clientHeight: number;
    tailId: number | null;
    anchorKey: string | null;
    anchorCoord: number;
  } | null>(null);
  const didInitialPositionRef = useRef(false);
  const pendingBottomGlideRef = useRef(false);
  /** The top sentinel fired during a gesture: expand once the scroller rests. */
  const pendingExpandRef = useRef(false);
  /** An arrival is settling; leaving the follow state in that window flashes the FAB. */
  const followingFreezeUntilRef = useRef(0);

  const timeLabel = useMemo(
    () => (iso: string) => formatDistanceToNow(safeDate(iso), { locale: dateLocale, addSuffix: true }),
    [dateLocale]
  );
  // Discord shows HH:MM in the left gutter when hovering a grouped row.
  const clockTime = useMemo(
    () => (iso: string) => format(safeDate(iso), "HH:mm", { locale: dateLocale }),
    [dateLocale]
  );

  // ── History page (scroll-to-top) ─────────────────────────────────────────
  /**
   * Insert a page above the mounted window. Rows are added ABOVE the viewport,
   * which is the one mutation that has to be compensated to keep the reader's
   * place — native scroll anchoring does it in Chromium/Firefox, the writer's
   * anchor invariant does it where there is none (WebKit).
   */
  const insertOlder = useCallback((fresh: ChannelMessage[]) => {
    if (fresh.length === 0) return;
    const next = [...fresh, ...messagesRef.current];
    messagesRef.current = next;
    setMessages(next);
    setWin((current) => {
      const index = new Map(next.map((message, at) => [keyOf(message), at]));
      const resolvedLast =
        current.last === null ? next.length : (index.get(current.last) ?? next.length - 1) + 1;
      const end = Math.max(1, Math.min(next.length, resolvedLast));
      const trimmed = trimBottom(next, 0, end, keyOf);
      return { first: keyOf(fresh[0]), last: trimmed ? trimmed.last : current.last };
    });
  }, []);

  const loadOlder = useCallback(async () => {
    if (loadingMoreRef.current) return;
    const list = messagesRef.current;
    if (list.length === 0) return;
    const oldest = list[0];

    loadingMoreRef.current = true;
    setLoadingOlder(true);
    try {
      const r = await fetch(
        `${HISTORY_URL(channelId)}?before=${oldest.id}&limit=50`,
        { credentials: "include" }
      );
      const d = await r.json().catch(() => null);
      if (!r.ok || !d?.success) return;
      const older = d.data as ChannelMessage[];
      if (older.length === 0) {
        setHasMore(false);
        return;
      }
      const existing = new Set(messagesRef.current.map((m) => m.id));
      const fresh = older.filter((m) => !existing.has(m.id));
      if (fresh.length === 0) {
        setHasMore(false);
        return;
      }
      if (older.length < 50) setHasMore(false);
      // Where the engine anchors scroll for us, the page can be mounted the
      // moment it arrives (even mid-coast): content above the viewport moves the
      // reader by zero pixels. Without anchoring (WebKit) the compensating write
      // would be dropped under a live gesture, so the page waits in the buffer
      // and the verified-rest pass brings it in.
      pendingOlderRef.current = fresh;
      if (hasScrollAnchoring() || (!coastingRef.current && !pointerDownRef.current)) {
        const page = pendingOlderRef.current;
        pendingOlderRef.current = null;
        insertOlder(page);
      }
    } finally {
      loadingMoreRef.current = false;
      setLoadingOlder(false);
    }
  }, [channelId, insertOlder]);

  const maybeLoadOlder = useCallback(() => {
    const now = Date.now();
    if (
      !hasMoreRef.current ||
      loadingMoreRef.current ||
      userDraggingRef.current ||
      now - lastLoadAtRef.current <= LOAD_THROTTLE_MS
    ) {
      return;
    }
    lastLoadAtRef.current = now;
    void loadOlder();
  }, [loadOlder]);

  // ── Mount: history + room subscription + realtime handlers ──────────────
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setDenied(false);
    setMessages([]);
    setEditingId(null);
    setHasMore(false);
    setWin(TAIL_WINDOW);
    followingRef.current = true;
    setIsAtBottom(true);
    setNewMessageCount(0);

    const room = `channel_${channelId}`;
    wsService.subscribe(room);

    const loadFirstPage = async () => {
      try {
        const r = await fetch(`${HISTORY_URL(channelId)}?limit=50`, { credentials: "include" });
        const d = await r.json().catch(() => null);
        if (cancelled) return;
        if (r.status === 403) {
          setDenied(true);
          return;
        }
        if (!r.ok || !d?.success) throw new Error(d?.error || "Не удалось загрузить историю");
        const page = d.data as ChannelMessage[];
        setMessages(page);
        setHasMore(page.length === 50);
      } catch {
        if (!cancelled) setDenied(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void loadFirstPage();

    // Reconnect: the socket re-subscribes rooms on its own; refetch the tail
    // so messages that arrived during the drop are not silently missing.
    const refetchTail = async () => {
      const list = messagesRef.current;
      if (list.length === 0) return; // initial connect — loadFirstPage owns that
      try {
        const r = await fetch(`${HISTORY_URL(channelId)}?limit=50`, { credentials: "include" });
        const d = await r.json().catch(() => null);
        if (!r.ok || !d?.success) return;
        const latest = d.data as ChannelMessage[];
        setMessages((prev) => {
          const lastId = prev.length > 0 ? prev[prev.length - 1].id : 0;
          const existing = new Set(prev.map((m) => m.id));
          const fresh = latest.filter((m) => !existing.has(m.id) && m.id > lastId);
          return fresh.length > 0 ? [...prev, ...fresh] : prev;
        });
      } catch {
        // Non-fatal: the next page load or reload heals the list.
      }
    };
    const offConnected = wsService.on("connected", () => {
      void refetchTail();
    });

    const offNew = wsService.on("new_channel_message", (m) => {
      const data = m.data as Partial<ChannelMessage> & { id?: number };
      if (!data?.id || data.channel_id !== channelId || data.user_id == null) return;
      // Dedup inside the updater: several events can land in one tick, and
      // this keeps the check race-free against the optimistic REST append.
      setMessages((prev) => {
        if (prev.some((x) => x.id === data.id)) return prev;
        return [...prev, { ...data } as ChannelMessage];
      });
    });

    const offEdited = wsService.on("channel_message_edited", (m) => {
      const data = m.data as Partial<ChannelMessage>;
      if (data?.channel_id !== channelId || typeof data?.id !== "number") return;
      setMessages((prev) =>
        prev.map((x) =>
          x.id === data.id && !x.deleted_at
            ? { ...x, content: data.content ?? x.content, edited_at: data.edited_at ?? new Date().toISOString() }
            : x
        )
      );
    });

    const offDeleted = wsService.on("channel_message_deleted", (m) => {
      const data = m.data as Partial<ChannelMessage>;
      if (data?.channel_id !== channelId || typeof data?.id !== "number") return;
      setMessages((prev) =>
        prev.map((x) => (x.id === data.id ? { ...x, content: "", deleted_at: new Date().toISOString() } : x))
      );
    });

    return () => {
      cancelled = true;
      offConnected();
      offNew();
      offEdited();
      offDeleted();
      wsService.unsubscribe(room);
    };
  }, [channelId]);

  // ── Garbage collection: drop rows above the ceiling ─────────────────────
  // Runs at a verified rest only. No measurement and no compensation here: rows
  // removed above the viewport are exactly what the writer's anchor invariant
  // accounts for in the same commit (and native scroll anchoring already did on
  // Chromium/Firefox).
  const pruneTopIfNeeded = useCallback(() => {
    const { start, end } = sliceRef.current;
    const over = end - start - MAX_DOM_MESSAGES;
    if (over <= 0) return;
    const list = messagesRef.current;
    const remove = Math.min(over + PRUNE_BATCH, end - start - 1);
    const kept = list[start + remove];
    if (!kept || start + remove >= end) return;
    setWin((current) => ({ ...current, first: keyOf(kept) }));
  }, []);

  // ── Sliding window: one older step, one newer step ──────────────────────
  const expandOlderNow = useCallback(() => {
    if (followingRef.current) return;
    const { start } = sliceRef.current;
    const list = messagesRef.current;
    if (start > 0) {
      const nextStart = Math.max(0, start - WINDOW_STEP);
      const older = list[nextStart];
      if (older) {
        setWin((current) => ({ ...current, first: keyOf(older) }));
        return;
      }
    }
    if (pendingOlderRef.current) {
      const page = pendingOlderRef.current;
      pendingOlderRef.current = null;
      insertOlder(page);
      return;
    }
    maybeLoadOlder();
  }, [insertOlder, maybeLoadOlder]);

  const expandNewer = useCallback(() => {
    if (followingRef.current) return;
    const { end } = sliceRef.current;
    const list = messagesRef.current;
    if (end >= list.length) return;
    const nextEnd = Math.min(list.length, end + WINDOW_STEP);
    const newest = list[nextEnd - 1];
    if (!newest) return;
    setWin((current) => ({ ...current, last: keyOf(newest) }));
  }, []);

  // ── Following the newest message ───────────────────────────────────────
  const updateFollowing = useCallback(() => {
    const el = getScroller();
    if (!el) return;
    const isFollowing = isScrolledToBottom(el, AT_BOTTOM_SLACK);
    if (isFollowing === followingRef.current) return;
    // An arrival in flight: leaving the follow state now would flash the button.
    if (!isFollowing && Date.now() < followingFreezeUntilRef.current) return;

    if (isFollowing) {
      followingRef.current = true;
      setIsAtBottom(true);
      setNewMessageCount(0);
      // Back at the newest message: re-seed the tail window. Every row that
      // leaves is above the viewport, so nothing visible moves.
      setWin((current) => (sameKeyWindow(current, TAIL_WINDOW) ? current : TAIL_WINDOW));
    } else {
      followingRef.current = false;
      setIsAtBottom(false);
      const { start, end } = sliceRef.current;
      const list = messagesRef.current;
      const first = list[start];
      const newest = list[end - 1];
      setWin((current) => ({
        first: current.first ?? (first ? keyOf(first) : null),
        last: newest ? keyOf(newest) : current.last,
      }));
    }
  }, []);

  // ── The verified rest ──────────────────────────────────────────────────
  /**
   * Everything that must not run under a live gesture or a coast: inserting a
   * fetched page above the viewport on an engine without scroll anchoring, and
   * dropping rows above the ceiling. A quiet event stream is not proof of a rest
   * (iOS), so the position has to be unchanged since the last observation.
   */
  const handleRest = useCallback(
    function handleRest() {
      if (pointerDownRef.current) return;
      const el = getScroller();
      if (!el) return;

      const scrollTop = readContainerScrollTop(el);
      if (Math.abs(scrollTop - bestPositionRef.current) > 1) {
        bestPositionRef.current = scrollTop;
        if (restTimerRef.current !== null) clearTimeout(restTimerRef.current);
        restTimerRef.current = setTimeout(() => {
          restTimerRef.current = null;
          handleRest();
        }, SCROLL_SETTLE_MS);
        return;
      }

      coastingRef.current = false;
      restTimerRef.current = null;

      if (pendingOlderRef.current) {
        const page = pendingOlderRef.current;
        pendingOlderRef.current = null;
        insertOlder(page);
      }
      if (pendingExpandRef.current) {
        pendingExpandRef.current = false;
        expandOlderNow();
        return;
      }
      pruneTopIfNeeded();
      if (!followingRef.current && scrollTop <= TOP_LOAD_ZONE) maybeLoadOlder();
    },
    [insertOlder, pruneTopIfNeeded, maybeLoadOlder, expandOlderNow],
  );
  const restRef = useRef(handleRest);
  restRef.current = handleRest;

  const armRest = useCallback(() => {
    coastingRef.current = true;
    if (restTimerRef.current !== null) clearTimeout(restTimerRef.current);
    restTimerRef.current = setTimeout(() => {
      restTimerRef.current = null;
      restRef.current();
    }, SCROLL_SETTLE_MS);
  }, []);

  // ── Scroll pass ────────────────────────────────────────────────────────
  const handleScroll = useCallback(() => {
    const el = getScroller();
    if (!el) return;
    // Our own write's scroll event is not the reader scrolling (Telegram's
    // `isScrollTopJustUpdated`): treating it as one would re-arm the rest.
    const written = lastPositionWriteRef.current;
    if (written !== null) {
      lastPositionWriteRef.current = null;
      const echo =
        Math.abs(readContainerScrollTop(el) - written.top) <= 1 &&
        Date.now() - written.at < ECHO_WINDOW_MS;
      if (echo) return;
    }
    // A glide owns the position for its duration.
    if (isAnimatingScroll(el)) return;

    armRest();
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const scroller = getScroller();
      if (!scroller) return;
      bestPositionRef.current = readContainerScrollTop(scroller);
      updateFollowing();
      // The request may start early (it touches no DOM).
      if (!followingRef.current && readContainerScrollTop(scroller) <= TOP_LOAD_ZONE) maybeLoadOlder();
    });
  }, [armRest, updateFollowing, maybeLoadOlder]);

  // The scroller is the window: listen for window and resize events (the layout
  // owns the page, so a mobile keyboard that changes the visible area fires
  // resize, not scroll). React's onScroll on a div would never fire for window
  // scroll.
  useEffect(() => {
    const onWinScroll = () => handleScroll();
    window.addEventListener("scroll", onWinScroll, { passive: true });
    window.addEventListener("resize", onWinScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onWinScroll);
      window.removeEventListener("resize", onWinScroll);
    };
  }, [handleScroll]);

  // ── Pointer/touch gate ─────────────────────────────────────────────────
  // A release can happen outside the list (a flick that ends off-screen), so the
  // clearing listeners live on the window. Lifting the finger arms the rest, so
  // the work the gate deferred happens right away.
  useEffect(() => {
    const onDown = () => { pointerDownRef.current = true; };
    const onUp = () => {
      if (!pointerDownRef.current) return;
      pointerDownRef.current = false;
      armRest();
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    window.addEventListener("touchend", onUp, true);
    window.addEventListener("touchcancel", onUp, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
      window.removeEventListener("touchend", onUp, true);
      window.removeEventListener("touchcancel", onUp, true);
    };
  }, [armRest]);

  // ── Sentinels: bi-directional window triggers ───────────────────────────
  // `hasMessages` is a dependency so the observers are (re)attached when the
  // list itself appears — nothing is rendered without messages.
  const hasMessages = messages.length > 0;
  useEffect(() => {
    const top = topSentinelRef.current;
    const bottom = bottomSentinelRef.current;
    if ((!top && !bottom) || typeof IntersectionObserver === "undefined") return;
    const topObserver = top
      ? new IntersectionObserver(
          (entries) => {
            if (!entries.some((entry) => entry.isIntersecting)) return;
            // Adding rows above the viewport is safe to do mid-coast where the
            // engine anchors scroll for us; on WebKit the compensating write
            // would be dropped under a live gesture, so it waits for a rest.
            if (hasScrollAnchoring() || (!coastingRef.current && !pointerDownRef.current)) {
              expandOlderNow();
            } else {
              pendingExpandRef.current = true;
            }
          },
          { rootMargin: "600px 0px 0px 0px" },
        )
      : null;
    const bottomObserver = bottom
      ? new IntersectionObserver(
          (entries) => {
            if (entries.some((entry) => entry.isIntersecting)) expandNewer();
          },
          { rootMargin: "0px 0px 600px 0px" },
        )
      : null;
    if (topObserver && top) topObserver.observe(top);
    if (bottomObserver && bottom) bottomObserver.observe(bottom);
    return () => {
      topObserver?.disconnect();
      bottomObserver?.disconnect();
    };
  }, [expandOlderNow, expandNewer, hasMessages]);

  // ── The single writer ──────────────────────────────────────────────────
  // One commit, one decision, one `scrollTop` write. Every read happens in this
  // layout effect's read block (after the DOM was committed, before paint) and
  // the write lands at its end, so a commit never interleaves reads and writes.
  // The decision tree is the messenger list's:
  //
  //   first placement → an arrival while following (glide) → "the reader was at
  //   the bottom" (pin) → otherwise compensate the layout change above the
  //   reader's anchor.
  //
  // The anchor is one row below the first visible one, compared in *content*
  // coordinates (`rect.top + scrollTop`, invariant under scrolling): the delta
  // it moved by IS the layout change above the reader's place.
  useLayoutEffect(() => {
    const el = getScroller();
    if (!el) return;

    const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>(".channel-message-row") ?? []);
    const previous = prevCommitRef.current;
    const isFirstCommit = !didInitialPositionRef.current;
    const tailId = messages.length > 0 ? messages[messages.length - 1].id : null;
    const pendingGlide = pendingBottomGlideRef.current;
    pendingBottomGlideRef.current = false;

    const scrollTop = readContainerScrollTop(el);
    const scrollHeight = el.scrollHeight;
    const clientHeight = el.clientHeight;
    const bottomOffset = scrollHeight - scrollTop;

    // `scrollHeight - scrollTop` grew by exactly what was added below while the
    // reader did not move, so comparing it with the PREVIOUS viewport height
    // judges the position as it was before this commit.
    const wasAtBottom = previous !== null && bottomOffset - previous.clientHeight <= AT_BOTTOM_SLACK;
    const isAtBottomNow = bottomOffset - clientHeight <= AT_BOTTOM_SLACK;
    const tailMoved = previous !== null && tailId !== previous.tailId;

    // The anchor is one row BELOW the first visible one: the first can change
    // height when older messages mount (a date separator moves up, a grouped row
    // loses its header), and the reader must not feel that (Telegram anchors on
    // `preservedItemElements[1]` for the same reason).
    let firstVisible = -1;
    for (let at = 0; at < rows.length; at += 1) {
      if (rows[at].offsetTop + rows[at].offsetHeight > scrollTop + 1) {
        firstVisible = at;
        break;
      }
    }
    const anchorRow = firstVisible >= 0 ? rows[Math.min(firstVisible + 1, rows.length - 1)] : null;
    const anchorKey = anchorRow?.dataset.messageId ?? null;
    // Content coordinates (`rect.top + scrollTop`) are invariant under scrolling,
    // so a position the previous commit wrote cannot make this anchor stale.
    const anchorCoord = anchorRow ? anchorRow.getBoundingClientRect().top + scrollTop : null;

    let pin = false;
    let glideTarget: HTMLElement | null = null;
    let nextScrollTop: number | null = null;

    // The list had no rows at the previous commit: this is its placement, not an
    // arrival — gliding it in would fly the reader through the whole history.
    const isFirstContent = previous !== null && previous.tailId === null && tailId !== null;

    if (isFirstCommit || isFirstContent) {
      didInitialPositionRef.current = true;
      pin = true;
    } else if (pendingGlide || (tailMoved && followingRef.current)) {
      if (tailMoved) followingFreezeUntilRef.current = Date.now() + FOLLOWING_FREEZE_MS;
      glideTarget = bottomSentinelRef.current;
    } else if (wasAtBottom) {
      if (!isAtBottomNow) pin = true;
    } else if (previous?.anchorKey) {
      const row = rows.find((node) => node.dataset.messageId === previous.anchorKey);
      if (row) {
        // The delta the row moved by in content coordinates IS the layout change
        // above it. Where the engine anchors scroll for us, it already moved
        // `scrollTop` by that delta, so writing it again would throw the reader a
        // full growth further down (measured, not assumed).
        const growth = row.getBoundingClientRect().top + scrollTop - previous.anchorCoord;
        const compensation = hasScrollAnchoring() ? 0 : growth;
        const target = scrollTop + compensation;
        if (Math.abs(target - scrollTop) > 0.5) nextScrollTop = target;
      }
    }

    if (glideTarget) {
      animateScroll({
        container: el,
        element: glideTarget,
        position: "end",
        maxDistance: 500,
        forceDirection: "down",
      });
    } else if (pin) {
      pinToBottom(el);
    } else if (nextScrollTop !== null) {
      setScrollTop(el, nextScrollTop);
    }

    const wrotePosition = Boolean(glideTarget) || pin || nextScrollTop !== null;
    if (wrotePosition) {
      lastPositionWriteRef.current = { top: readContainerScrollTop(el), at: Date.now() };
    }
    // The bookkeeping reads the position back, which is a read after the write —
    // declared, so the dev discipline pass does not flag it.
    forceMeasure(() => {
      bestPositionRef.current = readContainerScrollTop(el);
      prevCommitRef.current = {
        clientHeight,
        tailId,
        anchorKey: anchorKey,
        anchorCoord: anchorCoord ?? 0,
      };
    });

    // Mounts a gesture deferred land at the verified rest, never in the commit.
    armRest();
  }, [messages, slice.start, slice.end, armRest]);

  useEffect(() => {
    return () => {
      if (restTimerRef.current !== null) clearTimeout(restTimerRef.current);
      if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current);
    };
  }, []);

  // ── "N new messages" counter while scrolled up ──────────────────────────
  useEffect(() => {
    if (messages.length === 0) {
      prevLastIdRef.current = null;
      return;
    }
    const lastId = messages[messages.length - 1].id;
    const prevLast = prevLastIdRef.current;
    if (prevLast !== null && lastId !== prevLast) {
      const idx = messages.findIndex((m) => m.id === prevLast);
      if (idx >= 0 && !followingRef.current) {
        const appended = messages.slice(idx + 1);
        const incoming = appended.filter((m) => m.user_id !== currentUserId).length;
        if (incoming > 0) setNewMessageCount((c) => c + incoming);
      }
    }
    prevLastIdRef.current = lastId;
  }, [messages, currentUserId]);

  const scrollToBottom = useCallback(() => {
    followingRef.current = true;
    setIsAtBottom(true);
    setNewMessageCount(0);

    // Telegram's button: the distance the reader cannot see is covered at once,
    // and the last ≤500px glide down. Re-seeding the window changes the DOM, so
    // when it actually moves the glide is requested through the writer.
    if (sameKeyWindow(win, TAIL_WINDOW)) {
      const el = getScroller();
      const marker = bottomSentinelRef.current;
      if (!el) return;
      if (marker) {
        animateScroll({ container: el, element: marker, position: "end", maxDistance: 500, forceDirection: "down" });
      } else {
        pinToBottom(el);
        lastPositionWriteRef.current = { top: readContainerScrollTop(el), at: Date.now() };
      }
      return;
    }

    pendingBottomGlideRef.current = true;
    setWin(TAIL_WINDOW);
  }, [win]);

  const handleSend = async () => {
    const content = draft.trim();
    if (!content || sending) return;
    setSending(true);
    try {
      const r = await fetch(HISTORY_URL(channelId), {
        method: "POST",
        credentials: "include",
        headers: authHeaders(true),
        body: JSON.stringify({ content }),
      });
      const d = await r.json().catch(() => null);
      if (!r.ok || !d?.success) throw new Error(d?.error || "Сообщение не отправлено");
      const msg = d.data as ChannelMessage;
      // The WS event carries the same message; append optimistically here and
      // let the dedup in the event handler swallow the duplicate.
      setMessages((prev) => (prev.some((x) => x.id === msg.id) ? prev : [...prev, msg]));
      setDraft("");
      scrollToBottom();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Ошибка отправки");
    } finally {
      setSending(false);
    }
  };

  const handleEditSave = async () => {
    if (editingId == null) return;
    const content = editDraft.trim();
    if (!content) return;
    try {
      const r = await fetch(`${HISTORY_URL(channelId)}/${editingId}`, {
        method: "PUT",
        credentials: "include",
        headers: authHeaders(true),
        body: JSON.stringify({ content }),
      });
      const d = await r.json().catch(() => null);
      if (!r.ok || !d?.success) throw new Error(d?.error || "Не удалось изменить сообщение");
      const msg = d.data as ChannelMessage;
      setMessages((prev) =>
        prev.map((x) => (x.id === editingId ? { ...x, content: msg.content, edited_at: msg.edited_at ?? null } : x))
      );
      setEditingId(null);
      setEditDraft("");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Ошибка изменения");
    }
  };

  const handleDelete = async (msg: ChannelMessage) => {
    try {
      const r = await fetch(`${HISTORY_URL(channelId)}/${msg.id}`, {
        method: "DELETE",
        credentials: "include",
        headers: authHeaders(),
      });
      const d = await r.json().catch(() => null);
      if (!r.ok || !d?.success) throw new Error(d?.error || "Не удалось удалить сообщение");
      setMessages((prev) =>
        prev.map((x) => (x.id === msg.id ? { ...x, content: "", deleted_at: new Date().toISOString() } : x))
      );
    } catch (e) {
      toast(e instanceof Error ? e.message : "Ошибка удаления");
    }
  };

  const canEdit = (m: ChannelMessage) => Boolean(currentUserId) && m.user_id === currentUserId && !m.deleted_at;
  const canDelete = (m: ChannelMessage) =>
    !m.deleted_at && ((Boolean(currentUserId) && m.user_id === currentUserId) || canDeleteOthers);

  const rows: ChannelMessage[] = messages.slice(slice.start, slice.end);
  const displayName = channelName || "канал";

  return (
    // Normal document flow: the page scrolls (window), so Safari pans the
    // whole chat up natively when the composer is focused. Nothing here is
    // fixed, resized by --app-vh, or lifted with a translate — the most
    // native possible mobile keyboard behavior. min-h + mt-auto pins the
    // composer to the bottom of the first screen even when the channel is
    // short, plus stays in flow when it grows past one screen.
    <div className="relative bg-background min-h-[100dvh] flex flex-col">
      {/* Message stream — contributes height to the document; the window
          scrolls this page, not an inner overflow container. The pointer
          handlers are passive observers; the "a finger is on the list" gate
          itself lives on the window, so a release anywhere ends it. */}
      <div
        onPointerDown={() => {
          userDraggingRef.current = true;
        }}
        onPointerUp={() => {
          userDraggingRef.current = false;
        }}
        onPointerCancel={() => {
          userDraggingRef.current = false;
        }}
        data-testid="channel-chat-messages"
        role="log"
        aria-label="Сообщения канала"
        aria-live="polite"
      >
        {loading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        ) : denied ? (
          <div className="flex flex-col items-center justify-center gap-3 p-10 pt-24">
            <div className="w-14 h-14 rounded-full bg-muted flex items-center justify-center">
              <Hash className="w-7 h-7 text-muted-foreground" />
            </div>
            <div className="text-center text-muted-foreground text-sm">Нет доступа к этому каналу.</div>
          </div>
        ) : messages.length === 0 ? (
          <div className="px-4 sm:px-5 pt-14 pb-6 max-w-2xl">
            <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mb-4">
              <Hash className="w-8 h-8 text-muted-foreground" />
            </div>
            <h2 className="text-xl font-bold">Добро пожаловать в #{displayName}!</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Это начало канала. Здесь пока тихо — напишите первым.
            </p>
          </div>
        ) : (
          <div ref={listRef} className="channel-message-list">
            <div ref={topSentinelRef} className="chat-scroll-sentinel" aria-hidden="true" />
            <div className="flex items-center justify-center gap-3 py-2 text-[11px] text-muted-foreground/70">
              <span className="h-px flex-1 max-w-24 bg-border/60" />
              {loadingOlder ? (
                <span className="inline-flex items-center gap-1.5">
                  <Loader2 className="w-3 h-3 animate-spin" /> Загружаем историю…
                </span>
              ) : hasMore ? (
                <span>Скрольте вверх, чтобы загрузить ещё</span>
              ) : (
                <span>Начало канала</span>
              )}
              <span className="h-px flex-1 max-w-24 bg-border/60" />
            </div>

            {rows.map((m, offset) => {
              const index = slice.start + offset;
              const prev = index > 0 ? messages[index - 1] : null;
              const grouped = isGroupedWith(prev, m);
              return (
                <div
                  key={m.id}
                  data-message-id={m.id}
                  className="channel-message-row chat-native-row"
                >
                  <div
                    className={`group relative flex gap-3 px-4 sm:px-5 hover:bg-muted/40 transition-colors ${
                      grouped ? "py-0.5" : "pt-2.5 pb-0.5"
                    }`}
                  >
                    <div className="shrink-0 w-10 flex justify-center">
                      {!grouped ? (
                        m.avatar_url ? (
                          <img
                            src={m.avatar_url}
                            alt=""
                            className="w-10 h-10 rounded-full object-cover"
                          />
                        ) : (
                          <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center text-sm font-semibold text-muted-foreground">
                            {(m.username || "?").slice(0, 1).toUpperCase()}
                          </div>
                        )
                      ) : (
                        <span
                          aria-hidden="true"
                          className="hidden group-hover:block pt-1.5 text-[10px] leading-none text-muted-foreground/50"
                        >
                          {clockTime(m.created_at)}
                        </span>
                      )}
                    </div>
                    <div className="min-w-0 flex-1 pb-0.5">
                      {!grouped && (
                        <div className="flex items-baseline gap-2">
                          <span className="text-[15px] font-medium leading-tight hover:underline cursor-pointer">
                            {m.username}
                          </span>
                          <span className="text-[11px] text-muted-foreground/60">
                            {timeLabel(m.created_at)}
                          </span>
                        </div>
                      )}
                      {m.deleted_at ? (
                        <div className="text-[15px] italic text-muted-foreground/70">Сообщение удалено</div>
                      ) : editingId === m.id ? (
                        <div className="flex items-center gap-1 mt-0.5">
                          <input
                            data-autofocus="true"
                            value={editDraft}
                            maxLength={MAX_CONTENT_LENGTH}
                            onChange={(e) => setEditDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") handleEditSave();
                              if (e.key === "Escape") {
                                setEditingId(null);
                                setEditDraft("");
                              }
                            }}
                            className="flex-1 h-7 bg-background border border-border rounded-md px-2 text-sm focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          />
                          <button onClick={handleEditSave} className="p-1 text-muted-foreground hover:text-primary" title="Сохранить">
                            <SendHorizontal className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => {
                              setEditingId(null);
                              setEditDraft("");
                            }}
                            className="p-1 text-muted-foreground hover:text-destructive"
                            title="Отмена"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ) : (
                        <div className="text-[15px] leading-relaxed whitespace-pre-wrap break-words">
                          {m.content}
                          {m.edited_at && <span className="ml-1 text-[10px] text-muted-foreground/50">(изменено)</span>}
                        </div>
                      )}
                    </div>
                    {!m.deleted_at && editingId !== m.id && (
                      <div className="absolute -top-3 right-4 hidden group-hover:flex items-center rounded-lg border border-border/60 bg-card shadow-md">
                        {canEdit(m) && (
                          <button
                            onClick={() => {
                              setEditingId(m.id);
                              setEditDraft(m.content);
                              requestAnimationFrame(() => {
                                const el = listRef.current?.querySelector('[data-autofocus="true"]') as HTMLInputElement | null;
                                el?.focus();
                              });
                            }}
                            className="p-1.5 text-muted-foreground hover:text-foreground"
                            title="Изменить"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {canDelete(m) && (
                          <button
                            onClick={() => handleDelete(m)}
                            className="p-1.5 text-muted-foreground hover:text-destructive"
                            title="Удалить"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}

            <div ref={bottomSentinelRef} className="chat-scroll-sentinel" aria-hidden="true" />
            <div aria-hidden="true" className="h-4" />
          </div>
        )}
      </div>

      {/* Jump to the newest while scrolled up. Fixed to the viewport (the
          page scrolls, so absolute would scroll away with the content). */}
      {!isAtBottom && messages.length > 0 && (
        <button
          type="button"
          onClick={scrollToBottom}
          className="fixed right-4 bottom-[max(5.5rem,env(safe-area-inset-bottom,0px)+4.5rem)] h-8 w-8 rounded-full border border-border bg-card shadow-md flex items-center justify-center text-muted-foreground hover:text-primary transition-colors z-20"
          aria-label={
            newMessageCount > 0
              ? `Вниз (${newMessageCount} ${newMessageCount === 1 ? "новое" : "новых"} сообщени${newMessageCount === 1 ? "е" : "й"})`
              : "Вниз"
          }
        >
          <ChevronDown className="w-4 h-4" />
          {newMessageCount > 0 && (
            <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-primary text-primary-foreground text-[10px] font-semibold flex items-center justify-center">
              {newMessageCount > 99 ? "99+" : newMessageCount}
            </span>
          )}
        </button>
      )}

      {/* Composer — Discord-style pill, the PAGE's last flow element. Focusing
          it lets Safari scroll the whole page up natively; the bottom message
          rides up with everything else, nothing is lifted or resized.
          mt-auto hangs it on the bottom of the min-height (short channels).
          Hidden when inaccessible. */}
      {!denied && (
      <div className="mt-auto px-4 sm:px-5 pt-1 pb-[max(0.75rem,env(safe-area-inset-bottom,0px))]">
        {currentUserId ? (
          canPost ? (
            <form
              className="flex items-center gap-1 rounded-2xl border border-border/40 bg-muted/50 focus-within:border-ring/50 transition-colors px-2 h-11"
              onSubmit={(e) => {
                e.preventDefault();
                handleSend();
              }}
            >
              <input
                value={draft}
                maxLength={MAX_CONTENT_LENGTH}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={`Написать в #${displayName}…`}
                className="flex-1 h-full min-w-0 bg-transparent px-2 text-[15px] placeholder:text-muted-foreground/60 focus:outline-none"
              />
              <Button
                type="submit"
                size="icon"
                variant="ghost"
                className="h-8 w-8 shrink-0 text-muted-foreground hover:text-primary hover:bg-primary/10 disabled:opacity-40"
                disabled={sending || !draft.trim()}
              >
                {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <SendHorizontal className="w-4 h-4" />}
              </Button>
            </form>
          ) : (
            <div className="rounded-2xl border border-border/40 bg-muted/40 text-center text-xs text-muted-foreground py-2.5">
              Вступите в гомосаб, чтобы писать в канал
            </div>
          )
        ) : (
          <div className="rounded-2xl border border-border/40 bg-muted/40 text-center text-xs text-muted-foreground py-2.5">
            Войдите, чтобы писать в канал
          </div>
        )}
      </div>
      )}
    </div>
  );
}

export default ChannelChat;
