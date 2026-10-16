import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDebouncedCache } from '../createDebouncedCache.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createDebouncedCache', () => {
  it('keeps an entry that was acquired again after a double release', async () => {
    const onRelease = vi.fn();
    const cache = createDebouncedCache<object>({ releaseDelay: 1_000, onRelease });

    cache.acquire('k', () => ({}));
    cache.release('k');
    cache.release('k');
    expect(cache.getRefCount('k')).toBe(0);

    cache.acquire('k', () => ({}));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(onRelease).not.toHaveBeenCalled();
    expect(cache.getRefCount('k')).toBe(1);
  });

  it('frees an entry once, a delay after its last release', async () => {
    const onRelease = vi.fn();
    const cache = createDebouncedCache<object>({ releaseDelay: 1_000, onRelease });

    cache.acquire('k', () => ({}));
    cache.acquire('k', () => ({}));
    cache.release('k');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onRelease).not.toHaveBeenCalled();

    cache.release('k');
    cache.release('k');
    await vi.advanceTimersByTimeAsync(999);
    expect(onRelease).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onRelease).toHaveBeenCalledTimes(1);
    expect(cache.has('k')).toBe(false);
  });

  it('ignores the release of a holder whose entry was replaced', async () => {
    const onRelease = vi.fn();
    const cache = createDebouncedCache<object>({ releaseDelay: 1_000, onRelease });

    const stale = cache.acquire('k', () => ({}));
    cache.clear();
    const current = cache.acquire('k', () => ({}));
    onRelease.mockClear();

    cache.release('k', stale);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(onRelease).not.toHaveBeenCalled();
    expect(cache.get('k')).toBe(current);
    expect(cache.getRefCount('k')).toBe(1);

    cache.release('k', current);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onRelease).toHaveBeenCalledWith('k', current);
  });
});
