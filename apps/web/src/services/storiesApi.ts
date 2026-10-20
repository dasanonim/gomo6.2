import { apiClient } from "@/integrations/api/client";
import type {
  CreateStoryInput,
  Story,
  StoryAuthor,
  StoryGroup,
  StoryScope,
  StoryViewersPage,
  UpdateStoryInput,
} from "@/types/stories";

/**
 * Stories REST surface (`/api/v1/stories`).
 *
 * Uses the raw client rather than `api.from()` because the rail, the archive
 * and the viewer are single purpose endpoints: their response shapes are the
 * product contract (groups, per-viewer read state, close-friends filtering),
 * not generic table rows.
 */
async function get<T>(path: string): Promise<T> {
  // Story lists are per-viewer and change on publish/delete/view. The browser
  // must never answer from its HTTP cache (that resurrected a deleted slide
  // until a reload); the backend additionally bypasses its Redis data cache.
  const res = await apiClient.request<T>(path, { cache: "no-store" });
  // The envelope types `data` as `T | T[]` (it also serves table queries).
  // Every stories endpoint returns exactly one shape, so this is a narrow cast,
  // not a guess.
  return res.data as unknown as T;
}

export const storiesApi = {
  rail(): Promise<StoryGroup[]> {
    return get<{ groups: StoryGroup[] }>("/api/v1/stories/rail").then((r) => r?.groups ?? []);
  },

  userStories(userId: string, scope: StoryScope = "live"): Promise<Story[]> {
    return get<Story[]>(
      `/api/v1/stories/user/${encodeURIComponent(userId)}?scope=${encodeURIComponent(scope)}`,
    );
  },

  boardStories(boardId: string, scope: "live" | "archive" = "live"): Promise<Story[]> {
    return get<Story[]>(
      `/api/v1/stories/board/${encodeURIComponent(boardId)}?scope=${encodeURIComponent(scope)}`,
    );
  },

  story(id: string): Promise<Story> {
    return get<Story>(`/api/v1/stories/${encodeURIComponent(id)}`);
  },

  async create(input: CreateStoryInput): Promise<Story> {
    const res = await apiClient.request<Story>("/api/v1/stories", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return res.data as unknown as Story;
  },

  async update(id: string, patch: UpdateStoryInput): Promise<Story> {
    const res = await apiClient.request<Story>(`/api/v1/stories/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(patch),
    });
    return res.data as unknown as Story;
  },

  async remove(id: string): Promise<void> {
    await apiClient.request(`/api/v1/stories/${encodeURIComponent(id)}`, { method: "DELETE" });
  },

  async view(id: string): Promise<{ views_count: number; counted: boolean }> {
    const res = await apiClient.request<{ views_count: number; counted: boolean }>(
      `/api/v1/stories/${encodeURIComponent(id)}/view`,
      { method: "POST" },
    );
    return res.data as unknown as { views_count: number; counted: boolean };
  },

  async setReaction(id: string, emoji: string): Promise<{ emoji: string; reactions_count: number }> {
    const res = await apiClient.request<{ emoji: string; reactions_count: number }>(
      `/api/v1/stories/${encodeURIComponent(id)}/reaction`,
      { method: "PUT", body: JSON.stringify({ emoji }) },
    );
    return res.data as unknown as { emoji: string; reactions_count: number };
  },

  async removeReaction(id: string): Promise<{ reactions_count: number }> {
    const res = await apiClient.request<{ reactions_count: number }>(
      `/api/v1/stories/${encodeURIComponent(id)}/reaction`,
      { method: "DELETE" },
    );
    return res.data as unknown as { reactions_count: number };
  },

  viewers(id: string, params: { before?: string; limit?: number } = {}): Promise<StoryViewersPage> {
    const q = new URLSearchParams();
    if (params.before) q.set("before", params.before);
    if (params.limit) q.set("limit", String(params.limit));
    const suffix = q.toString() ? `?${q.toString()}` : "";
    return get<StoryViewersPage>(`/api/v1/stories/${encodeURIComponent(id)}/viewers${suffix}`);
  },

  closeFriends(): Promise<StoryAuthor[]> {
    return get<{ friends: StoryAuthor[] }>("/api/v1/stories/close-friends").then(
      (r) => r?.friends ?? [],
    );
  },

  /** Mutual friends (the only people who can join the «Избранные» list). */
  friends(): Promise<StoryAuthor[]> {
    return get<
      Array<{
        user_id: string;
        username: string;
        display_name?: string | null;
        avatar_url?: string | null;
        is_online?: boolean;
      }>
    >("/api/v1/friends").then((rows) =>
      (rows ?? []).map((row) => ({
        id: row.user_id,
        username: row.username,
        display_name: row.display_name ?? null,
        avatar_url: row.avatar_url ?? null,
        avatar_animated: false,
      })),
    );
  },

  async setCloseFriends(userIds: string[]): Promise<void> {
    await apiClient.request("/api/v1/stories/close-friends", {
      method: "PUT",
      body: JSON.stringify({ user_ids: userIds }),
    });
  },
};
