import { describe, expect, it, vi } from 'vitest';

import { createKernel } from '../../core/kernel.js';
import { attachPersistence, memoryStorageAdapter } from '../persistence.js';

import type { ConnectionPhase, ConnectionTarget, Endpoint, ReducerContext, Tokens } from '../../core/types.js';

const LAN: Endpoint = { url: 'https://nvr.local', mode: 'direct-lan', priority: 0 };
const WAN: Endpoint = { url: 'https://nvr.example.com', mode: 'direct-wan', priority: 1 };
const TOKENS: Tokens = { access: 'at', refresh: 'rt', accessExpiresAt: 9_999_999_999_000 };
const TARGET: ConnectionTarget = { endpoint: LAN, tokens: TOKENS };

function makeCtx(): ReducerContext {
  return { now: () => Date.now() };
}

const ONLINE_PHASE: ConnectionPhase = {
  kind: 'online',
  instanceId: 'a',
  target: TARGET,
};

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('attachPersistence — persist on online', () => {
  it('writes target to storage when phase enters online', async () => {
    const storage = memoryStorageAdapter();
    const onPersist = vi.fn();
    const kernel = createKernel({ context: makeCtx() });
    attachPersistence({ kernel, storage, onPersist });

    kernel.dispatch({ type: 'BOOT', instanceId: 'a' });
    kernel.dispatch({ type: 'PROBE_SUCCEEDED', endpoint: LAN, tokens: TOKENS });
    await flushMicrotasks();

    expect(onPersist).toHaveBeenCalledOnce();
    const stored = (await storage.get('camera.ui:transport:target')) as string;
    expect(stored).toBeTruthy();
    const parsed = JSON.parse(stored);
    expect(parsed.endpoint).toEqual(LAN);
    expect(parsed.tokens).toEqual(TOKENS);
    expect(parsed.version).toBe(1);
  });

  it('overwrites stored target on TOKENS_REFRESHED', async () => {
    const storage = memoryStorageAdapter();
    const kernel = createKernel({ context: makeCtx(), initial: ONLINE_PHASE });
    attachPersistence({ kernel, storage });

    const newTokens: Tokens = { access: 'at-2', refresh: 'rt-2' };
    kernel.dispatch({ type: 'TOKENS_REFRESHED', tokens: newTokens });
    await flushMicrotasks();

    const parsed = JSON.parse((await storage.get('camera.ui:transport:target')) as string);
    expect(parsed.tokens).toEqual(newTokens);
  });
});

describe('attachPersistence — clear on logout, keep on offline', () => {
  it('clears storage on RESET (idle)', async () => {
    const storage = memoryStorageAdapter({ 'camera.ui:transport:target': 'old' });
    const onClear = vi.fn();
    const kernel = createKernel({ context: makeCtx(), initial: ONLINE_PHASE });
    attachPersistence({ kernel, storage, onClear });

    kernel.dispatch({ type: 'RESET' });
    await flushMicrotasks();

    expect(onClear).toHaveBeenCalledOnce();
    expect(await storage.get('camera.ui:transport:target')).toBeNull();
  });

  it('keeps storage on offline (transient — backoff pending)', async () => {
    const storage = memoryStorageAdapter({ 'camera.ui:transport:target': 'old' });
    const kernel = createKernel({ context: makeCtx(), initial: ONLINE_PHASE });
    attachPersistence({ kernel, storage });

    kernel.dispatch({ type: 'TOKENS_INVALID', reason: 'expired', transient: true });
    await flushMicrotasks();

    // phase is now offline — credentials should still be there for the next
    // probe round to attempt with.
    expect(await storage.get('camera.ui:transport:target')).not.toBeNull();
  });
});

describe('attachPersistence — restore on attach', () => {
  it('calls onRestore with parsed target', async () => {
    const seed = JSON.stringify({
      endpoint: WAN,
      tokens: TOKENS,
      savedAt: 0,
      version: 1,
    });
    const storage = memoryStorageAdapter({ 'camera.ui:transport:target': seed });
    const onRestore = vi.fn();
    const kernel = createKernel({ context: makeCtx() });
    attachPersistence({ kernel, storage, onRestore });

    await vi.waitFor(() => expect(onRestore).toHaveBeenCalled());
    expect(onRestore).toHaveBeenCalledWith({ endpoint: WAN, tokens: TOKENS });
  });

  it('calls onRestore with null when storage is empty', async () => {
    const storage = memoryStorageAdapter();
    const onRestore = vi.fn();
    const kernel = createKernel({ context: makeCtx() });
    attachPersistence({ kernel, storage, onRestore });

    await vi.waitFor(() => expect(onRestore).toHaveBeenCalled());
    expect(onRestore).toHaveBeenCalledWith(null);
  });

  it('calls onRestore with null on malformed JSON, calls onError("parse")', async () => {
    const storage = memoryStorageAdapter({ 'camera.ui:transport:target': '{not-json' });
    const onRestore = vi.fn();
    const onError = vi.fn();
    const kernel = createKernel({ context: makeCtx() });
    attachPersistence({ kernel, storage, onRestore, onError });

    await vi.waitFor(() => expect(onRestore).toHaveBeenCalled());
    expect(onRestore).toHaveBeenCalledWith(null);
    expect(onError).toHaveBeenCalledWith('parse', expect.any(Error));
  });

  it('calls onRestore with null when persisted shape is missing fields', async () => {
    const storage = memoryStorageAdapter({ 'camera.ui:transport:target': '{"endpoint":{}}' });
    const onRestore = vi.fn();
    const kernel = createKernel({ context: makeCtx() });
    attachPersistence({ kernel, storage, onRestore });

    await vi.waitFor(() => expect(onRestore).toHaveBeenCalled());
    expect(onRestore).toHaveBeenCalledWith(null);
  });
});

describe('attachPersistence — async storage', () => {
  it('supports an async storage adapter', async () => {
    const inner = memoryStorageAdapter({
      'camera.ui:transport:target': JSON.stringify({
        endpoint: LAN,
        tokens: TOKENS,
        savedAt: 0,
        version: 1,
      }),
    });
    const asyncStorage = {
      get: vi.fn(async (k: string) => inner.get(k)),
      set: vi.fn(async (k: string, v: string) => {
        inner.set(k, v);
      }),
      del: vi.fn(async (k: string) => {
        inner.del(k);
      }),
    };

    const onRestore = vi.fn();
    const kernel = createKernel({ context: makeCtx() });
    attachPersistence({ kernel, storage: asyncStorage, onRestore });

    await vi.waitFor(() => expect(onRestore).toHaveBeenCalledWith({ endpoint: LAN, tokens: TOKENS }));
  });
});

describe('attachPersistence — detach', () => {
  it('stops persisting after detach', () => {
    const storage = memoryStorageAdapter();
    const onPersist = vi.fn();
    const kernel = createKernel({ context: makeCtx() });
    const { detach } = attachPersistence({ kernel, storage, onPersist });

    detach();

    kernel.dispatch({ type: 'BOOT', instanceId: 'a' });
    kernel.dispatch({ type: 'PROBE_SUCCEEDED', endpoint: LAN, tokens: TOKENS });

    expect(onPersist).not.toHaveBeenCalled();
  });
});

describe('attachPersistence — peek()', () => {
  it('returns null before initial restore completes (async storage)', () => {
    const asyncStorage = {
      get: () => Promise.resolve(JSON.stringify({ endpoint: LAN, tokens: TOKENS, savedAt: 1, version: 1 })),
      set: () => Promise.resolve(),
      del: () => Promise.resolve(),
    };
    const kernel = createKernel({ context: makeCtx() });
    const { peek } = attachPersistence({ kernel, storage: asyncStorage });

    // Synchronously called before microtasks flush — cache is still empty.
    expect(peek()).toBeNull();
  });

  it('returns the restored target after sync restore', async () => {
    const storage = memoryStorageAdapter({
      'camera.ui:transport:target': JSON.stringify({ endpoint: LAN, tokens: TOKENS, savedAt: 1, version: 1 }),
    });
    const kernel = createKernel({ context: makeCtx() });
    const { peek } = attachPersistence({ kernel, storage });
    await flushMicrotasks();

    const got = peek();
    expect(got).not.toBeNull();
    expect(got!.endpoint).toEqual(LAN);
    expect(got!.tokens).toEqual(TOKENS);
  });

  it('updates cache when target is persisted', async () => {
    const storage = memoryStorageAdapter();
    const kernel = createKernel({ context: makeCtx() });
    const { peek } = attachPersistence({ kernel, storage });
    await flushMicrotasks();
    expect(peek()).toBeNull();

    kernel.dispatch({ type: 'BOOT', instanceId: 'a' });
    kernel.dispatch({ type: 'PROBE_SUCCEEDED', endpoint: WAN, tokens: TOKENS });
    await flushMicrotasks();

    const got = peek();
    expect(got).not.toBeNull();
    expect(got!.endpoint).toEqual(WAN);
  });

  it('updates cache on TOKENS_REFRESHED', async () => {
    const storage = memoryStorageAdapter();
    const kernel = createKernel({ context: makeCtx(), initial: ONLINE_PHASE });
    const { peek } = attachPersistence({ kernel, storage });
    await flushMicrotasks();

    const fresh: Tokens = { access: 'at-new', refresh: 'rt-new' };
    kernel.dispatch({ type: 'TOKENS_REFRESHED', tokens: fresh });
    await flushMicrotasks();

    expect(peek()!.tokens).toEqual(fresh);
  });

  it('clears cache on logout (idle phase)', async () => {
    const storage = memoryStorageAdapter({
      'camera.ui:transport:target': JSON.stringify({ endpoint: LAN, tokens: TOKENS, savedAt: 1, version: 1 }),
    });
    const kernel = createKernel({ context: makeCtx(), initial: ONLINE_PHASE });
    const { peek } = attachPersistence({ kernel, storage });
    await flushMicrotasks();
    expect(peek()).not.toBeNull();

    kernel.dispatch({ type: 'RESET' });
    await flushMicrotasks();

    expect(peek()).toBeNull();
  });

  it('keeps cache populated through offline (backoff scenario)', async () => {
    const storage = memoryStorageAdapter({
      'camera.ui:transport:target': JSON.stringify({ endpoint: LAN, tokens: TOKENS, savedAt: 1, version: 1 }),
    });
    const kernel = createKernel({ context: makeCtx(), initial: ONLINE_PHASE });
    const { peek } = attachPersistence({ kernel, storage });
    await flushMicrotasks();

    // Network drop → offline. Cache must survive for backoff USER_RETRY.
    kernel.dispatch({ type: 'TOKENS_INVALID', reason: 'bad', transient: true });
    await flushMicrotasks();

    expect(peek()).not.toBeNull();
    expect(peek()!.endpoint).toEqual(LAN);
  });

  it('returns null when storage entry is malformed', async () => {
    const storage = memoryStorageAdapter({ 'camera.ui:transport:target': 'not-json' });
    const kernel = createKernel({ context: makeCtx() });
    const { peek } = attachPersistence({ kernel, storage });
    await flushMicrotasks();

    expect(peek()).toBeNull();
  });
});

describe('attachPersistence — seed()', () => {
  it('updates cache synchronously and persists asynchronously', async () => {
    const storage = memoryStorageAdapter();
    const kernel = createKernel({ context: makeCtx() });
    const { peek, seed } = attachPersistence({ kernel, storage });
    await flushMicrotasks();
    expect(peek()).toBeNull();

    const promise = seed(TARGET);

    // Cache is updated before the async storage write resolves.
    expect(peek()).not.toBeNull();
    expect(peek()!.endpoint).toEqual(LAN);

    await promise;

    const stored = (await storage.get('camera.ui:transport:target')) as string;
    expect(stored).toBeTruthy();
    expect(JSON.parse(stored).tokens).toEqual(TOKENS);
  });

  it('seeded target survives offline → discovering recovery via peek', async () => {
    const storage = memoryStorageAdapter();
    const kernel = createKernel({
      context: makeCtx(),
      initial: { kind: 'offline', instanceId: null, lastError: 'no tokens', nextRetryAt: Date.now() + 60_000 },
    });
    const { peek, seed } = attachPersistence({ kernel, storage });

    await seed(TARGET);

    // Probe-loop's lastTarget callback would peek() during the next USER_RETRY
    // and find the seeded target — driving probe to hit /auth/check instead
    // of throwing needs-auth.
    expect(peek()).not.toBeNull();
    expect(peek()!.tokens).toEqual(TOKENS);
  });

  it('is a no-op after detach', async () => {
    const storage = memoryStorageAdapter();
    const kernel = createKernel({ context: makeCtx() });
    const { detach, peek, seed } = attachPersistence({ kernel, storage });
    await flushMicrotasks();

    detach();
    await seed(TARGET);

    expect(peek()).toBeNull();
    expect(await storage.get('camera.ui:transport:target')).toBeNull();
  });
});

describe('attachPersistence — pendingTokens during discovering', () => {
  it('persists tokens refreshed mid-probe onto the cached endpoint', async () => {
    const target: ConnectionTarget = { endpoint: { url: 'https://nvr.local', mode: 'direct-lan' }, tokens: { access: 'at-0', refresh: 'rt-0' } };
    const kernel = createKernel({
      context: { now: () => Date.now() },
      initial: { kind: 'online', instanceId: 'a', target },
    });
    const storage = memoryStorageAdapter();
    const persistence = attachPersistence({ kernel, storage, key: 'k' });
    await persistence.seed(target);

    // discovering is only reachable via offline now
    kernel.dispatch({ type: 'TOKENS_INVALID', reason: 'net', transient: true });
    kernel.dispatch({ type: 'USER_RETRY' });
    expect(kernel.phase.kind).toBe('discovering');
    kernel.dispatch({ type: 'TOKENS_REFRESHED', tokens: { access: 'at-1', refresh: 'rt-1' } });
    await Promise.resolve();
    await Promise.resolve();

    const raw = await storage.get('k');
    const parsed = JSON.parse(raw!);
    expect(parsed.tokens.access).toBe('at-1');
    expect(parsed.endpoint.url).toBe('https://nvr.local');
    expect(persistence.peek()?.tokens.access).toBe('at-1');
    persistence.detach();
  });
});
