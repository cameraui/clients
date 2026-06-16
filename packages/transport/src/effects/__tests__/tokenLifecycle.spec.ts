import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createKernel } from '../../core/kernel.js';
import { FakeTransport } from '../../testing/fakeTransport.js';
import { attachTokenLifecycle } from '../tokenLifecycle.js';

import type { ConnectionPhase, Endpoint, ReducerContext, Tokens, TransportSpec } from '../../core/types.js';

const LAN: Endpoint = { url: 'https://nvr.local', mode: 'direct-lan' };
const T0 = 1_000_000;

const SPECS: ReadonlyMap<string, TransportSpec> = new Map([
  ['http', { id: 'http', kind: 'request', phaseGating: false }],
  ['socketio', { id: 'socketio', kind: 'persistent', phaseGating: true }],
]);

function makeCtx(): ReducerContext {
  return { specs: SPECS, now: () => Date.now() };
}

function onlineWith(expiresAt: number): ConnectionPhase {
  return {
    kind: 'online',
    instanceId: 'a',
    target: {
      endpoint: LAN,
      tokens: { access: 'at-0', refresh: 'rt-0', accessExpiresAt: expiresAt },
    },
    transports: new Map(),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('attachTokenLifecycle — proactive', () => {
  it('schedules refresh at expiresAt - graceMs', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlineWith(T0 + 30_000) });
    const refresh = vi.fn().mockResolvedValue({ access: 'at-1', refresh: 'rt-1', accessExpiresAt: T0 + 60_000 } satisfies Tokens);
    attachTokenLifecycle({ kernel, transports: [], refresh, graceMs: 5_000 });

    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(24_999);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith(expect.objectContaining({ endpoint: LAN }), 'proactive');
  });

  it('dispatches TOKENS_REFRESHED on successful refresh', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlineWith(T0 + 30_000) });
    const newTokens: Tokens = { access: 'at-1', refresh: 'rt-1', accessExpiresAt: T0 + 60_000 };
    attachTokenLifecycle({
      kernel,
      transports: [],
      refresh: async () => newTokens,
      graceMs: 5_000,
    });
    await vi.advanceTimersByTimeAsync(25_001);
    await vi.runOnlyPendingTimersAsync();
    expect(kernel.phase.kind).toBe('online');
    if (kernel.phase.kind === 'online') {
      expect(kernel.phase.target.tokens).toEqual(newTokens);
    }
  });

  it('dispatches TOKENS_INVALID + phase → needs-auth on failed refresh', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlineWith(T0 + 30_000) });
    attachTokenLifecycle({
      kernel,
      transports: [],
      refresh: async () => {
        throw new Error('401-bad-refresh');
      },
      graceMs: 5_000,
    });
    await vi.advanceTimersByTimeAsync(25_001);
    await vi.runOnlyPendingTimersAsync();
    expect(kernel.phase.kind).toBe('needs-auth');
    if (kernel.phase.kind === 'needs-auth') {
      expect(kernel.phase.reason).toContain('401-bad-refresh');
    }
  });

  it('reschedules after a successful refresh based on new accessExpiresAt', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlineWith(T0 + 30_000) });
    const refresh = vi
      .fn()
      .mockResolvedValueOnce({ access: 'at-1', accessExpiresAt: T0 + 60_000 } satisfies Tokens)
      .mockResolvedValueOnce({ access: 'at-2', accessExpiresAt: T0 + 90_000 } satisfies Tokens);
    attachTokenLifecycle({ kernel, transports: [], refresh, graceMs: 5_000 });

    await vi.advanceTimersByTimeAsync(25_001);
    expect(refresh).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('cancels timer when phase leaves online', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlineWith(T0 + 30_000) });
    const refresh = vi.fn();
    attachTokenLifecycle({ kernel, transports: [], refresh, graceMs: 5_000 });

    kernel.dispatch({ type: 'RESET' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('attachTokenLifecycle — auth-error reactive', () => {
  it('triggers refresh immediately when transport emits auth-error', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlineWith(T0 + 30_000) });
    const transport = new FakeTransport({ spec: { id: 'http', kind: 'request', phaseGating: false } });
    const refresh = vi.fn().mockResolvedValue({ access: 'at-1', accessExpiresAt: T0 + 60_000 } satisfies Tokens);
    attachTokenLifecycle({ kernel, transports: [transport], refresh, graceMs: 5_000 });

    transport.emitAuthError(401);
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    await Promise.resolve();

    expect(refresh).toHaveBeenCalledWith(expect.anything(), 'auth-error');
  });

  it('queues auth-error fired while a proactive refresh is in-flight, runs it after', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlineWith(T0 + 6_000) });
    const transport = new FakeTransport({ spec: { id: 'http', kind: 'request', phaseGating: false } });
    const resolvers: Array<(t: Tokens) => void> = [];
    const refresh = vi.fn(
      () =>
        new Promise<Tokens>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    attachTokenLifecycle({ kernel, transports: [transport], refresh, graceMs: 5_000 });

    // Trigger proactive (waits for the timer).
    await vi.advanceTimersByTimeAsync(1_001);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenLastCalledWith(expect.anything(), 'proactive');

    // Auth-error fires while proactive is still in flight — must be queued,
    // not silently dropped.
    transport.emitAuthError(401);
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);

    // Resolve the proactive refresh — finally block should drain the pending
    // auth-error and re-fire.
    resolvers[0]!({ access: 'at-1', accessExpiresAt: T0 + 60_000 });
    await Promise.resolve();
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenLastCalledWith(expect.anything(), 'auth-error');

    resolvers[1]!({ access: 'at-2', accessExpiresAt: T0 + 90_000 });
    await Promise.resolve();
  });

  it('only queues ONE auth-error trigger even if multiple fire while inflight', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlineWith(T0 + 6_000) });
    const transport = new FakeTransport({ spec: { id: 'http', kind: 'request', phaseGating: false } });
    const resolvers: Array<(t: Tokens) => void> = [];
    const refresh = vi.fn(
      () =>
        new Promise<Tokens>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    attachTokenLifecycle({ kernel, transports: [transport], refresh, graceMs: 5_000 });

    await vi.advanceTimersByTimeAsync(1_001);
    expect(refresh).toHaveBeenCalledTimes(1);

    transport.emitAuthError(401);
    transport.emitAuthError(401);
    transport.emitAuthError(401);
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);

    resolvers[0]!({ access: 'at-1', accessExpiresAt: T0 + 60_000 });
    await Promise.resolve();
    await Promise.resolve();
    // Three auth-errors collapse to one queued follow-up.
    expect(refresh).toHaveBeenCalledTimes(2);

    resolvers[1]!({ access: 'at-2', accessExpiresAt: T0 + 90_000 });
    await Promise.resolve();
  });

  it('does not queue proactive triggers that arrive while inflight', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlineWith(T0 + 6_000) });
    const transport = new FakeTransport({ spec: { id: 'http', kind: 'request', phaseGating: false } });
    const resolvers: Array<(t: Tokens) => void> = [];
    const refresh = vi.fn(
      () =>
        new Promise<Tokens>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    attachTokenLifecycle({ kernel, transports: [transport], refresh, graceMs: 5_000 });

    // Trigger auth-error first.
    transport.emitAuthError(401);
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);

    // Advance time so the proactive timer would fire — should be no-op while
    // auth-error is in-flight.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(refresh).toHaveBeenCalledTimes(1);

    resolvers[0]!({ access: 'at-1', accessExpiresAt: T0 + 60_000 });
    await Promise.resolve();
    await Promise.resolve();
    // No queued proactive — refresh stays at 1.
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('attachTokenLifecycle — transient errors', () => {
  it('retries transient failures and stays online while retries remain', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlineWith(T0 + 30_000) });
    const refresh = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('network'), { transient: true }))
      .mockResolvedValueOnce({ access: 'at-1', accessExpiresAt: T0 + 60_000 } satisfies Tokens);
    attachTokenLifecycle({
      kernel,
      transports: [],
      refresh,
      graceMs: 5_000,
      transientRetryDelayMs: 1_000,
      maxTransientRetries: 3,
      isTransientError: (err: any) => err?.transient === true,
    });

    await vi.advanceTimersByTimeAsync(25_001);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(kernel.phase.kind).toBe('online');

    await vi.advanceTimersByTimeAsync(1_001);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(kernel.phase.kind).toBe('online');
    if (kernel.phase.kind === 'online') {
      expect(kernel.phase.target.tokens.access).toBe('at-1');
    }
  });

  it('gives up after maxTransientRetries and dispatches TOKENS_INVALID', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlineWith(T0 + 30_000) });
    const refresh = vi.fn().mockRejectedValue(Object.assign(new Error('network'), { transient: true }));
    attachTokenLifecycle({
      kernel,
      transports: [],
      refresh,
      graceMs: 5_000,
      transientRetryDelayMs: 1_000,
      maxTransientRetries: 2,
      isTransientError: (err: any) => err?.transient === true,
    });

    await vi.advanceTimersByTimeAsync(25_001);
    await vi.advanceTimersByTimeAsync(1_001);
    await vi.advanceTimersByTimeAsync(1_001);

    expect(refresh).toHaveBeenCalledTimes(3);
    // Transient retries exhausted → still routed as `offline` + backoff.
    // The refresh-token itself may still be valid; only the network is hosed.
    expect(kernel.phase.kind).toBe('offline');
  });

  it('permanent error bypasses retry and goes straight to needs-auth', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlineWith(T0 + 30_000) });
    const refresh = vi.fn().mockRejectedValue(new Error('401'));
    attachTokenLifecycle({
      kernel,
      transports: [],
      refresh,
      graceMs: 5_000,
      maxTransientRetries: 5,
      isTransientError: () => false,
    });

    await vi.advanceTimersByTimeAsync(25_001);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(kernel.phase.kind).toBe('needs-auth');
  });

  it('resets retry counter after a successful refresh', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlineWith(T0 + 30_000) });
    const transport = new FakeTransport({ spec: { id: 'http', kind: 'request', phaseGating: false } });
    const refresh = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('net'), { transient: true }))
      .mockResolvedValueOnce({ access: 'at-1', accessExpiresAt: T0 + 60_000 } satisfies Tokens)
      .mockRejectedValueOnce(Object.assign(new Error('net'), { transient: true }));
    attachTokenLifecycle({
      kernel,
      transports: [transport],
      refresh,
      graceMs: 5_000,
      transientRetryDelayMs: 1_000,
      maxTransientRetries: 1,
      isTransientError: (err: any) => err?.transient === true,
    });

    // Proactive fires: fail → retry budget consumed; retry: success → counter resets
    await vi.advanceTimersByTimeAsync(25_001);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(kernel.phase.kind).toBe('online');

    // auth-error trigger fails — with a fresh retry budget, must stay online (not go offline)
    transport.emitAuthError(401);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(kernel.phase.kind).toBe('online');
  });
});

describe('attachTokenLifecycle — wake (visibility-resume hook)', () => {
  async function flushMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  it('triggers a refresh when the AT is inside the grace window at wake time', async () => {
    // AT expires at T0+30s, graceMs=5s → grace boundary at T0+25s.
    const kernel = createKernel({ context: makeCtx(), initial: onlineWith(T0 + 30_000) });
    const refresh = vi.fn().mockResolvedValue({ access: 'at-1', accessExpiresAt: T0 + 90_000 } satisfies Tokens);
    const lc = attachTokenLifecycle({ kernel, transports: [], refresh, graceMs: 5_000 });

    // Jump past the grace boundary WITHOUT advancing fake timers — models
    // Capacitor's "JS frozen during suspend" behavior.
    vi.setSystemTime(T0 + 26_000);
    lc.wake();
    await flushMicrotasks();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith(expect.anything(), 'proactive');
  });

  it('triggers a refresh when the AT is already expired', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlineWith(T0 + 30_000) });
    const refresh = vi.fn().mockResolvedValue({ access: 'at-1', accessExpiresAt: T0 + 200_000 } satisfies Tokens);
    const lc = attachTokenLifecycle({ kernel, transports: [], refresh, graceMs: 5_000 });

    // 3h past expiry — extreme suspend case.
    vi.setSystemTime(T0 + 3 * 60 * 60_000);
    lc.wake();
    await flushMicrotasks();

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when the AT still has plenty of life left', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlineWith(T0 + 30_000) });
    const refresh = vi.fn().mockResolvedValue({ access: 'at-1', accessExpiresAt: T0 + 60_000 } satisfies Tokens);
    const lc = attachTokenLifecycle({ kernel, transports: [], refresh, graceMs: 5_000 });

    // Only 2s elapsed — AT TTL is still 28s, well above graceMs.
    vi.setSystemTime(T0 + 2_000);
    lc.wake();
    await flushMicrotasks();

    expect(refresh).not.toHaveBeenCalled();
  });

  it('is a no-op when phase is not online/reconnecting', async () => {
    // Default kernel is idle.
    const kernel = createKernel({ context: makeCtx() });
    const refresh = vi.fn();
    const lc = attachTokenLifecycle({ kernel, transports: [], refresh, graceMs: 5_000 });

    lc.wake();
    await flushMicrotasks();

    expect(refresh).not.toHaveBeenCalled();
  });

  it('also fires in reconnecting phase (mid-outage resume)', async () => {
    const kernel = createKernel({
      context: makeCtx(),
      initial: {
        kind: 'reconnecting',
        instanceId: 'a',
        lastTarget: { endpoint: LAN, tokens: { access: 'at-0', accessExpiresAt: T0 + 30_000 } },
        cause: 'transport-down',
        since: T0,
        transports: new Map(),
      },
    });
    const refresh = vi.fn().mockResolvedValue({ access: 'at-1', accessExpiresAt: T0 + 90_000 } satisfies Tokens);
    const lc = attachTokenLifecycle({ kernel, transports: [], refresh, graceMs: 5_000 });

    vi.setSystemTime(T0 + 28_000);
    lc.wake();
    await flushMicrotasks();

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('is a no-op after detach', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlineWith(T0 + 30_000) });
    const refresh = vi.fn();
    const lc = attachTokenLifecycle({ kernel, transports: [], refresh, graceMs: 5_000 });

    lc.detach();
    vi.setSystemTime(T0 + 26_000);
    lc.wake();
    await flushMicrotasks();

    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('attachTokenLifecycle — detach', () => {
  it('returned detach() cancels timer and unsubscribes', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlineWith(T0 + 30_000) });
    const transport = new FakeTransport({ spec: { id: 'http', kind: 'request', phaseGating: false } });
    const refresh = vi.fn().mockResolvedValue({ access: 'at-1', accessExpiresAt: T0 + 60_000 } satisfies Tokens);
    const { detach } = attachTokenLifecycle({ kernel, transports: [transport], refresh, graceMs: 5_000 });

    detach();
    transport.emitAuthError(401);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.runOnlyPendingTimersAsync();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('attachTokenLifecycle — refresh lock (cross-tab coordination)', () => {
  async function flush(): Promise<void> {
    // Microtask flush only — do NOT advance time, otherwise the proactive
    // timer fires after the auth-error refresh and we count an extra call.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  it('wraps the refresh call with acquireRefreshLock', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlineWith(T0 + 30_000) });
    const transport = new FakeTransport({ spec: { id: 'http', kind: 'request', phaseGating: false } });
    const refresh = vi.fn().mockResolvedValue({ access: 'at-1', accessExpiresAt: T0 + 60_000 } satisfies Tokens);
    let lockCalls = 0;
    const acquireRefreshLock = async <T>(fn: () => Promise<T>): Promise<T> => {
      lockCalls++;
      return fn();
    };

    attachTokenLifecycle({ kernel, transports: [transport], refresh, graceMs: 5_000, acquireRefreshLock });

    transport.emitAuthError(401);
    await flush();

    expect(lockCalls).toBe(1);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('skips the HTTP refresh when getLatestTokens returns a still-fresh token', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlineWith(T0 + 30_000) });
    const transport = new FakeTransport({ spec: { id: 'http', kind: 'request', phaseGating: false } });
    const refresh = vi.fn();
    const freshTokens: Tokens = { access: 'fresh-from-other-tab', accessExpiresAt: T0 + 60_000 };
    const onRefreshSkipped = vi.fn();
    const onRefreshSuccess = vi.fn();

    attachTokenLifecycle({
      kernel,
      transports: [transport],
      refresh,
      graceMs: 5_000,
      acquireRefreshLock: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
      getLatestTokens: () => freshTokens,
      onRefreshSkipped,
      onRefreshSuccess,
    });

    transport.emitAuthError(401);
    await flush();

    expect(refresh).not.toHaveBeenCalled();
    expect(onRefreshSkipped).toHaveBeenCalledWith('auth-error', freshTokens);
    expect(onRefreshSuccess).not.toHaveBeenCalled();
    if (kernel.phase.kind !== 'online') throw new Error('expected online');
    expect(kernel.phase.target.tokens).toEqual(freshTokens);
  });

  it('still does the HTTP refresh when getLatestTokens returns stale tokens', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlineWith(T0 + 30_000) });
    const transport = new FakeTransport({ spec: { id: 'http', kind: 'request', phaseGating: false } });
    const refresh = vi.fn().mockResolvedValue({ access: 'at-fresh', accessExpiresAt: T0 + 60_000 } satisfies Tokens);
    const staleTokens: Tokens = { access: 'old', accessExpiresAt: T0 + 1_000 }; // inside grace window

    attachTokenLifecycle({
      kernel,
      transports: [transport],
      refresh,
      graceMs: 5_000,
      acquireRefreshLock: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
      getLatestTokens: () => staleTokens,
    });

    transport.emitAuthError(401);
    await flush();

    expect(refresh).toHaveBeenCalledOnce();
  });

  it('still does the HTTP refresh when getLatestTokens returns null', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlineWith(T0 + 30_000) });
    const transport = new FakeTransport({ spec: { id: 'http', kind: 'request', phaseGating: false } });
    const refresh = vi.fn().mockResolvedValue({ access: 'at-fresh', accessExpiresAt: T0 + 60_000 } satisfies Tokens);

    attachTokenLifecycle({
      kernel,
      transports: [transport],
      refresh,
      graceMs: 5_000,
      acquireRefreshLock: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
      getLatestTokens: () => null,
    });

    transport.emitAuthError(401);
    await flush();

    expect(refresh).toHaveBeenCalledOnce();
  });

  it('serializes concurrent refreshes through an async mutex', async () => {
    // Simulate two attached lifecycles sharing the same lock — like two tabs
    // coordinating via navigator.locks. Without the lock both refreshes would
    // race; with it they run strictly sequentially.
    let busy = false;
    let maxConcurrent = 0;
    let concurrent = 0;
    const queue: Array<() => void> = [];
    const lock = async <T>(fn: () => Promise<T>): Promise<T> => {
      while (busy) {
        await new Promise<void>((resolve) => queue.push(resolve));
      }
      busy = true;
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      try {
        return await fn();
      } finally {
        concurrent--;
        busy = false;
        const next = queue.shift();
        if (next) next();
      }
    };

    const k1 = createKernel({ context: makeCtx(), initial: onlineWith(T0 + 30_000) });
    const k2 = createKernel({ context: makeCtx(), initial: onlineWith(T0 + 30_000) });
    const t1 = new FakeTransport({ spec: { id: 'http', kind: 'request', phaseGating: false } });
    const t2 = new FakeTransport({ spec: { id: 'http', kind: 'request', phaseGating: false } });
    let refreshes = 0;
    const slowRefresh = vi.fn(async () => {
      refreshes++;
      // Resolve in the next microtask so we can observe both auth-errors
      // queue up in the lock before either resolves.
      await Promise.resolve();
      return { access: `at-${refreshes}`, accessExpiresAt: T0 + 60_000 } satisfies Tokens;
    });

    attachTokenLifecycle({ kernel: k1, transports: [t1], refresh: slowRefresh, acquireRefreshLock: lock, graceMs: 5_000 });
    attachTokenLifecycle({ kernel: k2, transports: [t2], refresh: slowRefresh, acquireRefreshLock: lock, graceMs: 5_000 });

    t1.emitAuthError(401);
    t2.emitAuthError(401);
    await flush();
    await flush();

    expect(maxConcurrent).toBe(1);
    expect(slowRefresh).toHaveBeenCalledTimes(2);
  });
});
