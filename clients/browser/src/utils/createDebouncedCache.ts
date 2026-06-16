export interface DebouncedCacheOptions<T> {
  releaseDelay?: number;
  onRelease?: (key: string, value: T) => void | Promise<void>;
}

export interface DebouncedCache<T> {
  acquire(key: string, create: () => T): T;
  release(key: string): void;
  get(key: string): T | undefined;
  has(key: string): boolean;
  forceRelease(key: string): void;
  clear(): void;
  getRefCount(key: string): number;
  forEachValue(cb: (value: T, key: string) => void): void;
}

interface CacheEntry<T> {
  value: T;
  refCount: number;
}

export function createDebouncedCache<T>(options: DebouncedCacheOptions<T> = {}): DebouncedCache<T> {
  const { releaseDelay = 1000, onRelease } = options;

  const cache = new Map<string, CacheEntry<T>>();
  const releaseTimers = new Map<string, NodeJS.Timeout>();

  function cancelTimer(key: string): void {
    const timer = releaseTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      releaseTimers.delete(key);
    }
  }

  function doRelease(key: string): void {
    const entry = cache.get(key);
    if (entry) {
      try {
        onRelease?.(key, entry.value);
      } catch {
        // Ignore cleanup errors
      }
      cache.delete(key);
    }
    releaseTimers.delete(key);
  }

  function acquire(key: string, create: () => T): T {
    cancelTimer(key);

    const cached = cache.get(key);
    if (cached) {
      cached.refCount++;
      return cached.value;
    }

    const value = create();
    cache.set(key, { value, refCount: 1 });
    return value;
  }

  function release(key: string): void {
    const cached = cache.get(key);
    if (!cached) return;

    cached.refCount--;
    if (cached.refCount <= 0) {
      const timer = setTimeout(() => {
        const stillCached = cache.get(key);
        if (stillCached && stillCached.refCount <= 0) {
          doRelease(key);
        } else {
          releaseTimers.delete(key);
        }
      }, releaseDelay);

      releaseTimers.set(key, timer);
    }
  }

  function get(key: string): T | undefined {
    return cache.get(key)?.value;
  }

  function has(key: string): boolean {
    return cache.has(key);
  }

  function forceRelease(key: string): void {
    cancelTimer(key);
    doRelease(key);
  }

  function clear(): void {
    for (const key of releaseTimers.keys()) {
      cancelTimer(key);
    }
    for (const key of cache.keys()) {
      doRelease(key);
    }
  }

  function getRefCount(key: string): number {
    return cache.get(key)?.refCount ?? 0;
  }

  function forEachValue(cb: (value: T, key: string) => void): void {
    for (const [key, entry] of cache) {
      cb(entry.value, key);
    }
  }

  return {
    acquire,
    release,
    get,
    has,
    forceRelease,
    clear,
    getRefCount,
    forEachValue,
  };
}
