import type { Kernel } from '../core/kernel.js';
import type { ConnectionTarget } from '../core/types.js';

export type Detach = () => void;

export interface StorageAdapter {
  get(key: string): string | null | Promise<string | null>;
  set(key: string, value: string): void | Promise<void>;
  del(key: string): void | Promise<void>;
}

export interface PersistedTarget {
  readonly endpoint: ConnectionTarget['endpoint'];
  readonly tokens: ConnectionTarget['tokens'];
  readonly savedAt: number;
  readonly version: 1;
}

export interface Persistence {
  readonly detach: Detach;
  peek(): ConnectionTarget | null;
  seed(target: ConnectionTarget): Promise<void>;
  absorb(target: ConnectionTarget | null): void;
}

export interface PersistenceOptions {
  readonly kernel: Kernel;
  readonly storage: StorageAdapter;
  readonly key?: string;
  readonly onRestore?: (restored: ConnectionTarget | null) => void;
  readonly onPersist?: (target: ConnectionTarget) => void;
  readonly onClear?: () => void;
  readonly onError?: (op: 'get' | 'set' | 'del' | 'parse', err: unknown) => void;
}

const DEFAULT_KEY = 'camera.ui:transport:target';

export function attachPersistence(options: PersistenceOptions): Persistence {
  const key = options.key ?? DEFAULT_KEY;
  const onError = options.onError ?? (() => {});

  let detached = false;
  let cached: ConnectionTarget | null = null;

  restore();

  async function restore(): Promise<void> {
    let raw: string | null;
    try {
      raw = await options.storage.get(key);
    } catch (err) {
      onError('get', err);
      raw = null;
    }
    if (detached) return;
    // Don't clobber the cache if an external seed() / persist() landed
    // between attach and this async storage.get resolving. The freshest
    // writer wins — restore is only authoritative when nothing else has
    // populated cache yet.
    if (cached !== null) {
      options.onRestore?.(cached);
      return;
    }
    if (!raw) {
      options.onRestore?.(null);
      return;
    }
    try {
      const parsed = JSON.parse(raw) as PersistedTarget;
      if (!parsed?.endpoint?.url || !parsed?.tokens?.access) {
        options.onRestore?.(null);
        return;
      }
      cached = { endpoint: parsed.endpoint, tokens: parsed.tokens };
      options.onRestore?.(cached);
    } catch (err) {
      onError('parse', err);
      options.onRestore?.(null);
    }
  }

  async function persist(target: ConnectionTarget): Promise<void> {
    const payload: PersistedTarget = {
      endpoint: target.endpoint,
      tokens: target.tokens,
      savedAt: Date.now(),
      version: 1,
    };
    cached = { endpoint: target.endpoint, tokens: target.tokens };
    try {
      await options.storage.set(key, JSON.stringify(payload));
      options.onPersist?.(target);
    } catch (err) {
      onError('set', err);
    }
  }

  async function clear(): Promise<void> {
    cached = null;
    try {
      await options.storage.del(key);
      options.onClear?.();
    } catch (err) {
      onError('del', err);
    }
  }

  const unsub = options.kernel.subscribe((next, prev) => {
    if (detached) return;
    // tokens rotated mid-probe: single-use refresh tokens make losing this
    // write a forced logout on the next boot
    if (next.kind === 'discovering' && next.pendingTokens && (prev.kind !== 'discovering' || prev.pendingTokens !== next.pendingTokens)) {
      if (cached) persist({ endpoint: cached.endpoint, tokens: next.pendingTokens });
      return;
    }
    const nextTarget = next.kind === 'online' ? next.target : null;
    const prevTarget = prev.kind === 'online' ? prev.target : null;

    if (nextTarget && nextTarget !== prevTarget) {
      persist(nextTarget);
      return;
    }
    if (next.kind === 'idle' && prev.kind !== 'idle') {
      clear();
    }
  });

  return {
    detach: () => {
      detached = true;
      unsub();
    },
    peek: () => cached,
    seed: async (target) => {
      if (detached) return;
      await persist(target);
    },
    absorb: (target) => {
      if (detached) return;
      cached = target;
    },
  };
}

export function localStorageAdapter(scope: Storage = globalThis.localStorage): StorageAdapter {
  if (!scope) {
    throw new Error('localStorageAdapter: localStorage is not available in this environment');
  }
  return {
    get(k) {
      return scope.getItem(k);
    },
    set(k, v) {
      scope.setItem(k, v);
    },
    del(k) {
      scope.removeItem(k);
    },
  };
}

export function memoryStorageAdapter(initial: Record<string, string> = {}): StorageAdapter {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    get(k) {
      return store.get(k) ?? null;
    },
    set(k, v) {
      store.set(k, v);
    },
    del(k) {
      store.delete(k);
    },
  };
}
