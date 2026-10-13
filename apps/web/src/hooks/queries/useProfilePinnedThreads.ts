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
  });
}
