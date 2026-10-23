import React, { createContext, useContext, useCallback, useMemo } from 'react';
import {
  getCachedProfileSummary,
  invalidateProfileSummaries,
  requestProfileSummary,
  type ProfileSummary,
} from '@/utils/profileSummaryLoader';

interface ProfileData {
  /** Canonical user id (uuid) the row was resolved to. */
  id?: string;
  username: string;
  customization: unknown;
  isAdmin: boolean;
  avatarUrl?: string;
  nickname_emoji_id?: string | null;
  /** Public number of the viewed profile, for /profile/<n> links. */
  public_id?: number | null;
}

interface ProfileCacheContextType {
  getProfile: (userId: string) => ProfileData | null;
  loadProfile: (userId: string | undefined) => Promise<ProfileData>;
  clearCache: () => void;
}

const ProfileCacheContext = createContext<ProfileCacheContextType | null>(null);

const EMPTY_PROFILE: ProfileData = {
  username: '',
  customization: null,
  isAdmin: false,
  avatarUrl: undefined,
};

const toProfileData = (summary: ProfileSummary): ProfileData => ({
  id: summary.id,
  username: summary.username ?? '',
  customization: summary.customization ?? null,
  isAdmin: Boolean(summary.is_admin),
  avatarUrl: summary.avatar_url || undefined,
  nickname_emoji_id: summary.nickname_emoji_id ?? null,
  public_id: summary.public_id ?? null,
});

/**
 * Profiles for every badge/card on screen.
 *
 * The actual fetching/coalescing/caching lives in utils/profileSummaryLoader,
 * which batches every `loadProfile` call of the same tick into one
 * `/api/v1/profiles/summary` request (instead of three requests per author).
 * This provider keeps the original, already-used API (`getProfile`,
 * `loadProfile`, `clearCache`) so call sites did not have to change.
 *
 * `getProfile` is a synchronous cache read: callers that need fresh data use
 * `loadProfile` and render from its promise. Both callbacks are intentionally
 * stable — the old implementation re-created them on every cache write, which
 * restarted every mounted badge effect.
 */
export const ProfileCacheProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const getProfile = useCallback((userId: string): ProfileData | null => {
    const summary = getCachedProfileSummary(userId);
    return summary ? toProfileData(summary) : null;
  }, []);

  const loadProfile = useCallback(async (userId: string | undefined): Promise<ProfileData> => {
    if (!userId) return EMPTY_PROFILE;
    const summary = await requestProfileSummary(userId);
    return summary ? toProfileData(summary) : EMPTY_PROFILE;
  }, []);

  const clearCache = useCallback(() => {
    invalidateProfileSummaries();
  }, []);

  const value = useMemo(
    () => ({ getProfile, loadProfile, clearCache }),
    [getProfile, loadProfile, clearCache],
  );

  return <ProfileCacheContext.Provider value={value}>{children}</ProfileCacheContext.Provider>;
};

export const useProfileCache = () => {
  const context = useContext(ProfileCacheContext);
  if (!context) {
    throw new Error('useProfileCache must be used within ProfileCacheProvider');
  }
  return context;
};
