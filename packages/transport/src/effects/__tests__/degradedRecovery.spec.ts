import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createKernel } from '../../core/kernel.js';
import { createConnectionSignal } from '../../signal.js';
import { FakeTransport } from '../../testing/fakeTransport.js';
import { attachDegradedRecovery } from '../degradedRecovery.js';

import type { ConnectionPhase, Endpoint, ReducerContext, Tokens, TransportSpec } from '../../core/types.js';
import type { BackgroundProbeOutcome } from '../backgroundProbe.js';

const LAN: Endpoint = { url: 'https://lan.local', mode: 'direct-lan' };
const WAN: Endpoint = { url: 'https://abc.trycloudflare.com', mode: 'direct-wan' };
const TOKENS: Tokens = { access: 'at' };
const SOCKETIO_SPEC: TransportSpec = { id: 'socketio', kind: 'persistent', phaseGating: true };
const NATS_SPEC: TransportSpec = { id: 'nats', kind: 'persistent', phaseGating: true };

function makeCtx(): ReducerContext {
  return { now: () => Date.now() };
}

function onlinePhase(endpoint = LAN): ConnectionPhase {
  return { kind: 'online', instanceId: 'a', target: { endpoint, tokens: TOKENS } };
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

async function setupPair(probeOutcomes: BackgroundProbeOutcome[], endpoint = LAN) {
  const kernel = createKernel({ context: makeCtx(), initial: onlinePhase(endpoint) });
  const socketio = new FakeTransport({ spec: SOCKETIO_SPEC });
  const nats = new FakeTransport({ spec: NATS_SPEC });
  const signal = createConnectionSignal({ kernel, transports: [socketio, nats], debounceMs: 100 });
  const ensureAll = vi.fn();
  const probe = vi.fn(async () => probeOutcomes.shift() ?? ('same' as BackgroundProbeOutcome));
  const onHold = vi.fn();
  const isReachable = () => [socketio, nats].some((t) => t.health().up);
  const detach = attachDegradedRecovery({ kernel, signal, ensureAll, probe, graceMs: 1_000, isReachable, onHold });
  await socketio.apply({ endpoint, tokens: TOKENS });
  await nats.apply({ endpoint, tokens: TOKENS });
  return { kernel, socketio, nats, signal, ensureAll, probe, onHold, detach };
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

  it('probe failed but a channel is still up → holds online and re-arms (false-negative on cold-radio wake)', async () => {
    const { kernel, socketio, probe, onHold, detach } = await setupPair(['failed']);

    socketio.emitDown('gone'); // nats stays up
    await vi.advanceTimersByTimeAsync(150);
    expect(kernel.phase.kind).toBe('online');

    await vi.advanceTimersByTimeAsync(1_000);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(onHold).toHaveBeenCalledTimes(1);
    expect(kernel.phase.kind).toBe('online'); // held, not torn down

    await vi.advanceTimersByTimeAsync(2_000); // re-armed with backoff
    expect(probe).toHaveBeenCalledTimes(2);
    expect(kernel.phase.kind).toBe('online');
    detach();
  });

  it('probe failed and no channel up → still PROBE_FAILED_ALL (guard does not mask a real outage)', async () => {
    const { kernel, socketio, nats, onHold, detach } = await setupPair(['failed']);

    socketio.emitDown('gone');
    nats.emitDown('gone');
    await vi.advanceTimersByTimeAsync(150);
    expect(kernel.phase.kind).toBe('online');

    await vi.advanceTimersByTimeAsync(1_000);
    expect(kernel.phase.kind).toBe('offline');
    expect(onHold).not.toHaveBeenCalled();
    detach();
  });
});

describe('attachDegradedRecovery: WAN target with every channel down', () => {
  it('probes right away instead of waiting for the grace', async () => {
    const { kernel, socketio, nats, ensureAll, probe, detach } = await setupPair(['failed'], WAN);

    socketio.emitDown('gone');
    nats.emitDown('gone');
    await vi.advanceTimersByTimeAsync(150);
    expect(ensureAll).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(kernel.phase.kind).toBe('offline');
    detach();
  });

  it('skips the grace only for the first round', async () => {
    const { kernel, socketio, nats, probe, detach } = await setupPair(['same', 'same'], WAN);

    socketio.emitDown('gone');
    nats.emitDown('gone');
    await vi.advanceTimersByTimeAsync(150);
    expect(probe).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(900);
    expect(probe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(kernel.phase.kind).toBe('online');
    detach();
  });

  it('probes right away when the last channel drops after the grace was armed', async () => {
    const { socketio, nats, ensureAll, probe, detach } = await setupPair(['same'], WAN);

    socketio.emitDown('gone');
    await vi.advanceTimersByTimeAsync(300);
    expect(probe).not.toHaveBeenCalled();

    nats.emitDown('gone');
    await vi.advanceTimersByTimeAsync(150);
    expect(ensureAll).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(800);
    expect(probe).toHaveBeenCalledTimes(1);
    detach();
  });

  it('waits for the grace while one channel is still up', async () => {
    const { socketio, probe, detach } = await setupPair(['same'], WAN);

    socketio.emitDown('gone');
    await vi.advanceTimersByTimeAsync(150);
    expect(probe).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(probe).toHaveBeenCalledTimes(1);
    detach();
  });

  it('waits for the grace on a LAN target', async () => {
    const { socketio, nats, probe, detach } = await setupPair(['same']);

    socketio.emitDown('gone');
    nats.emitDown('gone');
    await vi.advanceTimersByTimeAsync(150);
    expect(probe).not.toHaveBeenCalled();
    detach();
  });
});

describe('attachDegradedRecovery: backoff while a channel stays up', () => {
  async function setupTriple(probeOutcomes: BackgroundProbeOutcome[] = []) {
    const kernel = createKernel({ context: makeCtx(), initial: onlinePhase() });
    const transports = ['socketio', 'nats', 'natsBulk'].map((id) => new FakeTransport({ spec: { id, kind: 'persistent', phaseGating: true } as TransportSpec }));
    const [socketio, nats, natsBulk] = transports;
    const signal = createConnectionSignal({ kernel, transports, debounceMs: 100 });
    const ensureAll = vi.fn();
    const probes: number[] = [];
    const probe = vi.fn(async () => {
      probes.push(Date.now());
      return probeOutcomes.shift() ?? ('same' as BackgroundProbeOutcome);
    });
    const onHold = vi.fn();
    const isReachable = () => transports.some((t) => t.health().up);
    const detach = attachDegradedRecovery({ kernel, signal, ensureAll, probe, graceMs: 1_000, maxBackoffMs: 8_000, isReachable, onHold });
    for (const t of transports) await t.apply({ endpoint: LAN, tokens: TOKENS });
    return { kernel, socketio, nats, natsBulk, ensureAll, probe, probes, onHold, detach };
  }

  function gaps(times: number[]): number[] {
    return times.slice(1).map((t, i) => Math.round((t - times[i]) / 100) * 100);
  }

  it('doubles the wait after each round up to the cap', async () => {
    const { nats, probes, ensureAll, detach } = await setupTriple();

    nats.emitDown('upgrade blocked');
    await vi.advanceTimersByTimeAsync(100 + 1_000 + 2_000 + 4_000 + 8_000 + 8_000 + 50);
    expect(gaps(probes)).toEqual([2_000, 4_000, 8_000, 8_000]);
    expect(ensureAll).toHaveBeenCalledTimes(5);
    detach();
  });

  it('backs off after a failed probe that it held because a channel is up', async () => {
    const { nats, probes, onHold, kernel, detach } = await setupTriple(['failed', 'failed', 'failed']);

    nats.emitDown('upgrade blocked');
    await vi.advanceTimersByTimeAsync(100 + 1_000 + 2_000 + 4_000 + 50);
    expect(gaps(probes)).toEqual([2_000, 4_000]);
    expect(onHold).toHaveBeenCalledTimes(3);
    expect(kernel.phase.kind).toBe('online');
    detach();
  });

  it('starts over at the grace when another channel drops', async () => {
    const { nats, natsBulk, probes, detach } = await setupTriple();

    nats.emitDown('upgrade blocked');
    await vi.advanceTimersByTimeAsync(100 + 1_000 + 2_000 + 50);
    expect(probes).toHaveLength(2);

    natsBulk.emitDown('upgrade blocked');
    await vi.advanceTimersByTimeAsync(100 + 1_000);
    expect(probes).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(probes).toHaveLength(4);
    detach();
  });

  it('keeps the grace while no channel is up', async () => {
    const { socketio, nats, natsBulk, probes, detach } = await setupTriple();

    for (const t of [socketio, nats, natsBulk]) t.emitDown('gone');
    await vi.advanceTimersByTimeAsync(100 + 1_000 * 4 + 50);
    expect(gaps(probes)).toEqual([1_000, 1_000, 1_000]);
    detach();
  });

  it('starts over at the grace after the channels came back', async () => {
    const { nats, probes, detach } = await setupTriple();

    nats.emitDown('upgrade blocked');
    await vi.advanceTimersByTimeAsync(100 + 1_000 + 2_000 + 50);
    expect(probes).toHaveLength(2);

    nats.emitUp();
    nats.emitDown('upgrade blocked again');
    await vi.advanceTimersByTimeAsync(100 + 1_000);
    expect(probes).toHaveLength(3);
    detach();
  });
});
