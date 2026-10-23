import {
  invalidateProfileSummary,
  invalidateProfileSummaries,
  requestProfileSummary,
} from "@/utils/profileSummaryLoader";
import { PROFILE_CACHE_INVALIDATE_EVENT } from "@/utils/profileCacheEvents";

export interface ProfileCustomization {
  username_css: string | null;
  profile_badge_text: string | null;
  profile_badge_css: string | null;
  background_url: string | null;
}

/**
 * A user's public display customization (nickname CSS, badge, background).
 *
 * The data comes from the batched `/api/v1/profiles/summary` loader: a badge
 * rendering 20 authors no longer issues 20 per-user customization requests —
 * every `getProfileCustomization` call in the same tick shares one batch. The
 * module-level cache, TTL and invalidation generations also live there, so this
 * function is only the typed projection every caller already uses.
 *
 * The generic `/profile_customization` table cannot serve this: it is scoped to
 * the caller's own user_id, so a foreign row always came back empty. The public
 * summary endpoint returns the display subset for any viewer, sanitized on the
 * server with the same profile sanitizer as the owner's own read path.
 */
export const getProfileCustomization = async (userId: string): Promise<ProfileCustomization | null> => {
  const summary = await requestProfileSummary(userId);
  return (summary?.customization as ProfileCustomization | null) ?? null;
};

export const parseCssToStyle = (css: string): React.CSSProperties => {
  const style: React.CSSProperties = {};

  if (!css) return style;

  const declarations = css.split(';').filter(s => s.trim());

  declarations.forEach(decl => {
    // Split on first colon only, as values may contain colons (e.g., url(...), rgba(...))
    const colonIndex = decl.indexOf(':');
    if (colonIndex === -1) return;

    const property = decl.substring(0, colonIndex).trim();
    const value = decl.substring(colonIndex + 1).trim();

    if (!property || !value) return;

    // Convert CSS property to React style property
    const reactProperty = property
      .replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
      .replace(/^webkit/, 'Webkit')
      .replace(/^moz/, 'Moz')
      .replace(/^ms/, 'Ms');

    // Handle special cases
    if (reactProperty === 'webkitBackgroundClip') {
      style.WebkitBackgroundClip = value as string;
    } else if (reactProperty === 'webkitTextFillColor') {
      style.WebkitTextFillColor = value as string;
    } else if (reactProperty === 'background') {
      style.background = value;
    } else if (reactProperty === 'backgroundImage') {
      style.backgroundImage = value;
    } else if (reactProperty === 'backgroundColor') {
      style.backgroundColor = value;
    } else if (reactProperty === 'color') {
      style.color = value;
    } else if (reactProperty === 'textShadow') {
      style.textShadow = value;
    } else if (reactProperty === 'boxShadow') {
      style.boxShadow = value;
    } else if (reactProperty === 'borderRadius') {
      style.borderRadius = value;
    } else {
      (style as Record<string, string | undefined>)[reactProperty] = value;
    }
  });

  return style;
};

/** Drops the cached display data for one user, or everything when omitted. */
export const clearCustomizationCache = (userId?: string) => {
  if (userId) {
    invalidateProfileSummary(userId);
    return;
  }
  invalidateProfileSummaries();
};

/**
 * Broadcast that a profile changed (username, avatar, display name, nickname
 * emoji, customization...). This is the single entry point every profile
 * mutation must call:
 *  - clears the relevant summary/customization cache entry, and
 *  - dispatches a DOM event that ProfileCacheContext, currentUserMeta and the
 *    other client-side profile caches listen to, so they reset together.
 *
 * Pass `userId` to scope the invalidation to one profile (the server sends it
 * with every profile_updated broadcast). Listeners that only hold that user's
 * data then skip their refetch, so one person editing their nickname no longer
 * makes every viewer re-fetch every mounted badge. Omitting it keeps the old
 * whole-cache reset, which the editor's own save still wants.
 */
export const dispatchProfileCacheInvalidate = (userId?: string) => {
  clearCustomizationCache(userId);
  window.dispatchEvent(new CustomEvent(PROFILE_CACHE_INVALIDATE_EVENT, { detail: { userId } }));
};
