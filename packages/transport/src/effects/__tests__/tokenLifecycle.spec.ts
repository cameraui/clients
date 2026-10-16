import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createKernel } from '../../core/kernel.js';
import { FakeTransport } from '../../testing/fakeTransport.js';
import { TransportEmitter } from '../../transports/contract.js';
import { attachTokenLifecycle, localAccessExpiry } from '../tokenLifecycle.js';

import type { Kernel } from '../../core/kernel.js';
import type { ConnectionPhase, ConnectionTarget, Endpoint, ReducerContext, Tokens } from '../../core/types.js';
import type { Transport } from '../../transports/contract.js';
import type { TokenLifecycleOptions } from '../tokenLifecycle.js';

const LAN: Endpoint = { url: 'https://nvr.local', mode: 'direct-lan' };
const T0 = 1_000_000;

function makeCtx(): ReducerContext {
  return { now: () => Date.now() };
}

function onlineWith(expiresAt: number): ConnectionPhase {
  return {
    kind: 'online',
    instanceId: 'a',
    target: {
      endpoint: LAN,
      tokens: { access: 'at-0', refresh: 'rt-0', accessExpiresAt: expiresAt },
    },
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

  it('5xx server error gives up after maxServerErrorRetries, not the full ladder → offline', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlineWith(T0 + 30_000) });
    const refresh = vi.fn().mockRejectedValue(Object.assign(new Error('530'), { status: 530 }));
    attachTokenLifecycle({
      kernel,
      transports: [],
      refresh,
      graceMs: 5_000,
      transientRetryDelayMs: 1_000,
      maxTransientRetries: 5,
      isTransientError: (err: any) => err?.status >= 500,
      isServerError: (err: any) => err?.status >= 500,
      maxServerErrorRetries: 1,
    });

    await vi.advanceTimersByTimeAsync(25_001); // proactive: 5xx #1 → one retry queued
    expect(kernel.phase.kind).toBe('online');
    await vi.advanceTimersByTimeAsync(1_001); // retry: 5xx #2 → server-error budget spent
    expect(refresh).toHaveBeenCalledTimes(2); // not 6 — capped by maxServerErrorRetries
    // 5xx stays transient → offline (rediscover), never needs-auth
    expect(kernel.phase.kind).toBe('offline');
  });

  it('a transient non-server error keeps the full transient budget despite the shortcut', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlineWith(T0 + 30_000) });
    const refresh = vi.fn().mockRejectedValue(Object.assign(new Error('net'), { status: 0 }));
    attachTokenLifecycle({
      kernel,
      transports: [],
      refresh,
      graceMs: 5_000,
      transientRetryDelayMs: 1_000,
      maxTransientRetries: 3,
      isTransientError: () => true,
      isServerError: (err: any) => err?.status >= 500, // 0 → not a server error
      maxServerErrorRetries: 1,
    });

    await vi.advanceTimersByTimeAsync(25_001); // #1
    await vi.advanceTimersByTimeAsync(1_001); // #2
    await vi.advanceTimersByTimeAsync(1_001); // #3
    expect(kernel.phase.kind).toBe('online'); // budget of 3 not spent yet
    await vi.advanceTimersByTimeAsync(1_001); // #4 → give up
    expect(refresh).toHaveBeenCalledTimes(4);
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

  it('is a no-op when phase is not online', async () => {
    // Default kernel is idle.
    const kernel = createKernel({ context: makeCtx() });
    const refresh = vi.fn();
    const lc = attachTokenLifecycle({ kernel, transports: [], refresh, graceMs: 5_000 });

    lc.wake();
    await flushMicrotasks();

    expect(refresh).not.toHaveBeenCalled();
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
    for (let i = 0; i < 6; i++) await Promise.resolve();
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

describe('attachTokenLifecycle: hands the refresh outcome to the 401', () => {
  function authErrorSource() {
    const emitter = new TransportEmitter();
    const transport: Transport = {
      spec: { id: 'http', kind: 'request', phaseGating: false },
      apply: async () => {},
      health: () => ({ up: true }),
      on: (event, handler) => emitter.on(event, handler),
      dispose: async () => {},
    };
    function emit401(): Promise<boolean>[] {
      const holds: Promise<boolean>[] = [];
      emitter.emit('auth-error', { status: 401, holdFor: (refresh) => holds.push(refresh) });
      return holds;
    }
    return { transport, emit401 };
  }

  function accessOf(kernel: ReturnType<typeof createKernel>): string | undefined {
    return kernel.phase.kind === 'online' ? kernel.phase.target.tokens.access : undefined;
  }

  it('reports no new token when the stored token is still fresh', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlineWith(T0 + 14 * 60_000) });
    const source = authErrorSource();
    const refresh = vi.fn();
    const stored = { access: 'at-0', refresh: 'rt-0', accessExpiresAt: T0 + 14 * 60_000 };
    attachTokenLifecycle({ kernel, transports: [source.transport], refresh, graceMs: 5_000, getLatestTokens: () => stored });

    const holds = source.emit401();

    expect(holds).toHaveLength(1);
    await expect(holds[0]).resolves.toBe(false);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('reports a new token once the refresh has dispatched it', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlineWith(T0 + 3_000) });
    const source = authErrorSource();
    attachTokenLifecycle({
      kernel,
      transports: [source.transport],
      refresh: async () => ({ access: 'at-1', refresh: 'rt-1', accessExpiresAt: T0 + 900_000 }),
      graceMs: 5_000,
    });

    const [hold] = source.emit401();

    await expect(hold).resolves.toBe(true);
    expect(accessOf(kernel)).toBe('at-1');
  });

  it('reports a new token when another tab already stored one', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlineWith(T0 + 3_000) });
    const source = authErrorSource();
    const refresh = vi.fn();
    attachTokenLifecycle({
      kernel,
      transports: [source.transport],
      refresh,
      graceMs: 5_000,
      getLatestTokens: () => ({ access: 'at-other-tab', refresh: 'rt-9', accessExpiresAt: T0 + 900_000 }),
    });

    const [hold] = source.emit401();

    await expect(hold).resolves.toBe(true);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('reports no new token when the refresh hands back the same access token', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlineWith(T0 + 3_000) });
    const source = authErrorSource();
    attachTokenLifecycle({ kernel, transports: [source.transport], refresh: async (target) => target.tokens, graceMs: 5_000 });

    const [hold] = source.emit401();

    await expect(hold).resolves.toBe(false);
  });

  it('reports no new token when the refresh is rejected for good', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlineWith(T0 + 3_000) });
    const source = authErrorSource();
    attachTokenLifecycle({
      kernel,
      transports: [source.transport],
      refresh: async () => {
        throw new Error('refresh token revoked');
      },
      graceMs: 5_000,
    });

    const [hold] = source.emit401();

    await expect(hold).resolves.toBe(false);
    expect(kernel.phase.kind).toBe('needs-auth');
  });

  it('keeps the 401 waiting while a transient retry is scheduled', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlineWith(T0 + 3_000) });
    const source = authErrorSource();
    attachTokenLifecycle({
      kernel,
      transports: [source.transport],
      refresh: async () => {
        throw new Error('network');
      },
      isTransientError: () => true,
      graceMs: 5_000,
    });

    const [hold] = source.emit401();

    await expect(hold).resolves.toBe(true);
  });

  it('shares the running refresh with a 401 that arrives meanwhile', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlineWith(T0 + 3_000) });
    const source = authErrorSource();
    let finish!: (tokens: Tokens) => void;
    const refresh = vi.fn(() => new Promise<Tokens>((resolve) => (finish = resolve)));
    attachTokenLifecycle({ kernel, transports: [source.transport], refresh, graceMs: 5_000 });

    const [first] = source.emit401();
    await Promise.resolve();
    const [second] = source.emit401();
    finish({ access: 'at-1', refresh: 'rt-1', accessExpiresAt: T0 + 900_000 });

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
  });
});

describe('attachTokenLifecycle: a token the server rejected', () => {
  async function flush(): Promise<void> {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }

  function httpTransport(): FakeTransport {
    return new FakeTransport({ spec: { id: 'http', kind: 'request', phaseGating: false } });
  }

  it('refreshes although the rejected token still looks fresh', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlineWith(T0 + 14 * 60_000) });
    const transport = httpTransport();
    const stored: Tokens = { access: 'at-0', refresh: 'rt-0', accessExpiresAt: T0 + 14 * 60_000 };
    const refresh = vi.fn().mockResolvedValue({ access: 'at-1', refresh: 'rt-1', accessExpiresAt: T0 + 15 * 60_000 } satisfies Tokens);
    attachTokenLifecycle({ kernel, transports: [transport], refresh, graceMs: 5_000, getLatestTokens: () => stored });

    transport.emitAuthError(401, 'at-0');
    await flush();

    expect(refresh).toHaveBeenCalledOnce();
    expect(kernel.phase.kind === 'online' && kernel.phase.target.tokens.access).toBe('at-1');
  });

  it('ends in needs-auth when the refresh for the rejected token is refused', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlineWith(T0 + 14 * 60_000) });
    const transport = httpTransport();
    const stored: Tokens = { access: 'at-0', refresh: 'rt-0', accessExpiresAt: T0 + 14 * 60_000 };
    attachTokenLifecycle({
      kernel,
      transports: [transport],
      refresh: async () => {
        throw new Error('Invalid refresh token');
      },
      graceMs: 5_000,
      getLatestTokens: () => stored,
    });

    transport.emitAuthError(401, 'at-0');
    await flush();

    expect(kernel.phase.kind).toBe('needs-auth');
  });

  it('keeps a rejected token that has no refresh token to refresh with', async () => {
    const embed: Tokens = { access: 'embed', accessExpiresAt: T0 + 14 * 60_000 };
    const kernel = createKernel({ context: makeCtx(), initial: { kind: 'online', instanceId: 'a', target: { endpoint: LAN, tokens: embed } } });
    const transport = httpTransport();
    const refresh = vi.fn();
    attachTokenLifecycle({ kernel, transports: [transport], refresh, graceMs: 5_000, getLatestTokens: () => embed });

    transport.emitAuthError(401, 'embed');
    await flush();

    expect(refresh).not.toHaveBeenCalled();
    expect(kernel.phase.kind).toBe('online');
  });

  it('takes a newer stored token when an older one was rejected', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlineWith(T0 + 14 * 60_000) });
    const transport = httpTransport();
    const refresh = vi.fn();
    const stored: Tokens = { access: 'at-1', refresh: 'rt-1', accessExpiresAt: T0 + 15 * 60_000 };
    attachTokenLifecycle({ kernel, transports: [transport], refresh, graceMs: 5_000, getLatestTokens: () => stored });

    transport.emitAuthError(401, 'at-0');
    await flush();

    expect(refresh).not.toHaveBeenCalled();
    expect(kernel.phase.kind === 'online' && kernel.phase.target.tokens.access).toBe('at-1');
  });

  it('does not force another refresh for a token rotated in moments ago', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlineWith(T0 + 14 * 60_000) });
    const transport = httpTransport();
    let n = 0;
    let stored: Tokens = { access: 'at-0', refresh: 'rt-0', accessExpiresAt: T0 + 14 * 60_000 };
    const refresh = vi.fn(async () => {
      n++;
      return (stored = { access: `at-${n}`, refresh: `rt-${n}`, accessExpiresAt: Date.now() + 15 * 60_000 });
    });
    attachTokenLifecycle({ kernel, transports: [transport], refresh, graceMs: 5_000, getLatestTokens: () => stored });

    transport.emitAuthError(401, 'at-0');
    await flush();
    for (let i = 0; i < 5; i++) {
      transport.emitAuthError(401, stored.access);
      await flush();
    }
    expect(refresh).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(30_000);
    transport.emitAuthError(401, stored.access);
    await flush();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('keeps the forced refresh when a 401 for an older token arrives during the lock wait', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlineWith(T0 + 14 * 60_000) });
    const transport = httpTransport();
    const stored: Tokens = { access: 'at-0', refresh: 'rt-0', accessExpiresAt: T0 + 14 * 60_000 };
    const refresh = vi.fn().mockResolvedValue({ access: 'at-1', refresh: 'rt-1', accessExpiresAt: T0 + 15 * 60_000 } satisfies Tokens);
    let grant: (() => void) | undefined;
    attachTokenLifecycle({
      kernel,
      transports: [transport],
      refresh,
      graceMs: 5_000,
      getLatestTokens: () => stored,
      acquireRefreshLock: <T>(fn: () => Promise<T>): Promise<T> =>
        new Promise<T>((resolve) => {
          grant = () => resolve(fn());
        }),
    });

    transport.emitAuthError(401, 'at-0');
    await flush();
    transport.emitAuthError(401, 'at-retired');
    grant?.();
    await flush();

    expect(refresh).toHaveBeenCalledOnce();
    expect(kernel.phase.kind === 'online' && kernel.phase.target.tokens.access).toBe('at-1');
  });
});

describe('attachTokenLifecycle: server clock behind the client', () => {
  const SKEW_MS = -20 * 60_000;
  const TTL_MS = 15 * 60_000;

  function minted(n: number): Tokens {
    return { access: `at-${n}`, refresh: `rt-${n}`, accessExpiresAt: Date.now() + SKEW_MS + TTL_MS };
  }

  function onlineMinted(tokens: Tokens): ConnectionPhase {
    return { kind: 'online', instanceId: 'a', target: { endpoint: LAN, tokens } };
  }

  it('refreshes at most once per interval while every new token looks expired', async () => {
    let n = 0;
    const kernel = createKernel({ context: makeCtx(), initial: onlineMinted(minted(n)) });
    const refresh = vi.fn(async () => minted(++n));
    attachTokenLifecycle({ kernel, transports: [], refresh, graceMs: 5_000 });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(refresh).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('leaves a wake inside the interval to the timer', async () => {
    let n = 0;
    const kernel = createKernel({ context: makeCtx(), initial: onlineMinted(minted(n)) });
    const refresh = vi.fn(async () => minted(++n));
    const onWakeChecked = vi.fn();
    const lc = attachTokenLifecycle({ kernel, transports: [], refresh, graceMs: 5_000, minRefreshIntervalMs: 30_000, onWakeChecked });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(refresh).toHaveBeenCalledTimes(1);

    lc.wake();
    await vi.advanceTimersByTimeAsync(0);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(onWakeChecked).toHaveBeenCalledWith(expect.objectContaining({ decision: 'throttled' }));
  });

  it('treats a token rotated moments ago as current when a 401 names no token', async () => {
    let n = 0;
    let stored = minted(n);
    const kernel = createKernel({ context: makeCtx(), initial: onlineMinted(stored) });
    const transport = new FakeTransport({ spec: { id: 'http', kind: 'request', phaseGating: false } });
    const refresh = vi.fn(async () => (stored = minted(++n)));
    attachTokenLifecycle({ kernel, transports: [transport], refresh, graceMs: 5_000, getLatestTokens: () => stored });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(refresh).toHaveBeenCalledTimes(1);

    transport.emitAuthError(401);
    await vi.advanceTimersByTimeAsync(0);

    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('attachTokenLifecycle: short-lived tokens', () => {
  it('refreshes inside the grace window on every cycle', async () => {
    const leftAtRefresh: number[] = [];
    let n = 0;
    const kernel = createKernel({ context: makeCtx(), initial: onlineWith(T0 + 30_000) });
    const refresh = vi.fn(async (target: ConnectionTarget): Promise<Tokens> => {
      leftAtRefresh.push(target.tokens.accessExpiresAt! - Date.now());
      n++;
      return { access: `at-${n}`, refresh: `rt-${n}`, accessExpiresAt: Date.now() + 30_000 };
    });
    attachTokenLifecycle({ kernel, transports: [], refresh, graceMs: 5_000 });

    await vi.advanceTimersByTimeAsync(90_000);

    expect(leftAtRefresh).toEqual([5_000, 5_000, 5_000]);
  });
});

describe('localAccessExpiry', () => {
  function jwt(claims: Record<string, unknown>): string {
    function encode(value: unknown): string {
      return Buffer.from(JSON.stringify(value)).toString('base64url');
    }
    return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}.signature`;
  }

  it('counts the token lifetime from its arrival on the client clock', () => {
    const iat = Math.floor((T0 - 20 * 60_000) / 1000);
    const token = jwt({ sub: 'u', iat, exp: iat + 900 });

    expect(localAccessExpiry(token, (iat + 900) * 1000, T0)).toBe(T0 + 900_000);
  });

  it('falls back to the server expiry when the token carries no lifetime', () => {
    expect(localAccessExpiry('opaque-api-token', T0 + 5_000, T0)).toBe(T0 + 5_000);
    expect(localAccessExpiry(jwt({ exp: 123 }), T0 + 5_000, T0)).toBe(T0 + 5_000);
    expect(localAccessExpiry('a.!!!.c', undefined, T0)).toBeUndefined();
  });
});

describe('attachTokenLifecycle: refresh outage while a channel is up', () => {
  const badGateway = Object.assign(new Error('Request failed with status code 502'), { status: 502 });

  function attachWithOutage(kernel: Kernel, reachable: () => boolean, refresh: TokenLifecycleOptions['refresh'], transports: Transport[] = []) {
    return attachTokenLifecycle({
      kernel,
      transports,
      refresh,
      graceMs: 5_000,
      maxTransientRetries: 5,
      transientRetryDelayMs: 2_000,
      maxServerErrorRetries: 1,
      isTransientError: () => true,
      isServerError: () => true,
      isReachable: reachable,
    });
  }

  it('stays online and retries slower once the retry budget is spent', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlineWith(T0 + 6_000) });
    const refresh = vi.fn().mockRejectedValue(badGateway);
    attachWithOutage(kernel, () => true, refresh);

    await vi.advanceTimersByTimeAsync(3_001);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(kernel.phase.kind).toBe('online');

    await vi.advanceTimersByTimeAsync(9_998);
    expect(refresh).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2);
    expect(refresh).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refresh).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refresh).toHaveBeenCalledTimes(5);
    expect(kernel.phase.kind).toBe('online');
  });

  it('goes offline at give-up when no channel is up', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlineWith(T0 + 6_000) });
    attachWithOutage(kernel, () => false, vi.fn().mockRejectedValue(badGateway));

    await vi.advanceTimersByTimeAsync(3_001);

    expect(kernel.phase.kind).toBe('offline');
  });

  it('refreshes right away on a 401 between the slow retries', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlineWith(T0 + 6_000) });
    const transport = new FakeTransport({ spec: { id: 'http', kind: 'request', phaseGating: false } });
    const refresh = vi.fn().mockRejectedValue(badGateway);
    attachWithOutage(kernel, () => true, refresh, [transport]);
    await vi.advanceTimersByTimeAsync(8_001);
    expect(refresh).toHaveBeenCalledTimes(2);

    refresh.mockResolvedValueOnce({ access: 'at-1', refresh: 'rt-1', accessExpiresAt: T0 + 900_000 } satisfies Tokens);
    transport.emitAuthError(401);
    await vi.advanceTimersByTimeAsync(0);

    expect(refresh).toHaveBeenCalledTimes(3);
    expect(kernel.phase.kind === 'online' && kernel.phase.target.tokens.access).toBe('at-1');
  });

  it('leaves a 401 right after a failed slow retry to the retry timer', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlineWith(T0 + 6_000) });
    const transport = new FakeTransport({ spec: { id: 'http', kind: 'request', phaseGating: false } });
    const refresh = vi.fn().mockRejectedValue(badGateway);
    attachWithOutage(kernel, () => true, refresh, [transport]);
    await vi.advanceTimersByTimeAsync(3_001);
    expect(refresh).toHaveBeenCalledTimes(2);

    transport.emitAuthError(401);
    transport.emitAuthError(401);
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it('still asks for a login when the refresh is refused while a channel is up', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlineWith(T0 + 6_000) });
    attachTokenLifecycle({
      kernel,
      transports: [],
      graceMs: 5_000,
      refresh: async () => {
        throw new Error('Invalid refresh token');
      },
      isReachable: () => true,
    });

    await vi.advanceTimersByTimeAsync(1_001);

    expect(kernel.phase.kind).toBe('needs-auth');
  });
});

describe('attachTokenLifecycle: refresh lock that is never granted', () => {
  function neverGranted<T>(): Promise<T> {
    return new Promise<T>(() => {});
  }

  it('stops waiting after lockTimeoutMs and takes the token another tab stored', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlineWith(T0 + 6_000) });
    const refresh = vi.fn();
    let stored: Tokens | null = null;
    attachTokenLifecycle({
      kernel,
      transports: [],
      refresh,
      graceMs: 5_000,
      lockTimeoutMs: 15_000,
      acquireRefreshLock: neverGranted,
      getLatestTokens: () => stored,
    });

    await vi.advanceTimersByTimeAsync(1_001);
    stored = { access: 'at-other-tab', refresh: 'rt-9', accessExpiresAt: T0 + 900_000 };
    await vi.advanceTimersByTimeAsync(15_000);

    expect(refresh).not.toHaveBeenCalled();
    expect(kernel.phase.kind === 'online' && kernel.phase.target.tokens.access).toBe('at-other-tab');
  });

  it('counts a lock timeout without a fresh token as a transient failure', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlineWith(T0 + 6_000) });
    const onRefreshError = vi.fn();
    attachTokenLifecycle({
      kernel,
      transports: [],
      refresh: vi.fn(),
      graceMs: 5_000,
      lockTimeoutMs: 15_000,
      maxTransientRetries: 1,
      transientRetryDelayMs: 1_000,
      acquireRefreshLock: neverGranted,
      onRefreshError,
    });

    await vi.advanceTimersByTimeAsync(16_001);
    expect(kernel.phase.kind).toBe('online');
    expect(onRefreshError).toHaveBeenCalledWith('proactive', expect.any(Error), expect.objectContaining({ transient: true, willRetry: true }));

    await vi.advanceTimersByTimeAsync(16_000);
    expect(kernel.phase.kind).toBe('offline');
  });

  it('aborts the lock request when it stops waiting', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlineWith(T0 + 6_000) });
    let signal: AbortSignal | undefined;
    attachTokenLifecycle({
      kernel,
      transports: [],
      refresh: vi.fn(),
      graceMs: 5_000,
      maxTransientRetries: 0,
      acquireRefreshLock: <T>(_fn: () => Promise<T>, s?: AbortSignal): Promise<T> => {
        signal = s;
        return neverGranted<T>();
      },
    });

    await vi.advanceTimersByTimeAsync(1_001);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(signal?.aborted).toBe(true);
  });

  it('drops the queued lock request and its timer on detach', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlineWith(T0 + 6_000) });
    const refresh = vi.fn();
    let signal: AbortSignal | undefined;
    let grant: (() => void) | undefined;
    const lc = attachTokenLifecycle({
      kernel,
      transports: [],
      refresh,
      graceMs: 5_000,
      acquireRefreshLock: <T>(fn: () => Promise<T>, s?: AbortSignal): Promise<T> => {
        signal = s;
        return new Promise<T>((resolve) => {
          grant = () => resolve(fn());
        });
      },
    });
    await vi.advanceTimersByTimeAsync(1_001);

    lc.detach();
    grant?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(signal?.aborted).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not refresh when the lock is granted after it stopped waiting', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlineWith(T0 + 6_000) });
    const refresh = vi.fn();
    let grant: (() => void) | undefined;
    attachTokenLifecycle({
      kernel,
      transports: [],
      refresh,
      graceMs: 5_000,
      lockTimeoutMs: 15_000,
      maxTransientRetries: 0,
      acquireRefreshLock: <T>(fn: () => Promise<T>): Promise<T> =>
        new Promise<T>((resolve) => {
          grant = () => resolve(fn());
        }),
    });

    await vi.advanceTimersByTimeAsync(16_001);
    grant?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(refresh).not.toHaveBeenCalled();
  });

  it.each([0, Infinity])('waits for the lock without a deadline when lockTimeoutMs is %s', async (lockTimeoutMs) => {
    const kernel = createKernel({ context: makeCtx(), initial: onlineWith(T0 + 6_000) });
    const refresh = vi.fn().mockResolvedValue({ access: 'at-1', refresh: 'rt-1', accessExpiresAt: T0 + 900_000 } satisfies Tokens);
    let grant: (() => void) | undefined;
    attachTokenLifecycle({
      kernel,
      transports: [],
      refresh,
      graceMs: 5_000,
      lockTimeoutMs,
      maxTransientRetries: 0,
      acquireRefreshLock: <T>(fn: () => Promise<T>): Promise<T> =>
        new Promise<T>((resolve) => {
          grant = () => resolve(fn());
        }),
    });

    await vi.advanceTimersByTimeAsync(60_000);
    grant?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(refresh).toHaveBeenCalledOnce();
    expect(kernel.phase.kind === 'online' && kernel.phase.target.tokens.access).toBe('at-1');
  });
});
