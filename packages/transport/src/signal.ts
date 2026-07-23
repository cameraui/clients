import type { Kernel } from './core/kernel.js';
import type { TransportId } from './core/types.js';
import type { Transport } from './transports/contract.js';

export type ConnectionSignal =
  | { readonly kind: 'connecting' }
  | { readonly kind: 'online' }
  | { readonly kind: 'degraded'; readonly channels: readonly TransportId[] }
  | { readonly kind: 'offline'; readonly retryAt?: number }
  | { readonly kind: 'needs-auth' };

export interface ConnectionSignalOptions {
  readonly kernel: Kernel;
  readonly transports: readonly Transport[];
  readonly debounceMs?: number;
}

export interface ConnectionSignalHandle {
  readonly current: ConnectionSignal;
  raw(): ConnectionSignal;
  recompute(): void;
  subscribe(listener: (signal: ConnectionSignal) => void): () => void;
  dispose(): void;
}

const DEFAULT_DEBOUNCE_MS = 1_500;

export function signalEquals(a: ConnectionSignal, b: ConnectionSignal): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'degraded' && b.kind === 'degraded') return a.channels.join(',') === b.channels.join(',');
  if (a.kind === 'offline' && b.kind === 'offline') return a.retryAt === b.retryAt;
  return true;
}

export function createConnectionSignal(options: ConnectionSignalOptions): ConnectionSignalHandle {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const listeners = new Set<(signal: ConnectionSignal) => void>();
  const cleanups: Array<() => void> = [];
  let hasBeenOnline = false;
  let anyChannelEverUp = false;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingSignal: ConnectionSignal | null = null;
  let disposed = false;

  function compute(): ConnectionSignal {
    const phase = options.kernel.phase;
    switch (phase.kind) {
      case 'idle':
        return { kind: 'connecting' };
      case 'needs-auth':
        return { kind: 'needs-auth' };
      case 'offline':
        return { kind: 'offline', retryAt: phase.nextRetryAt };
      case 'discovering':
        return hasBeenOnline ? { kind: 'offline' } : { kind: 'connecting' };
      case 'online': {
        const channels = options.transports.filter((t) => t.spec.phaseGating && !t.health().up).map((t) => t.spec.id);
        if (channels.length === 0) return { kind: 'online' };
        // transports still doing their FIRST connect are not degraded
        return anyChannelEverUp ? { kind: 'degraded', channels } : { kind: 'connecting' };
      }
    }
  }

  let current: ConnectionSignal = compute();

  function clearPending(): void {
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
      pendingSignal = null;
    }
  }

  function apply(next: ConnectionSignal): void {
    clearPending();
    if (signalEquals(current, next)) return;
    current = next;
    for (const listener of [...listeners]) {
      try {
        listener(next);
      } catch {
        // ignore
      }
    }
  }

  function recompute(): void {
    if (disposed) return;
    const raw = compute();
    if (signalEquals(current, raw)) {
      clearPending();
      return;
    }
    // improvements and hard states land instantly; badness must persist
    if (raw.kind === 'online' || raw.kind === 'connecting' || raw.kind === 'needs-auth') {
      apply(raw);
      return;
    }
    if (pendingSignal && pendingSignal.kind === raw.kind) {
      pendingSignal = raw; // keep the original timer, refresh the payload
      return;
    }
    clearPending();
    pendingSignal = raw;
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      const held = pendingSignal;
      pendingSignal = null;
      if (held) apply(compute().kind === held.kind ? compute() : held);
    }, debounceMs);
  }

  cleanups.push(
    options.kernel.subscribe((next) => {
      if (next.kind === 'online') hasBeenOnline = true;
      else if (next.kind === 'idle') {
        hasBeenOnline = false;
        anyChannelEverUp = false;
      }
      recompute();
    }),
  );
  for (const transport of options.transports) {
    cleanups.push(
      transport.on('up', () => {
        anyChannelEverUp = true;
        recompute();
      }),
    );
    cleanups.push(transport.on('down', () => recompute()));
  }

  return {
    get current() {
      return current;
    },
    raw: () => compute(),
    recompute,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      clearPending();
      for (const fn of cleanups) fn();
      listeners.clear();
    },
  };
}
