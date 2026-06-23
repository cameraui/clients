import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createKernel } from '../../core/kernel.js';
import { attachReconnectWatchdog } from '../reconnectWatchdog.js';

import type { ConnectionPhase, ConnectionTarget, Endpoint, ReducerContext, Tokens, TransportSpec } from '../../core/types.js';

const LAN: Endpoint = { url: 'https://nvr.local', mode: 'direct-lan' };
const TOKENS: Tokens = { access: 'at' };
const TARGET: ConnectionTarget = { endpoint: LAN, tokens: TOKENS };

const GATING_SPEC: TransportSpec = { id: 'socketio', kind: 'persistent', phaseGating: true, graceMs: 4_000 };

const SPECS: ReadonlyMap<string, TransportSpec> = new Map([[GATING_SPEC.id, GATING_SPEC]]);

function makeCtx(): ReducerContext {
  return { specs: SPECS, now: () => Date.now() };
}

function reconnectingPhase(): ConnectionPhase {
  return {
    kind: 'reconnecting',
    instanceId: 'a',
    lastTarget: TARGET,
    cause: 'transport-down',
    since: Date.now(),
    transports: new Map([['socketio', { up: false, lastError: 'down-confirmed', downSince: Date.now() }]]),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('attachReconnectWatchdog — escalation', () => {
  it('escalates to USER_RETRY after escalateAfterMs when stuck in reconnecting', () => {
    const kernel = createKernel({ context: makeCtx(), initial: reconnectingPhase() });
    const onEscalate = vi.fn();
    const dispatchSpy = vi.spyOn(kernel, 'dispatch');

    attachReconnectWatchdog({ kernel, escalateAfterMs: 12_000, onEscalate });

    vi.advanceTimersByTime(11_999);
    expect(onEscalate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);

    expect(onEscalate).toHaveBeenCalledWith(1);
    expect(dispatchSpy).toHaveBeenCalledWith({ type: 'USER_RETRY' });
    expect(kernel.phase.kind).toBe('discovering');
  });

  it('catches up if the kernel is already reconnecting when attached', () => {
    const kernel = createKernel({ context: makeCtx(), initial: reconnectingPhase() });
    const onEscalate = vi.fn();

    attachReconnectWatchdog({ kernel, escalateAfterMs: 5_000, onEscalate });
    vi.advanceTimersByTime(5_001);

    expect(onEscalate).toHaveBeenCalledTimes(1);
    expect(kernel.phase.kind).toBe('discovering');
  });

  it('does not escalate if the phase leaves reconnecting before the timer fires', () => {
    const kernel = createKernel({ context: makeCtx(), initial: reconnectingPhase() });
    const onEscalate = vi.fn();

    attachReconnectWatchdog({ kernel, escalateAfterMs: 12_000, onEscalate });
    vi.advanceTimersByTime(6_000);
    // socketio (the only gating transport) recovers → back to online.
    kernel.dispatch({ type: 'TRANSPORT_UP', id: 'socketio' });
    expect(kernel.phase.kind).toBe('online');

    vi.advanceTimersByTime(20_000);
    expect(onEscalate).not.toHaveBeenCalled();
  });

  it('re-arms on a fresh reconnecting entry after recovering', () => {
    const kernel = createKernel({ context: makeCtx(), initial: { kind: 'idle' } });
    const onEscalate = vi.fn();
    attachReconnectWatchdog({ kernel, escalateAfterMs: 10_000, onEscalate });

    // Drive idle → discovering → online, then drop a gating transport to land
    // back in reconnecting via the grace-confirmed path.
    kernel.dispatch({ type: 'BOOT', instanceId: 'a' });
    kernel.dispatch({ type: 'PROBE_SUCCEEDED', endpoint: LAN, tokens: TOKENS });
    expect(kernel.phase.kind).toBe('online');
    kernel.dispatch({ type: 'TRANSPORT_DOWN', id: 'socketio', reason: 'drop' });
    kernel.dispatch({ type: 'TRANSPORT_DOWN_CONFIRMED', id: 'socketio' });
    expect(kernel.phase.kind).toBe('reconnecting');

    vi.advanceTimersByTime(10_001);
    expect(onEscalate).toHaveBeenCalledTimes(1);
    expect(kernel.phase.kind).toBe('discovering');
  });
});

describe('attachReconnectWatchdog — detach', () => {
  it('cancels the pending timer and unsubscribes', () => {
    const kernel = createKernel({ context: makeCtx(), initial: reconnectingPhase() });
    const onEscalate = vi.fn();
    const dispatchSpy = vi.spyOn(kernel, 'dispatch');

    const detach = attachReconnectWatchdog({ kernel, escalateAfterMs: 12_000, onEscalate });
    vi.advanceTimersByTime(6_000);
    detach();

    vi.advanceTimersByTime(20_000);
    expect(onEscalate).not.toHaveBeenCalled();
    expect(dispatchSpy).not.toHaveBeenCalled();
  });
});
