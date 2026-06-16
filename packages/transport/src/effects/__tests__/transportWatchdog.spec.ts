import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createKernel } from '../../core/kernel.js';
import { FakeTransport } from '../../testing/fakeTransport.js';
import { attachTransportWatchdog } from '../transportWatchdog.js';

import type { ConnectionPhase, Endpoint, ReducerContext, Tokens, TransportSpec } from '../../core/types.js';

const LAN: Endpoint = { url: 'https://nvr.local', mode: 'direct-lan' };
const TOKENS: Tokens = { access: 'at' };

const GATING_SPEC: TransportSpec = { id: 'socketio', kind: 'persistent', phaseGating: true, graceMs: 4_000 };
const NON_GATING_SPEC: TransportSpec = { id: 'nats', kind: 'persistent', phaseGating: false };
const HTTP_SPEC: TransportSpec = { id: 'http', kind: 'request', phaseGating: false };

const SPECS: ReadonlyMap<string, TransportSpec> = new Map([
  [GATING_SPEC.id, GATING_SPEC],
  [NON_GATING_SPEC.id, NON_GATING_SPEC],
  [HTTP_SPEC.id, HTTP_SPEC],
]);

function makeCtx(): ReducerContext {
  return { specs: SPECS, now: () => Date.now() };
}

function onlinePhase(): ConnectionPhase {
  return {
    kind: 'online',
    instanceId: 'a',
    target: { endpoint: LAN, tokens: TOKENS },
    transports: new Map(),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('attachTransportWatchdog — basic event → action mapping', () => {
  it('transport up → dispatch TRANSPORT_UP', () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlinePhase() });
    const transport = new FakeTransport({ spec: GATING_SPEC });
    const dispatchSpy = vi.spyOn(kernel, 'dispatch');

    attachTransportWatchdog({ kernel, transports: [transport] });
    transport.emitUp();

    expect(dispatchSpy).toHaveBeenCalledWith({ type: 'TRANSPORT_UP', id: 'socketio' });
  });

  it('transport down → dispatch TRANSPORT_DOWN immediately', () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlinePhase() });
    const transport = new FakeTransport({ spec: GATING_SPEC });
    const dispatchSpy = vi.spyOn(kernel, 'dispatch');

    attachTransportWatchdog({ kernel, transports: [transport] });
    transport.emitDown('network');

    expect(dispatchSpy).toHaveBeenCalledWith({
      type: 'TRANSPORT_DOWN',
      id: 'socketio',
      reason: 'network',
    });
  });
});

describe('attachTransportWatchdog — grace period', () => {
  it('phase-gating: starts grace timer on down, fires TRANSPORT_DOWN_CONFIRMED after graceMs', () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlinePhase() });
    const transport = new FakeTransport({ spec: GATING_SPEC });
    const onGraceStarted = vi.fn();
    const onConfirmed = vi.fn();
    const dispatchSpy = vi.spyOn(kernel, 'dispatch');

    attachTransportWatchdog({ kernel, transports: [transport], onGraceStarted, onConfirmed });
    transport.emitDown('flap');

    expect(onGraceStarted).toHaveBeenCalledWith('socketio', 4_000);
    vi.advanceTimersByTime(3_999);
    expect(onConfirmed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(onConfirmed).toHaveBeenCalledWith('socketio');
    expect(dispatchSpy).toHaveBeenCalledWith({ type: 'TRANSPORT_DOWN_CONFIRMED', id: 'socketio' });
    expect(kernel.phase.kind).toBe('reconnecting');
  });

  it('phase-gating: up before grace fires cancels the timer, no DOWN_CONFIRMED', () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlinePhase() });
    const transport = new FakeTransport({ spec: GATING_SPEC });
    const onConfirmed = vi.fn();
    const onGraceCleared = vi.fn();

    attachTransportWatchdog({ kernel, transports: [transport], onConfirmed, onGraceCleared });
    transport.emitDown('flap');
    vi.advanceTimersByTime(2_000);
    transport.emitUp();

    expect(onGraceCleared).toHaveBeenCalledWith('socketio', 'up');
    vi.advanceTimersByTime(10_000);
    expect(onConfirmed).not.toHaveBeenCalled();
    expect(kernel.phase.kind).toBe('online');
  });

  it('non-phase-gating: no grace timer started', () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlinePhase() });
    const transport = new FakeTransport({ spec: NON_GATING_SPEC });
    const onGraceStarted = vi.fn();
    const onConfirmed = vi.fn();

    attachTransportWatchdog({ kernel, transports: [transport], onGraceStarted, onConfirmed });
    transport.emitDown('flap');
    vi.advanceTimersByTime(60_000);

    expect(onGraceStarted).not.toHaveBeenCalled();
    expect(onConfirmed).not.toHaveBeenCalled();
    expect(kernel.phase.kind).toBe('online');
  });

  it('uses spec.graceMs if set, otherwise defaultGraceMs', () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlinePhase() });
    const noGrace: TransportSpec = { id: 'x', kind: 'persistent', phaseGating: true };
    const transport = new FakeTransport({ spec: noGrace });
    const onGraceStarted = vi.fn();

    attachTransportWatchdog({ kernel, transports: [transport], defaultGraceMs: 2_500, onGraceStarted });
    transport.emitDown('flap');

    expect(onGraceStarted).toHaveBeenCalledWith('x', 2_500);
  });
});

describe('attachTransportWatchdog — coalescing', () => {
  it('repeated down events while a timer is running do not restart it', () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlinePhase() });
    const transport = new FakeTransport({ spec: GATING_SPEC });
    const onGraceStarted = vi.fn();
    const onConfirmed = vi.fn();

    attachTransportWatchdog({ kernel, transports: [transport], onGraceStarted, onConfirmed });
    transport.emitDown('flap-1');
    vi.advanceTimersByTime(2_000);
    transport.emitDown('flap-2');
    vi.advanceTimersByTime(2_000);
    transport.emitDown('flap-3');

    // Only first emitDown should have started a timer
    expect(onGraceStarted).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(100);
    // First timer (4s ago) has fired exactly once
    expect(onConfirmed).toHaveBeenCalledTimes(1);
  });

  it('down events after phase already in reconnecting do not start new timers', () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlinePhase() });
    const transport = new FakeTransport({ spec: GATING_SPEC });
    const onGraceStarted = vi.fn();

    attachTransportWatchdog({ kernel, transports: [transport], onGraceStarted });
    transport.emitDown('first');
    vi.advanceTimersByTime(4_001);
    expect(kernel.phase.kind).toBe('reconnecting');
    expect(onGraceStarted).toHaveBeenCalledTimes(1);

    transport.emitDown('second-while-reconnecting');
    transport.emitDown('third-while-reconnecting');
    expect(onGraceStarted).toHaveBeenCalledTimes(1);
  });
});

describe('attachTransportWatchdog — phase-change cancellation', () => {
  it('cancels pending grace timer when phase leaves online/reconnecting', () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlinePhase() });
    const transport = new FakeTransport({ spec: GATING_SPEC });
    const onConfirmed = vi.fn();
    const onGraceCleared = vi.fn();

    attachTransportWatchdog({ kernel, transports: [transport], onConfirmed, onGraceCleared });
    transport.emitDown('flap');

    kernel.dispatch({ type: 'RESET' });

    expect(onGraceCleared).toHaveBeenCalledWith('socketio', 'phase-change');
    vi.advanceTimersByTime(10_000);
    expect(onConfirmed).not.toHaveBeenCalled();
  });
});

describe('attachTransportWatchdog — detach', () => {
  it('cancels all pending timers and unsubscribes', () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlinePhase() });
    const transport = new FakeTransport({ spec: GATING_SPEC });
    const onConfirmed = vi.fn();
    const onGraceCleared = vi.fn();
    const dispatchSpy = vi.spyOn(kernel, 'dispatch');

    const detach = attachTransportWatchdog({ kernel, transports: [transport], onConfirmed, onGraceCleared });
    transport.emitDown('flap');
    detach();

    expect(onGraceCleared).toHaveBeenCalledWith('socketio', 'detach');
    vi.advanceTimersByTime(10_000);
    expect(onConfirmed).not.toHaveBeenCalled();

    dispatchSpy.mockClear();
    transport.emitUp();
    expect(dispatchSpy).not.toHaveBeenCalled();
  });
});
