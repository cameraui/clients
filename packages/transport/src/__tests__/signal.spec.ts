import { describe, expect, it, vi } from 'vitest';

import { createKernel } from '../core/kernel.js';
import { createConnectionSignal } from '../signal.js';
import { FakeTransport } from '../testing/fakeTransport.js';

import type { ConnectionPhase, Endpoint, ReducerContext, Tokens, TransportSpec } from '../core/types.js';

const LAN: Endpoint = { url: 'https://lan.local', mode: 'direct-lan' };
const TOKENS: Tokens = { access: 'at' };

const SPECS: ReadonlyMap<string, TransportSpec> = new Map([
  ['socketio', { id: 'socketio', kind: 'persistent', phaseGating: true }],
  ['nats', { id: 'nats', kind: 'persistent', phaseGating: true }],
]);

function makeCtx(): ReducerContext {
  return { now: () => Date.now() };
}

function onlinePhase(): ConnectionPhase {
  return { kind: 'online', instanceId: 'a', target: { endpoint: LAN, tokens: TOKENS } };
}

function setup(initial?: ConnectionPhase) {
  const kernel = createKernel({ context: makeCtx(), initial });
  const socketio = new FakeTransport({ spec: SPECS.get('socketio')! });
  const nats = new FakeTransport({ spec: SPECS.get('nats')! });
  const handle = createConnectionSignal({ kernel, transports: [socketio, nats], debounceMs: 1_000 });
  return { kernel, socketio, nats, handle };
}

describe('createConnectionSignal', () => {
  it('starts connecting on idle and needs no debounce toward online', async () => {
    const { kernel, socketio, nats, handle } = setup();
    expect(handle.current.kind).toBe('connecting');

    kernel.dispatch({ type: 'BOOT', instanceId: 'a' });
    expect(handle.current.kind).toBe('connecting');

    await socketio.apply(onlinePhase().kind === 'online' ? { endpoint: LAN, tokens: TOKENS } : null);
    await nats.apply({ endpoint: LAN, tokens: TOKENS });
    kernel.dispatch({ type: 'PROBE_SUCCEEDED', endpoint: LAN, tokens: TOKENS });
    expect(handle.current.kind).toBe('online');
    handle.dispose();
  });

  it('one gating transport down → degraded after debounce, back to online instantly', async () => {
    vi.useFakeTimers();
    try {
      const { socketio, nats, handle } = setup(onlinePhase());
      await socketio.apply({ endpoint: LAN, tokens: TOKENS });
      await nats.apply({ endpoint: LAN, tokens: TOKENS });
      handle.recompute();
      expect(handle.current.kind).toBe('online');

      socketio.emitDown('transport error');
      expect(handle.current.kind).toBe('online'); // debounce holds
      await vi.advanceTimersByTimeAsync(1_100);
      expect(handle.current).toEqual({ kind: 'degraded', channels: ['socketio'] });

      socketio.emitUp();
      expect(handle.current.kind).toBe('online'); // instant recovery
      handle.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a blip shorter than the debounce never surfaces', async () => {
    vi.useFakeTimers();
    try {
      const { socketio, nats, handle } = setup(onlinePhase());
      await socketio.apply({ endpoint: LAN, tokens: TOKENS });
      await nats.apply({ endpoint: LAN, tokens: TOKENS });
      handle.recompute();
      const seen: string[] = [];
      handle.subscribe((s) => seen.push(s.kind));

      socketio.emitDown('blip');
      await vi.advanceTimersByTimeAsync(400);
      socketio.emitUp();
      await vi.advanceTimersByTimeAsync(2_000);

      expect(seen).toEqual([]);
      expect(handle.current.kind).toBe('online');
      handle.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('needs-auth applies instantly', () => {
    const { kernel, handle } = setup(onlinePhase());
    kernel.dispatch({ type: 'TOKENS_INVALID', reason: 'rejected' });
    expect(handle.current.kind).toBe('needs-auth');
    handle.dispose();
  });

  it('offline carries retryAt and is debounced', async () => {
    vi.useFakeTimers();
    try {
      const { kernel, socketio, nats, handle } = setup(onlinePhase());
      await socketio.apply({ endpoint: LAN, tokens: TOKENS });
      await nats.apply({ endpoint: LAN, tokens: TOKENS });
      handle.recompute();
      kernel.dispatch({ type: 'TOKENS_INVALID', reason: 'flaky', transient: true });
      expect(handle.current.kind).toBe('online'); // held
      await vi.advanceTimersByTimeAsync(1_100);
      expect(handle.current.kind).toBe('offline');
      expect(handle.current.kind === 'offline' && typeof handle.current.retryAt).toBe('number');
      handle.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('online phase with healthy transports reads online, phase stays online while channels die', async () => {
    vi.useFakeTimers();
    try {
      const { kernel, socketio, nats, handle } = setup(onlinePhase());
      await socketio.apply({ endpoint: LAN, tokens: TOKENS });
      await nats.apply({ endpoint: LAN, tokens: TOKENS });
      handle.recompute();
      expect(handle.current.kind).toBe('online');

      socketio.emitDown('gone');
      nats.emitDown('gone');
      await vi.advanceTimersByTimeAsync(1_100);
      // channel death is a signal concern only — the session phase holds
      expect(kernel.phase.kind).toBe('online');
      expect(handle.current.kind).toBe('degraded');
      handle.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createConnectionSignal — first connect is not degraded', () => {
  it('reads connecting while gating transports do their first connect, degraded only after they were up once', async () => {
    vi.useFakeTimers();
    try {
      const { kernel, socketio, nats, handle } = setup();
      kernel.dispatch({ type: 'BOOT', instanceId: 'a' });
      kernel.dispatch({ type: 'PROBE_SUCCEEDED', endpoint: LAN, tokens: TOKENS });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(handle.current.kind).toBe('connecting');

      await socketio.apply({ endpoint: LAN, tokens: TOKENS });
      await nats.apply({ endpoint: LAN, tokens: TOKENS });
      expect(handle.current.kind).toBe('online');

      socketio.emitDown('drop');
      await vi.advanceTimersByTimeAsync(1_600);
      expect(handle.current.kind).toBe('degraded');
      handle.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
