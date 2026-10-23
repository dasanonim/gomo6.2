import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReactNode } from 'react';
import { EmojiDataProvider, useEmojiData } from './EmojiDataContext';

// The provider fetches the current user and the user's emoji subscriptions on
// mount. Stub all of it so the test exercises resolveEmojis in isolation.
const mockRawRequest = vi.fn();
const mockRpc = vi.fn();
const mockGetUser = vi.fn();

vi.mock('@/integrations/api/client', () => ({
  apiClient: {
    rawRequest: (...args: unknown[]) => mockRawRequest(...args),
    getCurrentUser: () => Promise.resolve(null),
  },
}));

vi.mock('@/integrations/api/compat', () => ({
  api: {
    auth: {
      getUser: () => mockGetUser(),
    },
    rpc: (...args: unknown[]) => mockRpc(...args),
  },
}));

vi.mock('@/utils/emojiCache', () => ({
  loadEmojiCache: () => null,
  saveEmojiCache: () => {},
}));

// TanStack Query is used for the shared auth query; give it a real client.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}><EmojiDataProvider>{children}</EmojiDataProvider></QueryClientProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Signed-in user so the subscriptions fetch path runs (and fails fast).
  mockGetUser.mockResolvedValue({ data: { user: { id: 'u-1' } } });
  mockRawRequest.mockRejectedValue(new Error('Rate limit exceeded. Please slow down.'));
  mockRpc.mockRejectedValue(new Error('Rate limit exceeded. Please slow down.'));
});

describe('EmojiDataContext resolveEmojis failure', () => {
  it('marks ids as failed on error so components stop re-requesting', async () => {
    const { result } = renderHook(() => useEmojiData(), { wrapper });

    await act(async () => {
      await result.current.resolveEmojis(['emoji-1']);
    });

    // A failed resolve must record the id as failed — otherwise every render
    // of EmojiInline/CustomEmojiNode re-fires the request (REST + RPC = 2
    // requests per emoji per render), turning a 429 into a self-sustaining
    // storm that burns the global rate-limit budget.
    await waitFor(() => {
      expect(result.current.failedEmojiIds.has('emoji-1')).toBe(true);
    });

    // Subsequent calls with the same id are no-ops (no network traffic).
    const callsBefore = mockRawRequest.mock.calls.length + mockRpc.mock.calls.length;
    await act(async () => {
      await result.current.resolveEmojis(['emoji-1']);
    });
    expect(mockRawRequest.mock.calls.length + mockRpc.mock.calls.length).toBe(callsBefore);
  });

  it('still resolves emojis when the REST path succeeds', async () => {
    mockRawRequest.mockResolvedValue({
      data: [{ id: 'emoji-2', pack_id: 'p', name: 'e', image_url: '/e.webp', is_animated: false }],
    });

    const { result } = renderHook(() => useEmojiData(), { wrapper });

    await act(async () => {
      await result.current.resolveEmojis(['emoji-2']);
    });

    await waitFor(() => {
      expect(result.current.allEmojis.has('emoji-2')).toBe(true);
    });
    expect(result.current.failedEmojiIds.has('emoji-2')).toBe(false);
  });
});

describe('EmojiDataContext subscriptions loading', () => {
  it('collapses concurrent refreshes onto one subscriptions pair', async () => {
    // Mount load fails (default mock) so no TTL snapshot exists; the two
    // racing refreshes must then share a single in-flight load.
    const { result } = renderHook(() => useEmojiData(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    mockRawRequest.mockResolvedValue({ data: [] });
    mockRawRequest.mockClear();

    // Two background refreshes racing (mount/auth/focus drivers firing at
    // once) must share a single in-flight load: one subscriptions call + one
    // owned-packs call, not two pairs.
    await act(async () => {
      await Promise.all([result.current.refreshData(), result.current.refreshData()]);
    });

    expect(mockRawRequest).toHaveBeenCalledTimes(2);
  });

  it('reuses a fresh snapshot instead of refetching', async () => {
    mockRawRequest.mockResolvedValue({ data: [] });

    const { result } = renderHook(() => useEmojiData(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    const afterMount = mockRawRequest.mock.calls.length;

    await act(async () => {
      await result.current.refreshData();
    });

    // Mount already loaded for this user within the TTL: no new traffic.
    expect(mockRawRequest.mock.calls.length).toBe(afterMount);
  });
});
