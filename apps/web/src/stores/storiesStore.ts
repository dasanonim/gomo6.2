import { create } from "zustand";
import { storiesApi } from "@/services/storiesApi";
import {
  ownerKey,
  type CreateStoryInput,
  type Story,
  type StoryAuthor,
  type StoryGroup,
  type StoryOwner,
  type StoryOwnerType,
  type StoryScope,
  type UpdateStoryInput,
} from "@/types/stories";

export type StoryViewerState = {
  ownerType: StoryOwnerType;
  ownerId: string;
  storyId: string;
  /** Origin for the open animation and analytics: rail / profile / board / deep-link. */
  origin?: string;
};

export type StoryComposerState = {
  ownerType: StoryOwnerType;
  ownerId: string;
  ownerName: string;
};

type StoriesState = {
  /** The rail, in the order the server returned (own group first). */
  rail: StoryGroup[];
  railLoaded: boolean;
  railLoading: boolean;
  /** Live stories per owner, merged from the rail and per-owner fetches. */
  byOwner: Record<string, Story[]>;
  /** Profile highlights (pinned), per user id. */
  highlights: Record<string, Story[]>;
  /** The viewer's own archive, per user id. */
  archive: Record<string, Story[]>;
  closeFriends: StoryAuthor[] | null;
  viewer: StoryViewerState | null;
  composer: StoryComposerState | null;
  publishing: boolean;

  loadRail: (force?: boolean) => Promise<void>;
  loadUserStories: (userId: string, scope?: StoryScope) => Promise<Story[]>;
  loadBoardStories: (boardId: string, scope?: "live" | "archive") => Promise<Story[]>;
  publish: (input: CreateStoryInput, target: StoryComposerState) => Promise<Story>;
  removeStory: (story: Story) => Promise<void>;
  updateStory: (story: Story, patch: UpdateStoryInput) => Promise<void>;
  markViewed: (story: Story) => Promise<void>;
  react: (story: Story, emoji: string) => Promise<void>;
  loadCloseFriends: (force?: boolean) => Promise<StoryAuthor[]>;
  saveCloseFriends: (userIds: string[]) => Promise<void>;

  openViewer: (state: StoryViewerState) => void;
  closeViewer: () => void;
  openComposer: (target: StoryComposerState) => void;
  closeComposer: () => void;

  /** Realtime hook (wired in the stories realtime bridge). */
  applyRealtimeEvent: (type: string, payload: Record<string, unknown>) => void;

  storiesFor: (ownerType: StoryOwnerType, ownerId: string) => Story[];
  reset: () => void;
};

const emptyCollections = {
  rail: [] as StoryGroup[],
  railLoaded: false,
  railLoading: false,
  byOwner: {} as Record<string, Story[]>,
  highlights: {} as Record<string, Story[]>,
  archive: {} as Record<string, Story[]>,
  closeFriends: null as StoryAuthor[] | null,
  viewer: null as StoryViewerState | null,
  composer: null as StoryComposerState | null,
  publishing: false,
};

/** Replace a story in every collection it may appear in (a slide can be in the
 * rail and in a per-owner list at once; leaving one copy stale shows a dot that
 * should already be read). */
function patchStory(state: StoriesState, id: string, patch: Partial<Story>): Partial<StoriesState> {
  const apply = (list: Story[]): Story[] =>
    list.map((story) => (story.id === id ? { ...story, ...patch } : story));
  const byOwner: Record<string, Story[]> = {};
  for (const [key, list] of Object.entries(state.byOwner)) {
    byOwner[key] = apply(list);
  }
  const highlights: Record<string, Story[]> = {};
  for (const [key, list] of Object.entries(state.highlights)) {
    highlights[key] = apply(list);
  }
  const rail = state.rail.map((group) => {
    const stories = apply(group.stories);
    return {
      ...group,
      stories,
      has_unread: stories.some((story) => !story.is_viewed && !story.is_own),
    };
  });
  return { byOwner, highlights, rail };
}

function mergeStories(existing: Story[], incoming: Story[]): Story[] {
  const byId = new Map(existing.map((story) => [story.id, story]));
  for (const story of incoming) byId.set(story.id, story);
  return Array.from(byId.values()).sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );
}

/** Insert/update a freshly published slide into the rail without a refetch. */
function upsertRailGroup(
  rail: StoryGroup[],
  owner: StoryOwner,
  story: Story,
): StoryGroup[] {
  const key = ownerKey(owner.type, owner.id);
  const existing = rail.find((group) => ownerKey(group.owner.type, group.owner.id) === key);
  if (existing) {
    const stories = mergeStories(existing.stories, [story]);
    return rail.map((group) =>
      group === existing
        ? { ...group, stories, has_unread: stories.some((s) => !s.is_viewed && !s.is_own) }
        : group,
    );
  }
  return [{ owner, stories: [story], has_unread: false }, ...rail];
}

export const useStoriesStore = create<StoriesState>((set, get) => ({
  ...emptyCollections,

  loadRail: async (force = false) => {
    if (get().railLoading) return;
    if (get().railLoaded && !force) return;
    set({ railLoading: true });
    try {
      const groups = await storiesApi.rail();
      const byOwner: Record<string, Story[]> = { ...get().byOwner };
      for (const group of groups) {
        byOwner[ownerKey(group.owner.type, group.owner.id)] = group.stories;
      }
      set({ rail: groups, byOwner, railLoaded: true });
    } catch {
      // A failed rail must not leave the page on a skeleton forever: an empty
      // rail still renders the "your story" tile.
      set({ railLoaded: true });
    } finally {
      set({ railLoading: false });
    }
  },

  loadUserStories: async (userId, scope = "live") => {
    const stories = await storiesApi.userStories(userId, scope);
    if (scope === "live") {
      set((state) => ({ byOwner: { ...state.byOwner, [ownerKey("user", userId)]: stories } }));
    } else if (scope === "pinned") {
      set((state) => ({ highlights: { ...state.highlights, [userId]: stories } }));
    } else {
      set((state) => ({ archive: { ...state.archive, [userId]: stories } }));
    }
    return stories;
  },

  loadBoardStories: async (boardId, scope = "live") => {
    const stories = await storiesApi.boardStories(boardId, scope);
    if (scope === "live") {
      set((state) => ({ byOwner: { ...state.byOwner, [ownerKey("gosub", boardId)]: stories } }));
    } else {
      set((state) => ({ archive: { ...state.archive, [boardId]: stories } }));
    }
    return stories;
  },

  publish: async (input, target) => {
    set({ publishing: true });
    try {
      const story = await storiesApi.create(input);
      const owner: StoryOwner = {
        type: target.ownerType,
        id: target.ownerId,
        name: target.ownerName,
      };
      set((state) => {
        const key = ownerKey(target.ownerType, target.ownerId);
        const byOwner = { ...state.byOwner };
        if (story.privacy !== "only_me") {
          byOwner[key] = mergeStories(byOwner[key] ?? [], [story]);
        }
        return {
          byOwner,
          rail: story.privacy === "only_me" ? state.rail : upsertRailGroup(state.rail, owner, story),
        };
      });
      return story;
    } finally {
      set({ publishing: false });
    }
  },

  removeStory: async (story) => {
    await storiesApi.remove(story.id);
    set((state) => {
      const drop = (list: Story[]) => list.filter((s) => s.id !== story.id);
      const byOwner: Record<string, Story[]> = {};
      for (const [key, list] of Object.entries(state.byOwner)) byOwner[key] = drop(list);
      const highlights: Record<string, Story[]> = {};
      for (const [key, list] of Object.entries(state.highlights)) highlights[key] = drop(list);
      const rail = state.rail
        .map((group) => ({ ...group, stories: drop(group.stories) }))
        .filter((group) => group.stories.length > 0);
      return { byOwner, highlights, rail };
    });
  },

  updateStory: async (story, patch) => {
    const updated = await storiesApi.update(story.id, patch);
    set((state) => patchStory(state, story.id, updated));
  },

  markViewed: async (story) => {
    // The caller may hold a slightly stale object (the viewer keeps its own
    // index); the store copy is what decides whether a report is needed.
    const fresh =
      Object.values(get().byOwner)
        .flat()
        .find((candidate) => candidate.id === story.id) ?? story;
    if (fresh.is_viewed || fresh.is_own) return;
    // Optimistic: the ring loses a segment immediately, and a failure only
    // costs a duplicate report on the next open (the server is idempotent).
    set((state) => patchStory(state, story.id, { is_viewed: true }));
    try {
      await storiesApi.view(story.id);
    } catch {
      set((state) => patchStory(state, story.id, { is_viewed: false }));
    }
  },

  react: async (story, emoji) => {
    const had = story.my_reaction === emoji;
    set((state) =>
      patchStory(state, story.id, {
        my_reaction: had ? null : emoji,
        reactions_count: Math.max(0, story.reactions_count + (had ? -1 : story.my_reaction ? 0 : 1)),
      }),
    );
    try {
      if (had) await storiesApi.removeReaction(story.id);
      else await storiesApi.setReaction(story.id, emoji);
    } catch {
      set((state) =>
        patchStory(state, story.id, {
          my_reaction: story.my_reaction,
          reactions_count: story.reactions_count,
        }),
      );
    }
  },

  loadCloseFriends: async (force = false) => {
    const cached = get().closeFriends;
    if (cached && !force) return cached;
    const friends = await storiesApi.closeFriends();
    set({ closeFriends: friends });
    return friends;
  },

  saveCloseFriends: async (userIds) => {
    await storiesApi.setCloseFriends(userIds);
    // The server filters non-friends out; refetch the authoritative list.
    const friends = await storiesApi.closeFriends();
    set({ closeFriends: friends });
  },

  openViewer: (state) => set({ viewer: state }),
  closeViewer: () => set({ viewer: null }),
  openComposer: (target) => set({ composer: target }),
  closeComposer: () => set({ composer: null }),

  applyRealtimeEvent: (type, payload) => {
    const ownerType = payload.owner_type as StoryOwnerType | undefined;
    const ownerId = payload.owner_id as string | undefined;
    if (!ownerType || !ownerId) return;
    if (type === "new_story" || type === "story_updated" || type === "story_deleted") {
      // Refetch the owner's live list: the event deliberately carries no
      // content, so the audience rule stays on the server.
      const key = ownerKey(ownerType, ownerId);
      const fetchStories =
        ownerType === "gosub"
          ? storiesApi.boardStories(ownerId, "live")
          : storiesApi.userStories(ownerId, "live");
      void fetchStories
        .then((stories) => set((state) => ({ byOwner: { ...state.byOwner, [key]: stories } })))
        .catch(() => undefined);
      if (type === "new_story") void get().loadRail(true).catch(() => undefined);
    }
  },

  storiesFor: (ownerType, ownerId) => get().byOwner[ownerKey(ownerType, ownerId)] ?? [],

  reset: () => set({ ...emptyCollections }),
}));
