import type { Kernel } from '../core/kernel.js';
import type { TransportId } from '../core/types.js';
import type { Transport } from '../transports/contract.js';

export type Detach = () => void;
export type WatchdogClearReason = 'up' | 'detach' | 'phase-change';

export interface TransportWatchdogOptions {
  readonly kernel: Kernel;
  readonly transports: readonly Transport[];
  readonly defaultGraceMs?: number;
  readonly setTimer?: (cb: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly onGraceStarted?: (id: TransportId, graceMs: number) => void;
  readonly onGraceCleared?: (id: TransportId, reason: WatchdogClearReason) => void;
  readonly onConfirmed?: (id: TransportId) => void;
}

const DEFAULT_GRACE_MS = 4_000;

export function attachTransportWatchdog(options: TransportWatchdogOptions): Detach {
  const defaultGraceMs = options.defaultGraceMs ?? DEFAULT_GRACE_MS;
  const setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  const timers = new Map<TransportId, unknown>();
  const cleanups: Array<() => void> = [];
  let detached = false;

  function cancelTimer(id: TransportId, reason: WatchdogClearReason): void {
    const handle = timers.get(id);
    if (handle !== undefined) {
      clearTimer(handle);
      timers.delete(id);
      options.onGraceCleared?.(id, reason);
    }
  }

  function cancelAll(reason: WatchdogClearReason): void {
    for (const id of [...timers.keys()]) {
      cancelTimer(id, reason);
    }
  }

  for (const transport of options.transports) {
    const spec = transport.spec;

    const offUp = transport.on('up', () => {
      if (detached) return;
      cancelTimer(spec.id, 'up');
      options.kernel.dispatch({ type: 'TRANSPORT_UP', id: spec.id });
    });

    const offDown = transport.on('down', (payload) => {
      if (detached) return;
      options.kernel.dispatch({ type: 'TRANSPORT_DOWN', id: spec.id, reason: payload.reason });
      if (!spec.phaseGating) return;
      // Grace period is only meaningful while online. Once we're in
      // reconnecting/offline/idle the phase has already moved past and
      // dispatching another DOWN_CONFIRMED would be a no-op.
      if (options.kernel.phase.kind !== 'online') return;
      // Coalesce repeated down events from the same transport: keep the
      // first timer running, don't restart on each flap.
      if (timers.has(spec.id)) return;
      const graceMs = spec.graceMs ?? defaultGraceMs;
      options.onGraceStarted?.(spec.id, graceMs);
      const handle = setTimer(() => {
        timers.delete(spec.id);
        if (detached) return;
        options.onConfirmed?.(spec.id);
        options.kernel.dispatch({ type: 'TRANSPORT_DOWN_CONFIRMED', id: spec.id });
      }, graceMs);
      timers.set(spec.id, handle);
    });

    cleanups.push(offUp, offDown);
  }

  const unsubKernel = options.kernel.subscribe((next, prev) => {
    // Grace timers only live during the online → reconnecting transition
    // window. Any departure from online cancels them — TRANSPORT_DOWN_CONFIRMED
    // (online → reconnecting), USER_RETRY out of reconnecting, RESET, etc.
    if (prev.kind === 'online' && next.kind !== 'online') {
      cancelAll('phase-change');
    }
  });
  cleanups.push(unsubKernel);

  return () => {
    detached = true;
    cancelAll('detach');
    for (const fn of cleanups) fn();
  };
}
