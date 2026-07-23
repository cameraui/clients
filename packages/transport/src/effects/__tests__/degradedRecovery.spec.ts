import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createKernel } from '../../core/kernel.js';
import { createConnectionSignal } from '../../signal.js';
import { FakeTransport } from '../../testing/fakeTransport.js';
import { attachDegradedRecovery } from '../degradedRecovery.js';

import type { ConnectionPhase, Endpoint, ReducerContext, Tokens, TransportSpec } from '../../core/types.js';
import type { BackgroundProbeOutcome } from '../backgroundProbe.js';

const LAN: Endpoint = { url: 'https://lan.local', mode: 'direct-lan' };
const TOKENS: Tokens = { access: 'at' };
const SOCKETIO_SPEC: TransportSpec = { id: 'socketio', kind: 'persistent', phaseGating: true };

function makeCtx(): ReducerContext {
  return { now: () => Date.now() };
}

function onlinePhase(): ConnectionPhase {
  return { kind: 'online', instanceId: 'a', target: { endpoint: LAN, tokens: TOKENS } };
}

async function setup(probeOutcomes: BackgroundProbeOutcome[]) {
  const kernel = createKernel({ context: makeCtx(), initial: onlinePhase() });
  const socketio = new FakeTransport({ spec: SOCKETIO_SPEC });
  const signal = createConnectionSignal({ kernel, transports: [socketio], debounceMs: 100 });
  const ensureAll = vi.fn();
  const probe = vi.fn(async () => probeOutcomes.shift() ?? ('same' as BackgroundProbeOutcome));
  const detach = attachDegradedRecovery({ kernel, signal, ensureAll, probe, graceMs: 1_000 });
  await socketio.apply({ endpoint: LAN, tokens: TOKENS });
  return { kernel, socketio, signal, ensureAll, probe, detach };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('attachDegradedRecovery', () => {
  it('arms on degraded and escalates after graceMs (ensureAll + probe)', async () => {
    const { socketio, signal, ensureAll, probe, detach } = await setup(['same']);

    socketio.emitDown('gone');
    await vi.advanceTimersByTimeAsync(150);
    expect(signal.current.kind).toBe('degraded');
    expect(ensureAll).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(ensureAll).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(1);
    detach();
  });

  it('probe failed while still degraded → PROBE_FAILED_ALL, kernel drops to offline', async () => {
    const { kernel, socketio, detach } = await setup(['failed']);

    socketio.emitDown('gone');
    await vi.advanceTimersByTimeAsync(150);
    expect(kernel.phase.kind).toBe('online');

    await vi.advanceTimersByTimeAsync(1_000);
    expect(kernel.phase.kind).toBe('offline');
    if (kernel.phase.kind === 'offline') {
      expect(kernel.phase.lastError).toContain('unreachable');
    }
    detach();
  });

  it('probe same → re-arms and escalates again a round later', async () => {
    const { kernel, socketio, ensureAll, probe, detach } = await setup(['same', 'failed']);

    socketio.emitDown('gone');
    await vi.advanceTimersByTimeAsync(150);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(kernel.phase.kind).toBe('online'); // endpoint reachable, channels own recovery

    await vi.advanceTimersByTimeAsync(1_000);
    expect(ensureAll).toHaveBeenCalledTimes(2);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(kernel.phase.kind).toBe('offline');
    detach();
  });

  it('signal recovering to online disarms (no escalation, no dispatch)', async () => {
    const { kernel, socketio, signal, ensureAll, probe, detach } = await setup(['failed']);

    socketio.emitDown('gone');
    await vi.advanceTimersByTimeAsync(150);
    expect(signal.current.kind).toBe('degraded');

    socketio.emitUp();
    expect(signal.current.kind).toBe('online');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ensureAll).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
    expect(kernel.phase.kind).toBe('online');
    detach();
  });

  it('detach cancels a pending escalation', async () => {
    const { kernel, socketio, ensureAll, probe, detach } = await setup(['failed']);

    socketio.emitDown('gone');
    await vi.advanceTimersByTimeAsync(150);
    detach();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(ensureAll).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
    expect(kernel.phase.kind).toBe('online');
  });
});
