import type { Kernel } from '../core/kernel.js';
import type { ConnectionTarget, Tokens } from '../core/types.js';
import type { Transport } from '../transports/contract.js';

export type RefreshReason = 'proactive' | 'auth-error';

export interface TokenLifecycleOptions {
  readonly kernel: Kernel;
  readonly transports: readonly Transport[];
  readonly refresh: (target: ConnectionTarget, reason: RefreshReason) => Promise<Tokens>;
  readonly graceMs?: number;
  readonly isTransientError?: (err: unknown) => boolean;
  readonly maxTransientRetries?: number;
  readonly transientRetryDelayMs?: number;
  readonly now?: () => number;
  readonly setTimer?: (cb: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly acquireRefreshLock?: <T>(fn: () => Promise<T>) => Promise<T>;
  readonly getLatestTokens?: () => Tokens | null;
  readonly onRefreshStart?: (reason: RefreshReason) => void;
  readonly onRefreshSuccess?: (reason: RefreshReason, tokens: Tokens) => void;
  readonly onRefreshSkipped?: (reason: RefreshReason, tokens: Tokens) => void;
  readonly onRefreshError?: (reason: RefreshReason, error: unknown, info: { transient: boolean; retriesLeft: number; willRetry: boolean }) => void;
  readonly onScheduled?: (delayMs: number, expiresAt: number) => void;
  readonly onWakeChecked?: (info: { decision: 'refresh-now' | 'still-fresh' | 'no-target' | 'no-expiry'; remainingMs?: number; phase: string }) => void;
  readonly onTriggerSkipped?: (reason: RefreshReason, why: 'detached' | 'already-inflight' | 'no-target', phase: string) => void;
}

export type Detach = () => void;

export interface TokenLifecycle {
  readonly detach: () => void;
  readonly wake: () => void;
}

const DEFAULT_GRACE_MS = 5_000;
const DEFAULT_MAX_TRANSIENT_RETRIES = 3;
const DEFAULT_TRANSIENT_RETRY_DELAY_MS = 2_000;

export function attachTokenLifecycle(options: TokenLifecycleOptions): TokenLifecycle {
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const isTransient = options.isTransientError ?? (() => false);
  const maxTransientRetries = options.maxTransientRetries ?? DEFAULT_MAX_TRANSIENT_RETRIES;
  const transientRetryDelayMs = options.transientRetryDelayMs ?? DEFAULT_TRANSIENT_RETRY_DELAY_MS;
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let timer: unknown;
  let inflight = false;
  let detached = false;
  let transientRetries = 0;
  let pendingAuthError = false;

  const cleanups: Array<() => void> = [];

  function cancelTimer(): void {
    if (timer !== undefined) {
      clearTimer(timer);
      timer = undefined;
    }
  }

  function schedule(target: ConnectionTarget): void {
    cancelTimer();
    const exp = target.tokens.accessExpiresAt;
    if (!exp) return;
    const delayMs = Math.max(0, exp - now() - graceMs);
    options.onScheduled?.(delayMs, exp);
    timer = setTimer(() => {
      timer = undefined;
      triggerRefresh('proactive');
    }, delayMs);
  }

  async function triggerRefresh(reason: RefreshReason): Promise<void> {
    if (detached) {
      options.onTriggerSkipped?.(reason, 'detached', options.kernel.phase.kind);
      return;
    }
    if (inflight) {
      // Don't drop auth-error triggers — queue at most one and re-fire after
      // the current refresh settles. Proactive triggers can drop safely (the
      // scheduler will requeue them on the next success/expiry cycle).
      if (reason === 'auth-error') pendingAuthError = true;
      options.onTriggerSkipped?.(reason, 'already-inflight', options.kernel.phase.kind);
      return;
    }

    const phase = options.kernel.phase;
    // Allow refresh both in 'online' (proactive / auth-error from a still-up
    // transport) and 'reconnecting' (transports retrying with stale tokens —
    // refreshing here lets the next natural reconnect use fresh tokens).
    const target = phase.kind === 'online' ? phase.target : phase.kind === 'reconnecting' ? phase.lastTarget : null;
    if (!target) {
      options.onTriggerSkipped?.(reason, 'no-target', phase.kind);
      return;
    }

    inflight = true;
    options.onRefreshStart?.(reason);

    try {
      const acquireLock = options.acquireRefreshLock ?? (<T>(fn: () => Promise<T>) => fn());
      const result = await acquireLock(async (): Promise<{ tokens: Tokens; skipped: boolean }> => {
        // Inside the lock: another tab may have refreshed while we were
        // waiting for it. Re-read the freshest known tokens (typically from
        // localStorage via attachPersistence) and skip the HTTP call if
        // they're still inside the proactive grace window.
        const fresh = options.getLatestTokens?.();
        if (fresh?.accessExpiresAt && fresh.accessExpiresAt > now() + graceMs) {
          // Dispatch INSIDE the lock so attachPersistence's storage write
          // completes before we release. Otherwise the next tab acquires the
          // lock before our localStorage entry is visible cross-tab → its
          // getLatestTokens reads stale tokens → it sends a redundant (and
          // potentially failing) refresh.
          options.kernel.dispatch({ type: 'TOKENS_REFRESHED', tokens: fresh });
          return { tokens: fresh, skipped: true };
        }
        const tokens = await options.refresh(target, reason);
        if (detached) return { tokens, skipped: false };
        options.kernel.dispatch({ type: 'TOKENS_REFRESHED', tokens });
        return { tokens, skipped: false };
      });
      if (detached) return;
      transientRetries = 0;
      if (result.skipped) {
        options.onRefreshSkipped?.(reason, result.tokens);
      } else {
        options.onRefreshSuccess?.(reason, result.tokens);
      }
    } catch (err) {
      if (detached) return;
      const transient = isTransient(err);
      if (transient && transientRetries < maxTransientRetries) {
        transientRetries++;
        const retriesLeft = maxTransientRetries - transientRetries;
        options.onRefreshError?.(reason, err, { transient: true, retriesLeft, willRetry: true });
        cancelTimer();
        timer = setTimer(() => {
          timer = undefined;
          triggerRefresh(reason);
        }, transientRetryDelayMs);
      } else {
        transientRetries = 0;
        options.onRefreshError?.(reason, err, { transient, retriesLeft: 0, willRetry: false });
        // Tag with the original transience: server-side rejection (401 etc)
        // → needs-auth; transient retries exhausted (network) → offline.
        options.kernel.dispatch({ type: 'TOKENS_INVALID', reason: stringifyError(err), transient });
      }
    } finally {
      inflight = false;
      // Drain a queued auth-error trigger if one arrived during this attempt.
      // We do this *outside* the inflight guard so the follow-up runs normally;
      // it'll early-return again if a transient retry has set inflight back.
      if (!detached && pendingAuthError) {
        pendingAuthError = false;
        triggerRefresh('auth-error');
      }
    }
  }

  const unsubKernel = options.kernel.subscribe((next, prev) => {
    if (next.kind === 'online') {
      const targetChanged = prev.kind !== 'online' || prev.target.tokens.access !== next.target.tokens.access;
      if (targetChanged) {
        transientRetries = 0;
        schedule(next.target);
      }
    } else if (next.kind === 'reconnecting') {
      // Keep any in-flight refresh / retry timer running — phase-flip alone is
      // not a reason to drop the refresh effort. The next retry will pick up
      // phase.lastTarget instead of phase.target.
    } else {
      cancelTimer();
      transientRetries = 0;
    }
  });
  cleanups.push(unsubKernel);

  for (const transport of options.transports) {
    const off = transport.on('auth-error', () => {
      triggerRefresh('auth-error');
    });
    cleanups.push(off);
  }

  if (options.kernel.phase.kind === 'online') {
    schedule(options.kernel.phase.target);
  }

  function detach(): void {
    detached = true;
    cancelTimer();
    for (const fn of cleanups) fn();
  }

  function wake(): void {
    if (detached) return;
    const phase = options.kernel.phase;
    const target = phase.kind === 'online' ? phase.target : phase.kind === 'reconnecting' ? phase.lastTarget : null;
    if (!target) {
      options.onWakeChecked?.({ decision: 'no-target', phase: phase.kind });
      return;
    }
    const exp = target.tokens.accessExpiresAt;
    if (!exp) {
      options.onWakeChecked?.({ decision: 'no-expiry', phase: phase.kind });
      return;
    }
    // Identical predicate to schedule(): if there's less than graceMs left
    // (or we're past expiry), kick off a refresh now. Otherwise the existing
    // scheduled timer (or a freshly rescheduled one) handles it — wake() is
    // a no-op.
    const remaining = exp - now();
    if (remaining < graceMs) {
      options.onWakeChecked?.({ decision: 'refresh-now', remainingMs: remaining, phase: phase.kind });
      triggerRefresh('proactive');
    } else {
      options.onWakeChecked?.({ decision: 'still-fresh', remainingMs: remaining, phase: phase.kind });
    }
  }

  return { detach, wake };
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'refresh-failed';
}
