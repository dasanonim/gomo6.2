import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/integrations/api/compat';
import type { ThreadApiRow } from '@/utils/threadFeedItem';

/**
 * «Закреплённые темы» on the profile page (issue #518).
 *
 * A profile owner pins up to MAX_PINNED_PROFILE_THREADS threads — their own or
 * somebody else's — and they render as a compact list between the identity panel
 * and the tab bar.
 *
 * The backend splits the read in two on purpose: the pin rows
 * (`profile_pinned_threads`) carry only `{thread_id, position}` and are gated by
 * the profile owner's privacy (same rule as the threads tab), while the thread
 * bodies come from GET /threads, the surface that already enforces board and
 * channel visibility. A pin therefore can never widen what a viewer may read —
 * a thread hidden from them simply drops out of the list.
 */

/** Mirrors crudengine.MaxPinnedProfileThreads. */
export const MAX_PINNED_PROFILE_THREADS = 3;

export interface PinnedProfileThreadRow {
  thread_id: string;
  position: number;
}

const fetchPinnedRows = async (userId: string): Promise<PinnedProfileThreadRow[]> => {
  const { data } = await api
    .from('profile_pinned_threads')
    .select('thread_id, position')
    .eq('user_id', userId)
    .order('position', { ascending: true })
    .limit(MAX_PINNED_PROFILE_THREADS);
  return (data ?? []) as PinnedProfileThreadRow[];
};

const fetchThreadsByIds = async (ids: string[]): Promise<ThreadApiRow[]> => {
  if (ids.length === 0) return [];
  const { data } = await api.from('threads').select('*').in('id', ids);
  return (data ?? []) as ThreadApiRow[];
};

/**
 * The profile's pinned threads, in the owner's order.
 *
 * Fetches the pin rows first and resolves only those threads, so the block costs
 * one small request when nothing is pinned and two otherwise. Threads the viewer
 * cannot see (private board, hidden section) are dropped, keeping the stored
 * order for the rest.
 */
export function useProfilePinnedThreads(userId: string | undefined) {
  return useQuery({
    queryKey: ['profile-pinned-threads', userId],
    enabled: !!userId,
    staleTime: 60 * 1000,
    queryFn: async (): Promise<ThreadApiRow[]> => {
      if (!userId) return [];
      const pins = await fetchPinnedRows(userId);
      if (pins.length === 0) return [];
      const threads = await fetchThreadsByIds(pins.map((p) => p.thread_id));
      const byId = new Map(threads.map((thread) => [thread.id, thread]));
      return pins
        .map((pin) => byId.get(pin.thread_id))
        .filter((thread): thread is ThreadApiRow => Boolean(thread));
    },
  });
}

/**
 * The thread ids the given user has pinned. Used by the thread page's «три
 * точки» menu to show «Закрепить в профиле» vs «Открепить из профиля».
 */
export function usePinnedThreadIds(userId: string | null | undefined) {
  return useQuery({
    queryKey: ['pinned-thread-ids', userId],
    enabled: !!userId,
    staleTime: 60 * 1000,
    queryFn: async (): Promise<string[]> => {
      if (!userId) return [];
      const pins = await fetchPinnedRows(userId);
      return pins.map((pin) => pin.thread_id);
    },
  });
}

/** The server rejects a fourth pin with 409 (crudengine.MaxPinnedProfileThreads). */
const isPinLimitError = (error: unknown): boolean =>
  (error as { status?: number } | null)?.status === 409;

/** Pin or unpin a thread in the current user's profile. */
export function useTogglePinnedThread(userId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ threadId, pinned }: { threadId: string; pinned: boolean }) => {
      if (pinned) {
        await api.from('profile_pinned_threads').insert({ thread_id: threadId });
      } else {
        await api.from('profile_pinned_threads').delete().eq('thread_id', threadId);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['profile-pinned-threads'] });
      queryClient.invalidateQueries({ queryKey: ['pinned-thread-ids'] });
    },
    onError: (error) => {
      // A rejected pin (the 3-pin cap → 409) proves our cached id list is stale:
      // otherwise the menu keeps offering a pin that can only fail again.
      if (isPinLimitError(error)) {
        queryClient.invalidateQueries({ queryKey: ['pinned-thread-ids'] });
      }
    },
  });
}

/**
 * What a pin/unpin attempt resolved to — the caller owns the user-facing wording.
 *
 * Discriminated by a STRING tag, not a boolean: the app compiles with
 * `strict: false`, and with `strictNullChecks` off TypeScript does not narrow a
 * union through `!outcome.ok` (only through `===`), which made the obvious
 * caller code fail to compile.
 */
export type PinToggleOutcome =
  | { status: 'ok'; pinned: boolean }
  | { status: 'limit' }
  | { status: 'error' };

/**
 * «Закрепить/Открепить в профиле» state for ONE thread — used by the thread
 * page's «три точки» menu.
 *
 * Owns the two derivations the menu needs (is this thread pinned by me? is the
 * 3-pin cap already reached?) plus the toggle itself. `toggle` RESOLVES to the
 * outcome rather than toasting, so the messaging stays in the component and this
 * hook stays free of UI concerns — which is also what makes it directly
 * testable.
 */
export function useThreadPinToggle(threadId: string | undefined, userId: string | null | undefined) {
  const pinnedIds = usePinnedThreadIds(userId);
  const togglePin = useTogglePinnedThread(userId);

  const pinnedList = pinnedIds.data;
  const isPinned = Boolean(threadId && pinnedList?.includes(threadId));
  // The cap only gates pinning something NEW — an already-pinned thread must
  // stay unpinnable however full the list is.
  const limitReached = !isPinned && (pinnedList?.length ?? 0) >= MAX_PINNED_PROFILE_THREADS;

  const toggle = async (): Promise<PinToggleOutcome> => {
    if (!threadId) return { status: 'error' };
    const nextPinned = !isPinned;
    try {
      await togglePin.mutateAsync({ threadId, pinned: nextPinned });
      return { status: 'ok', pinned: nextPinned };
    } catch (error) {
      return isPinLimitError(error) ? { status: 'limit' } : { status: 'error' };
    }
  };

  return { isPinned, limitReached, isPending: togglePin.isPending, toggle };
}
