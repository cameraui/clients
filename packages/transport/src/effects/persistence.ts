import type { Kernel } from '../core/kernel.js';
import type { ConnectionPhase, ConnectionTarget, Tokens } from '../core/types.js';

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
  readonly ready: Promise<void>;
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
  readonly readyTimeoutMs?: number;
}

const DEFAULT_KEY = 'camera.ui:transport:target';
const DEFAULT_READY_TIMEOUT_MS = 3_000;

export function attachPersistence(options: PersistenceOptions): Persistence {
  const key = options.key ?? DEFAULT_KEY;
  const onError = options.onError ?? (() => {});
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;

  let detached = false;
  let cached: ConnectionTarget | null = null;
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  let settleReady!: () => void;

  const ready = new Promise<void>((resolve) => {
    settleReady = () => {
      clearTimeout(readyTimer);
      resolve();
    };
  });
  // probes wait on ready, a storage bridge whose read never settles must not hold them forever
  if (readyTimeoutMs > 0 && Number.isFinite(readyTimeoutMs)) readyTimer = setTimeout(settleReady, readyTimeoutMs);
  restore().then(settleReady, settleReady);

  async function restore(): Promise<void> {
    let raw: string | null = null;
    // a failed read reads as "no session" and sends the user to the login, so try once more
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        raw = await options.storage.get(key);
        break;
      } catch (err) {
        onError('get', err);
      }
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
    // tokens rotated mid-probe or after the drop: single-use refresh tokens
    // make losing this write a forced logout on the next boot
    const pending = pendingTokensOf(next);
    if (pending && pending !== pendingTokensOf(prev)) {
      if (cached) persist({ endpoint: cached.endpoint, tokens: pending });
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
      settleReady();
      unsub();
    },
    ready,
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

function pendingTokensOf(phase: ConnectionPhase): Tokens | undefined {
  return phase.kind === 'discovering' || phase.kind === 'offline' ? phase.pendingTokens : undefined;
}

export function localStorageAdapter(scope?: Storage): StorageAdapter {
  if (!scope) {
    try {
      // blocked site data throws on the bare property access
      scope = globalThis.localStorage;
    } catch {
      // ignore
    }
  }
  if (!scope) return memoryStorageAdapter();
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
