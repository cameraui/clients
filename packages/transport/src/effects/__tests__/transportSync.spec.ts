import { describe, expect, it, vi } from 'vitest';

import { createKernel } from '../../core/kernel.js';
import { FakeTransport } from '../../testing/fakeTransport.js';
import { attachTransportSync } from '../transportSync.js';

import type { ConnectionPhase, ConnectionTarget, Endpoint, ReducerContext, Tokens, TransportSpec } from '../../core/types.js';

const LAN: Endpoint = { url: 'https://nvr.local', mode: 'direct-lan' };
const WAN: Endpoint = { url: 'https://nvr.example.com', mode: 'direct-wan' };

const SPECS: ReadonlyMap<string, TransportSpec> = new Map([
  ['http', { id: 'http', kind: 'request', phaseGating: false }],
  ['socketio', { id: 'socketio', kind: 'persistent', phaseGating: true }],
]);

function makeCtx(): ReducerContext {
  return { now: () => Date.now() };
}

function tokensWith(access: string, accessExpiresAt = Date.now() + 60_000): Tokens {
  return { access, refresh: `rt-${access}`, accessExpiresAt };
}

function targetWith(endpoint: Endpoint, access: string, accessExpiresAt = Date.now() + 60_000): ConnectionTarget {
  return { endpoint, tokens: tokensWith(access, accessExpiresAt) };
}

function onlinePhase(target: ConnectionTarget): ConnectionPhase {
  return { kind: 'online', instanceId: 'a', target };
}

describe('attachTransportSync — initial state', () => {
  it('applies current target on attach when kernel is already online', () => {
    const target = targetWith(LAN, 'at-0');
    const kernel = createKernel({ context: makeCtx(), initial: onlinePhase(target) });
    const http = new FakeTransport({ spec: SPECS.get('http')! });
    const socketio = new FakeTransport({ spec: SPECS.get('socketio')! });

    attachTransportSync({ kernel, transports: [http, socketio] });

    expect(http.applyCalls).toEqual([target]);
    expect(socketio.applyCalls).toEqual([target]);
  });

  it('applies null on attach when kernel is idle', () => {
    const kernel = createKernel({ context: makeCtx() });
    const http = new FakeTransport({ spec: SPECS.get('http')! });

    attachTransportSync({ kernel, transports: [http] });

    expect(http.applyCalls).toEqual([null]);
  });

  it('skips initial apply when kernel is discovering', () => {
    const kernel = createKernel({
      context: makeCtx(),
      initial: { kind: 'discovering', instanceId: 'a' },
    });
    const http = new FakeTransport({ spec: SPECS.get('http')! });

    attachTransportSync({ kernel, transports: [http] });

    expect(http.applyCalls).toEqual([]);
  });
});

describe('attachTransportSync — phase transitions', () => {
  it('forwards target on idle → discovering → online', () => {
    const kernel = createKernel({ context: makeCtx() });
    const http = new FakeTransport({ spec: SPECS.get('http')! });
    attachTransportSync({ kernel, transports: [http] });

    kernel.dispatch({ type: 'BOOT', instanceId: 'a' });
    const tokens = tokensWith('at-0');
    kernel.dispatch({ type: 'PROBE_SUCCEEDED', endpoint: LAN, tokens });

    // initial idle → null, BOOT → discovering (skipped), PROBE → online with target
    expect(http.applyCalls).toEqual([null, { endpoint: LAN, tokens }]);
  });

  it('forwards refreshed tokens while online', () => {
    const target = targetWith(LAN, 'at-0');
    const kernel = createKernel({ context: makeCtx(), initial: onlinePhase(target) });
    const http = new FakeTransport({ spec: SPECS.get('http')! });
    attachTransportSync({ kernel, transports: [http] });

    expect(http.applyCalls).toEqual([target]);

    // New AT → new target → apply fires.
    const refreshed = { ...target.tokens, access: 'at-1' };
    kernel.dispatch({ type: 'TOKENS_REFRESHED', tokens: refreshed });

    expect(http.applyCalls).toHaveLength(2);
    expect(http.applyCalls[1]).toMatchObject({ tokens: { access: 'at-1' } });
  });

  it('applies null on online → offline (transient TOKENS_INVALID)', () => {
    const target = targetWith(LAN, 'at-0');
    const kernel = createKernel({ context: makeCtx(), initial: onlinePhase(target) });
    const http = new FakeTransport({ spec: SPECS.get('http')! });
    attachTransportSync({ kernel, transports: [http] });

    kernel.dispatch({ type: 'TOKENS_INVALID', reason: 'refresh failed', transient: true });
    expect(kernel.phase.kind).toBe('offline');

    expect(http.applyCalls).toEqual([target, null]);
  });

  it('applies null on online → needs-auth (permanent TOKENS_INVALID)', () => {
    const target = targetWith(LAN, 'at-0');
    const kernel = createKernel({ context: makeCtx(), initial: onlinePhase(target) });
    const http = new FakeTransport({ spec: SPECS.get('http')! });
    attachTransportSync({ kernel, transports: [http] });

    kernel.dispatch({ type: 'TOKENS_INVALID', reason: 'refresh rejected' });
    expect(kernel.phase.kind).toBe('needs-auth');

    expect(http.applyCalls).toEqual([target, null]);
  });

  it('applies null on online → idle (RESET)', () => {
    const target = targetWith(LAN, 'at-0');
    const kernel = createKernel({ context: makeCtx(), initial: onlinePhase(target) });
    const http = new FakeTransport({ spec: SPECS.get('http')! });
    attachTransportSync({ kernel, transports: [http] });

    kernel.dispatch({ type: 'RESET' });

    expect(http.applyCalls).toEqual([target, null]);
  });

  it('does not apply during discovering (probe in flight)', () => {
    const target = targetWith(LAN, 'at-0');
    const kernel = createKernel({ context: makeCtx(), initial: onlinePhase(target) });
    const http = new FakeTransport({ spec: SPECS.get('http')! });
    attachTransportSync({ kernel, transports: [http] });

    // online → needs-auth → discovering. Needs-auth tears down. Discovering hold-state — no new apply.
    kernel.dispatch({ type: 'TOKENS_INVALID', reason: 'bad' });
    expect(http.applyCalls).toEqual([target, null]);

    kernel.dispatch({ type: 'BOOT', instanceId: 'b' });
    expect(http.applyCalls).toEqual([target, null]); // discovering = skip

    kernel.dispatch({ type: 'PROBE_SUCCEEDED', endpoint: LAN, tokens: target.tokens });
    expect(http.applyCalls).toHaveLength(3);
    expect(http.applyCalls[2]).toMatchObject({ endpoint: LAN });
  });

  it('forwards endpoint change via reset + reboot probe', () => {
    const a = targetWith(LAN, 'at-0');
    const kernel = createKernel({ context: makeCtx(), initial: onlinePhase(a) });
    const http = new FakeTransport({ spec: SPECS.get('http')! });
    attachTransportSync({ kernel, transports: [http] });

    kernel.dispatch({ type: 'RESET' });
    kernel.dispatch({ type: 'BOOT', instanceId: 'b' });
    kernel.dispatch({ type: 'PROBE_SUCCEEDED', endpoint: WAN, tokens: tokensWith('at-1') });

    expect(http.applyCalls).toHaveLength(3);
    expect(http.applyCalls[0]).toEqual(a);
    expect(http.applyCalls[1]).toBeNull();
    expect(http.applyCalls[2]).toMatchObject({ endpoint: WAN });
  });
});

describe('attachTransportSync — dedupe', () => {
  it('emits onApplied for every applied target (including initial)', () => {
    const target = targetWith(LAN, 'at-0');
    const kernel = createKernel({ context: makeCtx(), initial: onlinePhase(target) });
    const http = new FakeTransport({ spec: SPECS.get('http')! });
    const onApplied = vi.fn();
    attachTransportSync({ kernel, transports: [http], onApplied });

    kernel.dispatch({ type: 'RESET' });

    expect(onApplied).toHaveBeenCalledTimes(2);
    expect(onApplied).toHaveBeenNthCalledWith(1, target);
    expect(onApplied).toHaveBeenNthCalledWith(2, null);
  });
});

describe('attachTransportSync — errors', () => {
  it('calls onError when apply() rejects', async () => {
    const target = targetWith(LAN, 'at-0');
    const kernel = createKernel({ context: makeCtx(), initial: onlinePhase(target) });
    const http = new FakeTransport({ spec: SPECS.get('http')! });
    await http.dispose();
    const onError = vi.fn();
    attachTransportSync({ kernel, transports: [http], onError });

    await Promise.resolve();
    await Promise.resolve();

    expect(onError).toHaveBeenCalledOnce();
    const [t, tg, err] = onError.mock.calls[0]!;
    expect(t).toBe(http);
    expect(tg).toBe(target);
    expect(err).toBeInstanceOf(Error);
  });
});

describe('attachTransportSync — detach', () => {
  it('stops syncing after detach', () => {
    const target = targetWith(LAN, 'at-0');
    const kernel = createKernel({ context: makeCtx(), initial: onlinePhase(target) });
    const http = new FakeTransport({ spec: SPECS.get('http')! });
    const detach = attachTransportSync({ kernel, transports: [http] });

    expect(http.applyCalls).toEqual([target]);

    detach();
    kernel.dispatch({ type: 'RESET' });

    expect(http.applyCalls).toEqual([target]);
  });

  it('detach is idempotent', () => {
    const kernel = createKernel({ context: makeCtx() });
    const http = new FakeTransport({ spec: SPECS.get('http')! });
    const detach = attachTransportSync({ kernel, transports: [http] });

    detach();
    expect(() => detach()).not.toThrow();
  });
});

describe('attachTransportSync — per-transport rollback and retry', () => {
  async function flush(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  it('retries a failed apply with the same target while healthy transports are left alone', async () => {
    vi.useFakeTimers();
    try {
      const target = targetWith(LAN, 'at-0');
      const kernel = createKernel({ context: makeCtx(), initial: onlinePhase(target) });
      const http = new FakeTransport({ spec: SPECS.get('http')! });
      const socketio = new FakeTransport({ spec: SPECS.get('socketio')! });
      socketio.failNextApplies = 1;
      const onError = vi.fn();
      const onRetry = vi.fn();

      attachTransportSync({ kernel, transports: [http, socketio], retryMs: 2_000, onError, onRetry });
      await flush();

      expect(onError).toHaveBeenCalledTimes(1);
      expect(socketio.applyCalls).toEqual([target]);

      await vi.advanceTimersByTimeAsync(2_000);

      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(socketio.applyCalls).toEqual([target, target]);
      expect(socketio.target).toBe(target);
      expect(http.applyCalls).toEqual([target]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps retrying until apply succeeds', async () => {
    vi.useFakeTimers();
    try {
      const target = targetWith(LAN, 'at-0');
      const kernel = createKernel({ context: makeCtx(), initial: onlinePhase(target) });
      const socketio = new FakeTransport({ spec: SPECS.get('socketio')! });
      socketio.failNextApplies = 3;

      attachTransportSync({ kernel, transports: [socketio], retryMs: 1_000 });
      await flush();
      await vi.advanceTimersByTimeAsync(3_000);

      expect(socketio.applyCalls).toEqual([target, target, target, target]);
      expect(socketio.target).toBe(target);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(socketio.applyCalls.length).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a pending retry holds through discovering and applies after the next commit', async () => {
    vi.useFakeTimers();
    try {
      const target = targetWith(LAN, 'at-0');
      const kernel = createKernel({ context: makeCtx(), initial: onlinePhase(target) });
      const socketio = new FakeTransport({ spec: SPECS.get('socketio')! });
      socketio.failNextApplies = 1;

      attachTransportSync({ kernel, transports: [socketio], retryMs: 1_000 });
      await flush();

      // discovering is only reachable via offline now — the null apply on
      // offline is expected teardown, the retry then idles through discovering
      kernel.dispatch({ type: 'PROBE_FAILED_ALL', error: 'down' });
      await flush();
      kernel.dispatch({ type: 'USER_RETRY' });
      expect(kernel.phase.kind).toBe('discovering');
      await vi.advanceTimersByTimeAsync(1_500);
      expect(socketio.applyCalls).toEqual([target, null]);

      kernel.dispatch({ type: 'PROBE_SUCCEEDED', endpoint: LAN, tokens: tokensWith('at-0') });
      await flush();
      expect(socketio.applyCalls.length).toBe(3);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(socketio.target).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('detach cancels pending retries', async () => {
    vi.useFakeTimers();
    try {
      const target = targetWith(LAN, 'at-0');
      const kernel = createKernel({ context: makeCtx(), initial: onlinePhase(target) });
      const socketio = new FakeTransport({ spec: SPECS.get('socketio')! });
      socketio.failNextApplies = 1;

      const detach = attachTransportSync({ kernel, transports: [socketio], retryMs: 1_000 });
      await flush();
      detach();
      await vi.advanceTimersByTimeAsync(5_000);

      expect(socketio.applyCalls).toEqual([target]);
    } finally {
      vi.useRealTimers();
    }
  });
});
