import type { Kernel } from '../core/kernel.js';
import type { ConnectionPhase, ConnectionTarget } from '../core/types.js';
import type { Transport } from '../transports/contract.js';
import { isSameTarget } from '../transports/contract.js';

export type Detach = () => void;

export interface TransportSyncOptions {
  readonly kernel: Kernel;
  readonly transports: readonly Transport[];
  readonly retryMs?: number;
  readonly onError?: (transport: Transport, target: ConnectionTarget | null, error: unknown) => void;
  readonly onRetry?: (transport: Transport, target: ConnectionTarget | null) => void;
  readonly onApplied?: (target: ConnectionTarget | null) => void;
}

const SKIP = Symbol('transport-sync-skip');
type SyncDecision = ConnectionTarget | null | typeof SKIP;

const DEFAULT_RETRY_MS = 2_000;

function syncTargetFor(phase: ConnectionPhase): SyncDecision {
  switch (phase.kind) {
    case 'idle':
    case 'offline':
    case 'needs-auth':
      return null;
    case 'online':
      return phase.target;
    case 'discovering':
      // Hold the previous target while probing — transports stay on their
      // current connection until a new one is committed via online.
      return SKIP;
  }
}

export function attachTransportSync(options: TransportSyncOptions): Detach {
  let detached = false;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  // applied state is per transport: a failed apply() rolls back only that
  // transport's entry and retries, so one transport's failed connect can no
  // longer orphan it behind a shared same-target dedupe
  const applied = new Map<Transport, ConnectionTarget | null>();
  const retryTimers = new Map<Transport, ReturnType<typeof setTimeout>>();
  let lastNotified: ConnectionTarget | null | undefined;

  function applyOne(transport: Transport, target: ConnectionTarget | null): void {
    applied.set(transport, target);
    void transport.apply(target).catch((err: unknown) => {
      options.onError?.(transport, target, err);
      if (applied.get(transport) === target) {
        applied.delete(transport);
        scheduleRetry(transport);
      }
    });
  }

  function scheduleRetry(transport: Transport): void {
    if (detached || retryTimers.has(transport)) return;
    const timer = setTimeout(() => {
      retryTimers.delete(transport);
      if (detached) return;
      const decision = syncTargetFor(options.kernel.phase);
      if (decision === SKIP) {
        scheduleRetry(transport);
        return;
      }
      if (applied.has(transport) && isSameTarget(applied.get(transport)!, decision)) return;
      options.onRetry?.(transport, decision);
      applyOne(transport, decision);
    }, retryMs);
    retryTimers.set(transport, timer);
  }

  function applyAll(target: ConnectionTarget | null): void {
    if (detached) return;
    for (const transport of options.transports) {
      if (applied.has(transport) && isSameTarget(applied.get(transport)!, target)) continue;
      applyOne(transport, target);
    }
    if (lastNotified === undefined || !isSameTarget(lastNotified, target)) {
      lastNotified = target;
      options.onApplied?.(target);
    }
  }

  function syncFromPhase(phase: ConnectionPhase): void {
    const decision = syncTargetFor(phase);
    if (decision === SKIP) return;
    applyAll(decision);
  }

  syncFromPhase(options.kernel.phase);

  const unsub = options.kernel.subscribe((next) => {
    syncFromPhase(next);
  });

  return () => {
    detached = true;
    for (const timer of retryTimers.values()) clearTimeout(timer);
    retryTimers.clear();
    unsub();
  };
}
