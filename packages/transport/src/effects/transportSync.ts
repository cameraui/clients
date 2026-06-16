import type { Kernel } from '../core/kernel.js';
import type { ConnectionPhase, ConnectionTarget } from '../core/types.js';
import type { Transport } from '../transports/contract.js';
import { isSameTarget } from '../transports/contract.js';

export type Detach = () => void;

export interface TransportSyncOptions {
  readonly kernel: Kernel;
  readonly transports: readonly Transport[];
  readonly onError?: (transport: Transport, target: ConnectionTarget | null, error: unknown) => void;
  readonly onApplied?: (target: ConnectionTarget | null) => void;
}

const SKIP = Symbol('transport-sync-skip');
type SyncDecision = ConnectionTarget | null | typeof SKIP;

function syncTargetFor(phase: ConnectionPhase): SyncDecision {
  switch (phase.kind) {
    case 'idle':
    case 'offline':
    case 'needs-auth':
      return null;
    case 'online':
      return phase.target;
    case 'reconnecting':
      // lastTarget can be null only if we never made it to online — same
      // tear-down semantics as idle/offline.
      return phase.lastTarget;
    case 'discovering':
      // Hold the previous target while probing — transports stay on their
      // current connection until a new one is committed via online.
      return SKIP;
  }
}

export function attachTransportSync(options: TransportSyncOptions): Detach {
  let detached = false;
  let initialized = false;
  let lastApplied: ConnectionTarget | null = null;

  function applyAll(target: ConnectionTarget | null): void {
    if (detached) return;
    if (initialized && isSameTarget(lastApplied, target)) return;
    initialized = true;
    lastApplied = target;
    for (const transport of options.transports) {
      void transport.apply(target).catch((err: unknown) => {
        options.onError?.(transport, target, err);
      });
    }
    options.onApplied?.(target);
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
    unsub();
  };
}
