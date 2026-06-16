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
  return { specs: SPECS, now: () => Date.now() };
}

function tokensWith(access: string, accessExpiresAt = Date.now() + 60_000): Tokens {
  return { access, refresh: `rt-${access}`, accessExpiresAt };
}

function targetWith(endpoint: Endpoint, access: string, accessExpiresAt = Date.now() + 60_000): ConnectionTarget {
  return { endpoint, tokens: tokensWith(access, accessExpiresAt) };
}

function onlinePhase(target: ConnectionTarget): ConnectionPhase {
  return { kind: 'online', instanceId: 'a', target, transports: new Map() };
}

function reconnectingPhase(lastTarget: ConnectionTarget | null): ConnectionPhase {
  return {
    kind: 'reconnecting',
    instanceId: 'a',
    lastTarget,
    cause: 'transport-down',
    since: Date.now(),
    transports: new Map(),
  };
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
      initial: { kind: 'discovering', instanceId: 'a', attempt: 0 },
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

  it('forwards lastTarget on online → reconnecting (phase-gating transport down)', () => {
    const target = targetWith(LAN, 'at-0');
    const kernel = createKernel({ context: makeCtx(), initial: onlinePhase(target) });
    const socketio = new FakeTransport({ spec: SPECS.get('socketio')! });
    attachTransportSync({ kernel, transports: [socketio] });

    kernel.dispatch({ type: 'TRANSPORT_DOWN_CONFIRMED', id: 'socketio' });

    // online apply + reconnecting apply (lastTarget = target) → 2 calls,
    // but target is identical → dedupe kicks in, stays at 1
    expect(socketio.applyCalls).toEqual([target]);
  });

  it('forwards refreshed tokens during reconnecting', () => {
    const target = targetWith(LAN, 'at-0');
    const kernel = createKernel({ context: makeCtx(), initial: onlinePhase(target) });
    const http = new FakeTransport({ spec: SPECS.get('http')! });
    attachTransportSync({ kernel, transports: [http] });

    // Trigger reconnecting via socketio confirmation. Stay on same target — dedup keeps it at 1 apply.
    kernel.dispatch({ type: 'TRANSPORT_DOWN_CONFIRMED', id: 'socketio' });
    expect(http.applyCalls).toEqual([target]);

    // Refresh tokens during reconnecting. New AT → new target → apply fires.
    const refreshed = { ...target.tokens, access: 'at-1' };
    kernel.dispatch({ type: 'TOKENS_REFRESHED', tokens: refreshed });

    expect(http.applyCalls).toHaveLength(2);
    expect(http.applyCalls[1]).toMatchObject({ tokens: { access: 'at-1' } });
  });

  it('applies null on online → offline (TOKENS_INVALID)', () => {
    const target = targetWith(LAN, 'at-0');
    const kernel = createKernel({ context: makeCtx(), initial: onlinePhase(target) });
    const http = new FakeTransport({ spec: SPECS.get('http')! });
    attachTransportSync({ kernel, transports: [http] });

    kernel.dispatch({ type: 'TOKENS_INVALID', reason: 'refresh failed' });

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

    // online → offline → discovering. Offline tears down. Discovering hold-state — no new apply.
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

describe('attachTransportSync — reconnecting from null', () => {
  it('applies null when reconnecting has no lastTarget', () => {
    const kernel = createKernel({ context: makeCtx(), initial: reconnectingPhase(null) });
    const http = new FakeTransport({ spec: SPECS.get('http')! });

    attachTransportSync({ kernel, transports: [http] });

    expect(http.applyCalls).toEqual([null]);
  });
});
