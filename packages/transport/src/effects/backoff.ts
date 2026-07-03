import type { Kernel } from '../core/kernel.js';
import type { ConnectionPhase } from '../core/types.js';

export type Detach = () => void;

export interface BackoffOptions {
  readonly kernel: Kernel;
  readonly schedule?: readonly number[];
  readonly firstAttemptDelayMs?: () => number | null | undefined;
  readonly now?: () => number;
  readonly setTimer?: (cb: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly onScheduled?: (attempt: number, delayMs: number) => void;
  readonly onFire?: (attempt: number) => void;
  readonly onCancelled?: (reason: 'phase-left-offline' | 'detach' | 'rescheduled') => void;
  readonly onHintApplied?: (delayMs: number, source?: string) => void;
}

const DEFAULT_SCHEDULE = [5_000, 10_000, 30_000, 60_000] as const;

type OfflinePhase = Extract<ConnectionPhase, { kind: 'offline' }>;

export function attachBackoff(options: BackoffOptions): Detach {
  const schedule = options.schedule ?? DEFAULT_SCHEDULE;
  if (schedule.length === 0) {
    throw new Error('backoff: schedule must have at least one entry');
  }
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let timer: unknown;
  let attempt = 0;
  let detached = false;

  function cancelTimer(reason?: 'phase-left-offline' | 'detach' | 'rescheduled'): void {
    if (timer !== undefined) {
      clearTimer(timer);
      timer = undefined;
      if (reason) options.onCancelled?.(reason);
    }
  }

  function scheduleFromPhase(phase: OfflinePhase, isReschedule: boolean): void {
    // Two sources for the delay: our own local `schedule[attempt]` (the
    // exponential bucket), and `phase.nextRetryAt` (potentially extended
    // by a server-issued BACKOFF_HINT). We take the LATER of the two —
    // never shorten below the server hint. Premature retries are the riskier
    // mode: they hammer the backend right when it's already strained. The
    // firstAttemptDelayMs hook may shorten only the LOCAL schedule, and only
    // for the first attempt (transient-failure fast path).
    cancelTimer(isReschedule ? 'rescheduled' : undefined);
    const baseDelay = schedule[Math.min(attempt, schedule.length - 1)]!;
    const quick = attempt === 0 ? options.firstAttemptDelayMs?.() : undefined;
    const scheduleDelay = typeof quick === 'number' && quick >= 0 ? Math.min(quick, baseDelay) : baseDelay;
    const phaseDelay = Math.max(0, phase.nextRetryAt - now());
    const delay = Math.max(scheduleDelay, phaseDelay);
    options.onScheduled?.(attempt + 1, delay);
    if (phase.backoffHint && phaseDelay > scheduleDelay) {
      options.onHintApplied?.(delay, phase.backoffHint.source);
    }
    timer = setTimer(() => {
      timer = undefined;
      if (detached) return;
      if (options.kernel.phase.kind !== 'offline') return;
      attempt += 1;
      options.onFire?.(attempt);
      options.kernel.dispatch({ type: 'USER_RETRY' });
    }, delay);
  }

  const unsubKernel = options.kernel.subscribe((next, prev) => {
    if (next.kind === 'offline' && prev.kind !== 'offline') {
      scheduleFromPhase(next, false);
      return;
    }
    if (next.kind === 'offline' && prev.kind === 'offline' && next.nextRetryAt !== prev.nextRetryAt) {
      // BACKOFF_HINT (or any other action that mutates nextRetryAt within
      // offline) — reschedule against the new deadline.
      scheduleFromPhase(next, true);
      return;
    }
    if (prev.kind === 'offline' && next.kind !== 'offline') {
      cancelTimer('phase-left-offline');
    }
    if (next.kind === 'online' || next.kind === 'idle') {
      attempt = 0;
    }
  });

  if (options.kernel.phase.kind === 'offline') {
    scheduleFromPhase(options.kernel.phase, false);
  }

  return () => {
    detached = true;
    cancelTimer('detach');
    unsubKernel();
  };
}
