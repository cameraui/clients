import type { Kernel } from '../core/kernel.js';
import type { ConnectionSignalHandle } from '../signal.js';
import type { BackgroundProbeOutcome } from './backgroundProbe.js';

export type Detach = () => void;

export interface DegradedRecoveryOptions {
  readonly kernel: Kernel;
  readonly signal: ConnectionSignalHandle;
  readonly ensureAll: () => void;
  readonly probe: () => Promise<BackgroundProbeOutcome>;
  readonly graceMs?: number;
  readonly onEscalate?: (round: number) => void;
  readonly onOffline?: (reason: string) => void;
}

const DEFAULT_GRACE_MS = 10_000;

export function attachDegradedRecovery(options: DegradedRecoveryOptions): Detach {
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let round = 0;
  let detached = false;

  function disarm(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    round = 0;
  }

  function arm(): void {
    if (detached || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void escalate();
    }, graceMs);
  }

  async function escalate(): Promise<void> {
    if (detached || options.signal.current.kind !== 'degraded') return;
    round++;
    options.onEscalate?.(round);
    options.ensureAll();
    const outcome = await options.probe();
    if (detached || options.signal.current.kind !== 'degraded') return;
    if (outcome === 'failed') {
      options.onOffline?.('degraded: endpoint unreachable');
      options.kernel.dispatch({ type: 'PROBE_FAILED_ALL', error: 'degraded: endpoint unreachable' });
      return;
    }
    // endpoint reachable (or swapped): the channels own their recovery,
    // check again after the next grace window
    arm();
  }

  const unsub = options.signal.subscribe((next) => {
    if (next.kind === 'degraded') arm();
    else disarm();
  });
  if (options.signal.current.kind === 'degraded') arm();

  return () => {
    detached = true;
    disarm();
    unsub();
  };
}
