import type { Kernel } from '../core/kernel.js';

export type Detach = () => void;

export interface ReconnectWatchdogOptions {
  readonly kernel: Kernel;
  readonly escalateAfterMs?: number;
  readonly setTimer?: (cb: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly onEscalate?: (attempt: number) => void;
}

const DEFAULT_ESCALATE_AFTER_MS = 12_000;

export function attachReconnectWatchdog(options: ReconnectWatchdogOptions): Detach {
  const escalateAfterMs = options.escalateAfterMs ?? DEFAULT_ESCALATE_AFTER_MS;
  const setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let timer: unknown;
  let attempt = 0;
  let detached = false;

  function cancelTimer(): void {
    if (timer !== undefined) {
      clearTimer(timer);
      timer = undefined;
    }
  }

  function arm(): void {
    cancelTimer();
    timer = setTimer(() => {
      timer = undefined;
      if (detached) return;
      // Re-check: a transport may have recovered between the timer firing and
      // this callback running. Only escalate if we're genuinely still stuck.
      if (options.kernel.phase.kind !== 'reconnecting') return;
      attempt += 1;
      options.onEscalate?.(attempt);
      options.kernel.dispatch({ type: 'USER_RETRY' });
    }, escalateAfterMs);
  }

  const unsubKernel = options.kernel.subscribe((next, prev) => {
    if (next.kind === 'reconnecting' && prev.kind !== 'reconnecting') {
      arm();
    } else if (next.kind !== 'reconnecting' && prev.kind === 'reconnecting') {
      cancelTimer();
    }
    if (next.kind === 'online' || next.kind === 'idle') {
      attempt = 0;
    }
  });

  if (options.kernel.phase.kind === 'reconnecting') {
    arm();
  }

  return () => {
    detached = true;
    cancelTimer();
    unsubKernel();
  };
}
