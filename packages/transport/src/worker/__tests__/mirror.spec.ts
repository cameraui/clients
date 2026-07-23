import { describe, expect, it, vi } from 'vitest';

import { createWorkerKernelMirror } from '../mirror.js';

import type { ConnectionPhase, Endpoint, Tokens } from '../../core/types.js';
import type { KernelSyncMessage, MessageSource, WorkerMessage } from '../protocol.js';

const LAN: Endpoint = { url: 'https://nvr.local', mode: 'direct-lan' };
const TOKENS: Tokens = { access: 'at-1' };

function onlinePhase(): ConnectionPhase {
  return {
    kind: 'online',
    instanceId: 'a',
    target: { endpoint: LAN, tokens: TOKENS },
  };
}

function makeSyncMessage(generation: number, phase: ConnectionPhase): KernelSyncMessage {
  return { type: 'kernel-sync', generation, phase };
}

class FakeSource implements MessageSource {
  private listeners = new Set<(event: MessageEvent<WorkerMessage>) => void>();
  readonly sent: WorkerMessage[] = [];

  postMessage(message: WorkerMessage): void {
    this.sent.push(message);
  }

  addEventListener(_type: 'message', listener: (event: MessageEvent<WorkerMessage>) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'message', listener: (event: MessageEvent<WorkerMessage>) => void): void {
    this.listeners.delete(listener);
  }

  /** Test helper — simulate the main thread delivering a message. */
  deliver(msg: WorkerMessage): void {
    const event = new MessageEvent<WorkerMessage>('message', { data: msg });
    for (const l of [...this.listeners]) l(event);
  }
}

describe('createWorkerKernelMirror', () => {
  it('starts at idle by default', () => {
    const source = new FakeSource();
    const mirror = createWorkerKernelMirror({ source });
    expect(mirror.phase).toEqual({ kind: 'idle' });
    expect(mirror.target).toBeNull();
  });

  it('honors initial phase override', () => {
    const source = new FakeSource();
    const phase = onlinePhase();
    const mirror = createWorkerKernelMirror({ source, initial: phase });
    expect(mirror.phase).toBe(phase);
    expect(mirror.target).toEqual(phase.kind === 'online' ? phase.target : null);
  });

  it('updates phase + notifies subscribers on kernel-sync', () => {
    const source = new FakeSource();
    const mirror = createWorkerKernelMirror({ source });
    const listener = vi.fn();
    mirror.subscribe(listener);

    const phase = onlinePhase();
    source.deliver(makeSyncMessage(1, phase));

    expect(mirror.phase).toBe(phase);
    expect(listener).toHaveBeenCalledWith(phase, { kind: 'idle' });
  });

  it('exposes target via the convenience accessor', () => {
    const source = new FakeSource();
    const mirror = createWorkerKernelMirror({ source });

    source.deliver(makeSyncMessage(1, onlinePhase()));
    expect(mirror.target?.endpoint).toBe(LAN);
    expect(mirror.target?.tokens).toBe(TOKENS);

    // offline → no target
    source.deliver(makeSyncMessage(2, { kind: 'offline', instanceId: 'a', lastError: 'x', nextRetryAt: 0 }));
    expect(mirror.target).toBeNull();
  });

  it('drops stale generations (out-of-order delivery)', () => {
    const source = new FakeSource();
    const mirror = createWorkerKernelMirror({ source });
    const listener = vi.fn();
    mirror.subscribe(listener);

    source.deliver(makeSyncMessage(5, onlinePhase()));
    expect(listener).toHaveBeenCalledTimes(1);

    // Old generation arrives later (race) — ignored.
    source.deliver(makeSyncMessage(3, { kind: 'idle' }));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(mirror.phase.kind).toBe('online');
  });

  it('drops duplicate generations', () => {
    const source = new FakeSource();
    const mirror = createWorkerKernelMirror({ source });
    const listener = vi.fn();
    mirror.subscribe(listener);

    source.deliver(makeSyncMessage(1, onlinePhase()));
    source.deliver(makeSyncMessage(1, { kind: 'idle' }));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('ignores non-kernel-sync messages', () => {
    const source = new FakeSource();
    const mirror = createWorkerKernelMirror({ source });
    const listener = vi.fn();
    mirror.subscribe(listener);

    // @ts-expect-error - intentionally malformed for the test
    source.deliver({ type: 'unrelated', payload: 'noise' });
    source.deliver(makeSyncMessage(1, onlinePhase()));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('requestSync posts a request back to the main thread', () => {
    const source = new FakeSource();
    const mirror = createWorkerKernelMirror({ source });

    mirror.requestSync();
    expect(source.sent).toEqual([{ type: 'kernel-sync-request' }]);
  });

  it('a thrown listener does not block other listeners', () => {
    const source = new FakeSource();
    const mirror = createWorkerKernelMirror({ source });
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const good = vi.fn();
    mirror.subscribe(bad);
    mirror.subscribe(good);

    source.deliver(makeSyncMessage(1, onlinePhase()));
    expect(bad).toHaveBeenCalled();
    expect(good).toHaveBeenCalled();
  });

  it('unsubscribe stops further notifications', () => {
    const source = new FakeSource();
    const mirror = createWorkerKernelMirror({ source });
    const listener = vi.fn();
    const unsub = mirror.subscribe(listener);

    source.deliver(makeSyncMessage(1, onlinePhase()));
    unsub();
    source.deliver(makeSyncMessage(2, { kind: 'idle' }));

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('dispose removes the message handler and clears listeners', () => {
    const source = new FakeSource();
    const mirror = createWorkerKernelMirror({ source });
    const listener = vi.fn();
    mirror.subscribe(listener);

    mirror.dispose();
    source.deliver(makeSyncMessage(1, onlinePhase()));
    expect(listener).not.toHaveBeenCalled();

    // requestSync after dispose is a no-op (defensive).
    mirror.requestSync();
    expect(source.sent).toEqual([]);
  });

  it('onRevalidate fires on a kernel-revalidate message (stateless, repeatable)', () => {
    const source = new FakeSource();
    const mirror = createWorkerKernelMirror({ source });
    const listener = vi.fn();
    mirror.onRevalidate(listener);

    source.deliver({ type: 'kernel-revalidate' });
    expect(listener).toHaveBeenCalledTimes(1);
    // Stateless — no dedup, every message re-fires.
    source.deliver({ type: 'kernel-revalidate' });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('kernel-revalidate does not touch phase or notify phase subscribers', () => {
    const source = new FakeSource();
    const mirror = createWorkerKernelMirror({ source, initial: onlinePhase() });
    const phaseListener = vi.fn();
    mirror.subscribe(phaseListener);

    source.deliver({ type: 'kernel-revalidate' });
    expect(phaseListener).not.toHaveBeenCalled();
    expect(mirror.phase.kind).toBe('online');
  });

  it('onRevalidate unsubscribe + dispose stop delivery', () => {
    const source = new FakeSource();
    const mirror = createWorkerKernelMirror({ source });
    const a = vi.fn();
    const off = mirror.onRevalidate(a);

    off();
    source.deliver({ type: 'kernel-revalidate' });
    expect(a).not.toHaveBeenCalled();

    const b = vi.fn();
    mirror.onRevalidate(b);
    mirror.dispose();
    source.deliver({ type: 'kernel-revalidate' });
    expect(b).not.toHaveBeenCalled();
  });
});
