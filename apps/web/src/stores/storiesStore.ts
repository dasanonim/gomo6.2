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

/** One owner's slice of the viewer queue (a snapshot taken on open, so a
 * realtime refresh cannot reorder the slides under the viewer's finger). */
export type StoryViewerGroup = {
  ownerType: StoryOwnerType;
  ownerId: string;
  storyIds: string[];
};

export type StoryViewerState = {
  ownerType: StoryOwnerType;
  ownerId: string;
  storyId: string;
  /** Owner display name, known by the entry point (board name, profile name). */
  ownerName?: string;
  /** Origin for the open animation and analytics: rail / profile / board / deep-link. */
  origin?: string;
  /** Groups to walk after this one; absent means "this owner only". */
  queue?: StoryViewerGroup[];
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
  viewerNext: () => void;
  viewerPrev: () => void;
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

/** The viewer position after `deletedId` is gone: next slide in the same
 * group, else the next group's first slide, else the previous group's last. */
function nextViewerAfterDelete(
  viewer: StoryViewerState,
  deletedId: string,
): { ownerType: StoryOwnerType; ownerId: string; storyId: string } | null {
  const queue = viewer.queue;
  if (!queue) return null;
  const groupIndex = queue.findIndex(
    (group) => group.ownerType === viewer.ownerType && group.ownerId === viewer.ownerId,
  );
  if (groupIndex === -1) return null;

  const ids = queue[groupIndex].storyIds;
  const index = ids.indexOf(deletedId);
  for (let i = index + 1; i < ids.length; i += 1) {
    if (ids[i] !== deletedId) {
      return { ownerType: viewer.ownerType, ownerId: viewer.ownerId, storyId: ids[i] };
    }
  }
  for (let g = groupIndex + 1; g < queue.length; g += 1) {
    if (queue[g].storyIds.length) {
      return {
        ownerType: queue[g].ownerType,
        ownerId: queue[g].ownerId,
        storyId: queue[g].storyIds[0],
      };
    }
  }
  for (let g = groupIndex - 1; g >= 0; g -= 1) {
    const previous = queue[g].storyIds;
    if (previous.length) {
      return {
        ownerType: queue[g].ownerType,
        ownerId: queue[g].ownerId,
        storyId: previous[previous.length - 1],
      };
    }
  }
  return null;
}

/** Remove a story from every collection AND from the viewer queue, moving the
 * player to the next slide (or closing it) when the open slide is the one that
 * disappeared. A queued id that no longer resolves used to leave the player on
 * "story unavailable" after pressing back. */
function dropStoryState(state: StoriesState, storyId: string): Partial<StoriesState> {
  const drop = (list: Story[]) => list.filter((story) => story.id !== storyId);
  const mapLists = (source: Record<string, Story[]>) => {
    const out: Record<string, Story[]> = {};
    for (const [key, list] of Object.entries(source)) out[key] = drop(list);
    return out;
  };

  const rail = state.rail
    .map((group) => {
      const stories = drop(group.stories);
      return {
        ...group,
        stories,
        has_unread: stories.some((story) => !story.is_viewed && !story.is_own),
      };
    })
    .filter((group) => group.stories.length > 0);

  let viewer = state.viewer;
  if (viewer?.queue?.length) {
    const queue = viewer.queue
      .map((group) => ({ ...group, storyIds: group.storyIds.filter((id) => id !== storyId) }))
      .filter((group) => group.storyIds.length > 0);
    if (viewer.storyId === storyId) {
      const next = nextViewerAfterDelete(viewer, storyId);
      viewer = next ? { ...viewer, ...next, queue } : null;
    } else {
      viewer = { ...viewer, queue };
    }
  }

  return {
    byOwner: mapLists(state.byOwner),
    highlights: mapLists(state.highlights),
    archive: mapLists(state.archive),
    rail,
    viewer,
  };
}

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

/** Walk the viewer queue by one slide. Returns the new position, or null when
 * the queue is exhausted (the caller closes the viewer). */
export function walkViewer(
  viewer: StoryViewerState,
  direction: 1 | -1,
): { ownerType: StoryOwnerType; ownerId: string; storyId: string } | null {
  const queue = viewer.queue ?? [];
  const groupIndex = queue.findIndex(
    (group) => group.ownerType === viewer.ownerType && group.ownerId === viewer.ownerId,
  );
  if (groupIndex === -1) {
    // No snapshot (opened before the list was stored): stay on the owner.
    return null;
  }
  let storyIndex = queue[groupIndex].storyIds.indexOf(viewer.storyId);
  if (storyIndex === -1) storyIndex = 0;

  const nextSlide = storyIndex + direction;
  if (nextSlide >= 0 && nextSlide < queue[groupIndex].storyIds.length) {
    return {
      ownerType: viewer.ownerType,
      ownerId: viewer.ownerId,
      storyId: queue[groupIndex].storyIds[nextSlide],
    };
  }

  for (let i = groupIndex + direction; i >= 0 && i < queue.length; i += direction) {
    const group = queue[i];
    if (group.storyIds.length === 0) continue;
    const storyId = direction === 1 ? group.storyIds[0] : group.storyIds[group.storyIds.length - 1];
    return { ownerType: group.ownerType, ownerId: group.ownerId, storyId };
  }
  return null;
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
        // The author's own list always gets the slide (their profile ring and
        // the viewer read it), but an "only me" slide must not enter the public
        // rail.
        const byOwner = {
          ...state.byOwner,
          [key]: mergeStories(state.byOwner[key] ?? [], [story]),
        };
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
    set((state) => dropStoryState(state, story.id));
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

  openViewer: (state) => {
    // The queue is a snapshot of IDs, but the CURRENT owner's list is taken from
    // the store (the same array the viewer resolves slides from), not from the
    // rail: the rail can be stale, can exclude "only me" slides, and a profile
    // can open a slide the rail never carried. A queue whose ids do not contain
    // the opened slide used to send "next" past the end and close the player.
    const live = get().byOwner[ownerKey(state.ownerType, state.ownerId)] ?? [];
    const current: StoryViewerGroup = {
      ownerType: state.ownerType,
      ownerId: state.ownerId,
      storyIds: live.map((story) => story.id),
    };

    let queue: StoryViewerGroup[] = current.storyIds.length ? [current] : [];

    // Only the rail continues into other owners — the same rule Telegram uses
    // for `isSinglePeer`: opening from a profile/board stays on that owner.
    if (state.origin === "rail") {
      const rail = get().rail;
      const groups = rail
        .map((group) => ({
          ownerType: group.owner.type,
          ownerId: group.owner.id,
          storyIds:
            group.owner.type === state.ownerType && group.owner.id === state.ownerId
              ? current.storyIds
              : group.stories.map((story) => story.id),
        }))
        .filter((group) => group.storyIds.length > 0);
      const index = groups.findIndex(
        (group) => group.ownerType === state.ownerType && group.ownerId === state.ownerId,
      );
      if (index !== -1) queue = groups;
      else if (current.storyIds.length) queue = [...groups, current];
    }

    // No list at all (a deep link before the fetch): leave the queue undefined
    // and let walkViewer keep the viewer on this owner instead of closing it.
    set({ viewer: { ...state, queue: queue.length ? queue : undefined } });
  },
  closeViewer: () => set({ viewer: null }),

  viewerNext: () => {
    const viewer = get().viewer;
    if (!viewer) return;
    const step = walkViewer(viewer, 1);
    if (step) set({ viewer: { ...viewer, ...step } });
    else if (!viewer.queue?.length) return; // a deep link with no fetched list: stay put
    else set({ viewer: null });
  },

  viewerPrev: () => {
    const viewer = get().viewer;
    if (!viewer) return;
    const step = walkViewer(viewer, -1);
    if (step) set({ viewer: { ...viewer, ...step } });
    else if (!viewer.queue?.length) return;
    else set({ viewer: null });
  },
  openComposer: (target) => set({ composer: target }),
  closeComposer: () => set({ composer: null }),

  applyRealtimeEvent: (type, payload) => {
    // A deletion is authoritative and needs no refetch: drop the slide locally
    // (including from the open player) so it disappears the moment the author
    // deletes it — in this tab and in every viewer's tab.
    if (type === "story_deleted") {
      const storyId = payload.story_id as string | undefined;
      if (storyId) set((state) => dropStoryState(state, storyId));
      return;
    }

    // Author-only counters (the server publishes them to stories_owner_<id>).
    if (type === "story_viewed") {
      const storyId = payload.story_id as string | undefined;
      const views = Number(payload.views_count);
      if (storyId && Number.isFinite(views)) {
        set((state) => patchStory(state, storyId, { views_count: views }));
      }
      return;
    }
    if (type === "story_reaction") {
      const storyId = payload.story_id as string | undefined;
      const count = Number(payload.reactions_count);
      if (storyId && Number.isFinite(count)) {
        set((state) => patchStory(state, storyId, { reactions_count: count }));
      }
      return;
    }

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
