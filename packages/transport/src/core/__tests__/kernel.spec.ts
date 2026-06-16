import { describe, expect, it, vi } from 'vitest';

import { createKernel } from '../kernel.js';

import type { ConnectionPhase, Endpoint, ReducerContext, Tokens, TransportSpec } from '../types.js';

const LAN: Endpoint = { url: 'https://192.168.1.10:3443', mode: 'direct-lan' };
const TOKENS: Tokens = { access: 'at' };

const SPECS: ReadonlyMap<string, TransportSpec> = new Map([
  ['http', { id: 'http', kind: 'request', phaseGating: false }],
  ['socketio', { id: 'socketio', kind: 'persistent', phaseGating: true }],
]);

function makeContext(overrides: Partial<ReducerContext> = {}): ReducerContext {
  return { specs: SPECS, now: () => 1000, ...overrides };
}

describe('createKernel', () => {
  it('defaults to idle', () => {
    const k = createKernel({ context: makeContext() });
    expect(k.phase).toEqual({ kind: 'idle' });
  });

  it('accepts an initial phase', () => {
    const initial: ConnectionPhase = {
      kind: 'online',
      instanceId: 'a',
      target: { endpoint: LAN, tokens: TOKENS },
      transports: new Map(),
    };
    const k = createKernel({ context: makeContext(), initial });
    expect(k.phase).toBe(initial);
  });

  it('dispatch updates phase', () => {
    const k = createKernel({ context: makeContext() });
    k.dispatch({ type: 'BOOT', instanceId: 'a' });
    expect(k.phase.kind).toBe('discovering');
  });

  it('subscribers receive (next, prev, action) on transition', () => {
    const k = createKernel({ context: makeContext() });
    const listener = vi.fn();
    k.subscribe(listener);
    k.dispatch({ type: 'BOOT', instanceId: 'a' });
    expect(listener).toHaveBeenCalledTimes(1);
    const [next, prev, action] = listener.mock.calls[0]!;
    expect((next as ConnectionPhase).kind).toBe('discovering');
    expect((prev as ConnectionPhase).kind).toBe('idle');
    expect(action).toEqual({ type: 'BOOT', instanceId: 'a' });
  });

  it('no-op actions do not notify subscribers', () => {
    const k = createKernel({ context: makeContext() });
    const listener = vi.fn();
    k.subscribe(listener);
    k.dispatch({ type: 'USER_RETRY' });
    expect(listener).not.toHaveBeenCalled();
  });

  it('unsubscribe stops future notifications', () => {
    const k = createKernel({ context: makeContext() });
    const listener = vi.fn();
    const off = k.subscribe(listener);
    off();
    k.dispatch({ type: 'BOOT', instanceId: 'a' });
    expect(listener).not.toHaveBeenCalled();
  });

  it('re-entrant dispatch in a subscriber is queued (FIFO)', () => {
    const k = createKernel({ context: makeContext() });
    const seen: string[] = [];
    let dispatchedOnce = false;
    k.subscribe((p) => {
      seen.push(p.kind);
      if (!dispatchedOnce && p.kind === 'discovering') {
        dispatchedOnce = true;
        k.dispatch({ type: 'PROBE_FAILED_ALL', error: 'down' });
      }
    });
    k.dispatch({ type: 'BOOT', instanceId: 'a' });
    expect(seen).toEqual(['discovering', 'offline']);
    expect(k.phase.kind).toBe('offline');
  });

  it('dispose() makes future dispatch a no-op', () => {
    const k = createKernel({ context: makeContext() });
    const listener = vi.fn();
    k.subscribe(listener);
    k.dispose();
    k.dispatch({ type: 'BOOT', instanceId: 'a' });
    expect(listener).not.toHaveBeenCalled();
    expect(k.phase).toEqual({ kind: 'idle' });
  });

  it('subscribing during a notification does not affect that iteration', () => {
    const k = createKernel({ context: makeContext() });
    const lateListener = vi.fn();
    k.subscribe(() => {
      k.subscribe(lateListener);
    });
    k.dispatch({ type: 'BOOT', instanceId: 'a' });
    expect(lateListener).not.toHaveBeenCalled();
    k.dispatch({ type: 'PROBE_FAILED_ALL', error: 'x' });
    expect(lateListener).toHaveBeenCalledTimes(1);
  });
});
