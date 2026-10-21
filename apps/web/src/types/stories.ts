/** Shared shapes of the stories API. Keep in sync with
 * apps/backend-go/internal/stories/stories.go — the server owns timestamps,
 * expiry and counters; the client only renders. */

export type StoryOwnerType = "user" | "gosub";
export type StoryKind = "photo" | "video" | "text";
export type StoryPrivacy = "everyone" | "friends" | "close_friends" | "only_me";
export type StoryScope = "live" | "pinned" | "archive";

/** The closed set of quick reactions the server accepts. */
export const STORY_REACTIONS = ["❤️", "🔥", "😂", "😮", "😢", "👏", "🎉", "💯"] as const;
export type StoryReaction = (typeof STORY_REACTIONS)[number];

/** Presets for a text story. The server stores this blob verbatim; the viewer
 * renders it, so an unknown preset falls back to the first one. */
export type StoryTextStyle = {
  preset?: string;
  align?: "left" | "center" | "right";
};

export interface StoryAuthor {
  id: string;
  username: string;
  display_name?: string | null;
  avatar_url?: string | null;
  avatar_animated: boolean;
}

export interface StoryOwner {
  type: StoryOwnerType;
  id: string;
  name: string;
  username?: string;
  slug?: string;
  avatar_url?: string | null;
  avatar_animated?: boolean;
}

export interface Story {
  id: string;
  owner_type: StoryOwnerType;
  owner_id: string;
  author_id: string;
  author?: StoryAuthor;
  kind: StoryKind;
  media_key?: string;
  preview_key?: string;
  thumb_hash?: string;
  width?: number;
  height?: number;
  duration?: number;
  content_type?: string;
  text: string;
  text_style?: StoryTextStyle;
  privacy: StoryPrivacy;
  is_pinned: boolean;
  views_count: number;
  reactions_count: number;
  created_at: string;
  expires_at: string;
  is_viewed: boolean;
  is_own: boolean;
  my_reaction?: string | null;
}

export interface StoryGroup {
  owner: StoryOwner;
  stories: Story[];
  has_unread: boolean;
}

export interface StoryViewerEntry {
  user: StoryAuthor;
  viewed_at: string;
}

export interface StoryViewersPage {
  viewers: StoryViewerEntry[];
  next_before?: string;
}

export interface CreateStoryInput {
  owner_type: StoryOwnerType;
  board_id?: string;
  kind: StoryKind;
  media_key?: string;
  preview_key?: string;
  thumb_hash?: string;
  width?: number;
  height?: number;
  duration?: number;
  content_type?: string;
  text?: string;
  text_style?: StoryTextStyle;
  privacy?: StoryPrivacy;
}

export interface UpdateStoryInput {
  privacy?: StoryPrivacy;
  is_pinned?: boolean;
}

/** Owner identity helpers used across the store/components. */
export function ownerKey(type: StoryOwnerType, id: string): string {
  return `${type}:${id}`;
}

export function splitOwnerKey(key: string): { type: StoryOwnerType; id: string } {
  const idx = key.indexOf(":");
  return {
    type: (idx === -1 ? key : key.slice(0, idx)) as StoryOwnerType,
    id: idx === -1 ? "" : key.slice(idx + 1),
  };
}

/** Number of read vs total segments a ring should draw. */
export function ringSegments(stories: Story[]): { total: number; read: number } {
  let read = 0;
  for (const story of stories) {
    if (story.is_viewed) read += 1;
  }
  return { total: stories.length, read };
}

/** True when at least one unread slide is a close-friends one (green ring). */
export function hasUnreadCloseFriends(stories: Story[]): boolean {
  return stories.some((s) => !s.is_viewed && s.privacy === "close_friends" && !s.is_own);
}

/** Live for the ring: the server already filters expiry, but a tab can sit
 * open for hours, so the ring must not keep painting an expired slide. */
export function isStoryLive(story: Story, now = Date.now()): boolean {
  return new Date(story.expires_at).getTime() > now;
}

/** Slide currently on screen, and where the next tap should go. */
export function nextStoryIndex(index: number, total: number): number {
  return index + 1 < total ? index + 1 : -1;
}

export function prevStoryIndex(index: number): number {
  return index - 1;
}
