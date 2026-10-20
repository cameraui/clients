import type { Kernel } from '../core/kernel.js';
import type { ConnectionSignal, ConnectionSignalHandle } from '../signal.js';
import type { BackgroundProbeOutcome } from './backgroundProbe.js';

export type Detach = () => void;

export interface DegradedRecoveryOptions {
  readonly kernel: Kernel;
  readonly signal: ConnectionSignalHandle;
  readonly ensureAll: () => void;
  readonly probe: () => Promise<BackgroundProbeOutcome>;
  readonly graceMs?: number;
  readonly maxBackoffMs?: number;
  readonly isReachable?: () => boolean;
  readonly onEscalate?: (round: number) => void;
  readonly onOffline?: (reason: string) => void;
  readonly onHold?: (reason: string) => void;
}

const DEFAULT_GRACE_MS = 10_000;
const DEFAULT_MAX_BACKOFF_MS = 300_000;

export function attachDegradedRecovery(options: DegradedRecoveryOptions): Detach {
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let round = 0;
  // rounds in a row that ended with a channel up
  let backoff = 0;
  let channels = '';
  let detached = false;

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function disarm(): void {
    clearTimer();
    round = 0;
    backoff = 0;
    channels = '';
  }

  function arm(): void {
    if (detached || timer !== null) return;
    timer = setTimeout(
      () => {
        timer = null;
        escalate();
      },
      Math.min(graceMs * 2 ** backoff, maxBackoffMs),
    );
  }

  function rearm(): void {
    backoff = options.isReachable?.() ? backoff + 1 : 0;
    arm();
  }

  async function escalate(): Promise<void> {
    if (detached || options.signal.current.kind !== 'degraded') return;
    round++;
    options.onEscalate?.(round);
    options.ensureAll();
    const outcome = await options.probe();
    if (detached || options.signal.current.kind !== 'degraded') return;
    if (outcome === 'failed') {
      // false negative when a channel is already back, on a cold-radio wake the probe can time out while nats is up
      if (options.isReachable?.()) {
        options.onHold?.('probe failed but a channel is up — holding');
        rearm();
        return;
      }
      options.onOffline?.('degraded: endpoint unreachable');
      options.kernel.dispatch({ type: 'PROBE_FAILED_ALL', error: 'degraded: endpoint unreachable' });
      return;
    }
    // endpoint reachable: the channels own their recovery
    rearm();
  }

  function lostWanTarget(): boolean {
    const phase = options.kernel.phase;
    return phase.kind === 'online' && phase.target.endpoint.mode === 'direct-wan' && options.isReachable?.() === false;
  }

  function onDegraded(signal: Extract<ConnectionSignal, { kind: 'degraded' }>): void {
    const next = signal.channels.join(',');
    if (next !== channels) {
      channels = next;
      if (backoff > 0) {
        backoff = 0;
        clearTimer();
      }
    }
    if (round === 0 && lostWanTarget()) {
      disarm();
      escalate();
    } else arm();
  }

  const unsub = options.signal.subscribe((next) => {
    if (next.kind === 'degraded') onDegraded(next);
    else disarm();
  });
  if (options.signal.current.kind === 'degraded') onDegraded(options.signal.current);

  return () => {
    detached = true;
    disarm();
    unsub();
  };
}
