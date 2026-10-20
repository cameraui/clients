import type { Kernel } from '../core/kernel.js';
import type { ConnectionTarget, Tokens } from '../core/types.js';
import type { Transport } from '../transports/contract.js';

export type RefreshReason = 'proactive' | 'auth-error';

export interface TokenLifecycleOptions {
  readonly kernel: Kernel;
  readonly transports: readonly Transport[];
  readonly graceMs?: number;
  readonly maxTransientRetries?: number;
  readonly transientRetryDelayMs?: number;
  readonly maxServerErrorRetries?: number;
  readonly minRefreshIntervalMs?: number;
  readonly reachableRetryDelaysMs?: readonly number[];
  readonly lockTimeoutMs?: number;
  readonly refresh: (target: ConnectionTarget, reason: RefreshReason) => Promise<Tokens>;
  readonly isTransientError?: (err: unknown) => boolean;
  readonly isServerError?: (err: unknown) => boolean;
  readonly now?: () => number;
  readonly setTimer?: (cb: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly isReachable?: () => boolean;
  readonly acquireRefreshLock?: <T>(fn: () => Promise<T>, signal?: AbortSignal) => Promise<T>;
  readonly getLatestTokens?: () => Tokens | null;
  readonly onRefreshStart?: (reason: RefreshReason) => void;
  readonly onRefreshSuccess?: (reason: RefreshReason, tokens: Tokens) => void;
  readonly onRefreshSkipped?: (reason: RefreshReason, tokens: Tokens) => void;
  readonly onRefreshError?: (reason: RefreshReason, error: unknown, info: { transient: boolean; serverError: boolean; retriesLeft: number; willRetry: boolean }) => void;
  readonly onScheduled?: (delayMs: number, expiresAt: number) => void;
  readonly onWakeChecked?: (info: { decision: 'refresh-now' | 'still-fresh' | 'throttled' | 'no-target' | 'no-expiry'; remainingMs?: number; phase: string }) => void;
  readonly onTriggerSkipped?: (reason: RefreshReason, why: 'detached' | 'already-inflight' | 'no-target' | 'throttled', phase: string) => void;
}

export type Detach = () => void;

export interface TokenLifecycle {
  readonly detach: () => void;
  readonly wake: () => void;
}

const DEFAULT_GRACE_MS = 5_000;
const DEFAULT_MAX_TRANSIENT_RETRIES = 3;
const DEFAULT_TRANSIENT_RETRY_DELAY_MS = 2_000;
const DEFAULT_MIN_REFRESH_INTERVAL_MS = 30_000;
const DEFAULT_REACHABLE_RETRY_DELAYS_MS = [10_000, 30_000] as const;
const DEFAULT_LOCK_TIMEOUT_MS = 15_000;
const AUTH_ERROR_RETRY_GAP_MS = 5_000;
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

interface RefreshOutcome {
  readonly tokens: Tokens;
  readonly skipped: boolean;
}

export function attachTokenLifecycle(options: TokenLifecycleOptions): TokenLifecycle {
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const maxTransientRetries = options.maxTransientRetries ?? DEFAULT_MAX_TRANSIENT_RETRIES;
  const maxServerErrorRetries = options.maxServerErrorRetries ?? maxTransientRetries;
  const transientRetryDelayMs = options.transientRetryDelayMs ?? DEFAULT_TRANSIENT_RETRY_DELAY_MS;
  const minRefreshIntervalMs = options.minRefreshIntervalMs ?? DEFAULT_MIN_REFRESH_INTERVAL_MS;
  const reachableRetryDelaysMs = options.reachableRetryDelaysMs?.length ? options.reachableRetryDelaysMs : DEFAULT_REACHABLE_RETRY_DELAYS_MS;
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const lockWaitBounded = Number.isFinite(lockTimeoutMs) && lockTimeoutMs > 0;
  const isTransient = options.isTransientError ?? (() => false);
  const isServerError = options.isServerError ?? (() => false);
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let timer: unknown;
  let inflight: Promise<boolean> | null = null;
  let detached = false;
  let transientRetries = 0;
  let slowRetries = 0;
  let lastSlowFailureAt = 0;
  let pendingAuthError = false;
  let refreshFloorUntil: number | undefined;
  let rotatedAccess: string | undefined;
  let rejectedAccess: string | undefined;
  let stopLockWait: (() => void) | undefined;

  const cleanups: Array<() => void> = [];

  function cancelTimer(): void {
    if (timer !== undefined) {
      clearTimer(timer);
      timer = undefined;
    }
  }

  function retryLater(reason: RefreshReason, delayMs: number): void {
    cancelTimer();
    timer = setTimer(() => {
      timer = undefined;
      triggerRefresh(reason);
    }, delayMs);
  }

  function insideRefreshFloor(): boolean {
    return refreshFloorUntil !== undefined && now() < refreshFloorUntil;
  }

  function refreshFloorFor(tokens: Tokens): number {
    const lifetimeMs = tokens.accessExpiresAt ? tokens.accessExpiresAt - now() : undefined;
    if (lifetimeMs === undefined || lifetimeMs <= graceMs) return minRefreshIntervalMs;
    return Math.min(minRefreshIntervalMs, Math.max(graceMs, lifetimeMs - graceMs));
  }

  function needsNoRefresh(tokens: Tokens): boolean {
    // also caps forced refreshes: a CONNECT still in flight on the old token reports the new one
    if (tokens.access === rotatedAccess && insideRefreshFloor()) return true;
    // without a refresh token (embed, API tokens) a forced refresh could only end the session
    if (tokens.access === rejectedAccess && tokens.refresh) return false;
    return !!tokens.accessExpiresAt && tokens.accessExpiresAt > now() + graceMs;
  }

  function isCurrentAccess(access: string): boolean {
    const phase = options.kernel.phase;
    return (phase.kind === 'online' && phase.target.tokens.access === access) || options.getLatestTokens?.()?.access === access;
  }

  function underRefreshLock(fn: () => Promise<RefreshOutcome>): Promise<RefreshOutcome | null> {
    const acquire = options.acquireRefreshLock;
    if (!acquire) return fn();
    if (!lockWaitBounded) return acquire(fn);
    return new Promise<RefreshOutcome | null>((resolve, reject) => {
      const abort = new AbortController();
      let waiting = true;
      function stopWaiting(): void {
        waiting = false;
        clearTimer(handle);
        if (stopLockWait === giveUp) stopLockWait = undefined;
      }
      function giveUp(): void {
        if (!waiting) return;
        stopWaiting();
        abort.abort();
        resolve(null);
      }
      const handle = setTimer(giveUp, Math.min(lockTimeoutMs, MAX_TIMER_DELAY_MS));
      stopLockWait = giveUp;
      acquire<RefreshOutcome | null>(() => {
        if (!waiting) return Promise.resolve(null);
        stopWaiting();
        return fn();
      }, abort.signal).then(resolve, (err: unknown) => {
        stopWaiting();
        reject(err);
      });
    });
  }

  function schedule(target: ConnectionTarget): void {
    cancelTimer();
    const exp = target.tokens.accessExpiresAt;
    if (!exp) return;
    const floorAt = refreshFloorUntil ?? 0;
    const delayMs = Math.min(Math.max(0, exp - now() - graceMs, floorAt - now()), MAX_TIMER_DELAY_MS);
    options.onScheduled?.(delayMs, exp);
    timer = setTimer(() => {
      timer = undefined;
      triggerRefresh('proactive');
    }, delayMs);
  }

  async function triggerRefresh(reason: RefreshReason): Promise<boolean> {
    if (detached) {
      options.onTriggerSkipped?.(reason, 'detached', options.kernel.phase.kind);
      return false;
    }
    if (inflight) {
      // queue one auth-error trigger, proactive ones can drop since the scheduler requeues them
      if (reason === 'auth-error') pendingAuthError = true;
      options.onTriggerSkipped?.(reason, 'already-inflight', options.kernel.phase.kind);
      return inflight;
    }

    const phase = options.kernel.phase;
    const target = phase.kind === 'online' ? phase.target : null;
    if (!target) {
      options.onTriggerSkipped?.(reason, 'no-target', phase.kind);
      return false;
    }

    let settle!: (tokenComing: boolean) => void;
    let tokenComing = false;
    let lockTimedOut = false;
    inflight = new Promise<boolean>((resolve) => (settle = resolve));
    options.onRefreshStart?.(reason);

    try {
      let result = await underRefreshLock(async (): Promise<RefreshOutcome> => {
        // another tab may have refreshed while we waited for the lock
        const fresh = options.getLatestTokens?.();
        if (fresh && needsNoRefresh(fresh)) {
          // inside the lock, so the next tab sees the stored tokens before it gets the lock
          options.kernel.dispatch({ type: 'TOKENS_REFRESHED', tokens: fresh });
          return { tokens: fresh, skipped: true };
        }
        // another tab may have rotated the refresh token while we waited, refreshing with the old one forces a logout
        const livePhase = options.kernel.phase;
        const liveTarget = livePhase.kind === 'online' ? livePhase.target : null;
        const base = liveTarget ?? target;
        const refreshTarget: ConnectionTarget = fresh ? { ...base, tokens: fresh } : base;
        const tokens = await options.refresh(refreshTarget, reason);
        if (detached) return { tokens, skipped: false };
        options.kernel.dispatch({ type: 'TOKENS_REFRESHED', tokens });
        return { tokens, skipped: false };
      });
      if (detached) return false;
      if (!result) {
        // refreshing without the lock races other tabs, take what they stored or retry
        const fresh = options.getLatestTokens?.();
        if (!fresh || !needsNoRefresh(fresh)) {
          lockTimedOut = true;
          throw new Error(`refresh lock not granted within ${lockTimeoutMs} ms`);
        }
        options.kernel.dispatch({ type: 'TOKENS_REFRESHED', tokens: fresh });
        result = { tokens: fresh, skipped: true };
      }
      transientRetries = 0;
      slowRetries = 0;
      const live = options.kernel.phase;
      tokenComing = live.kind === 'online' && live.target.tokens.access !== target.tokens.access;
      if (result.skipped) {
        options.onRefreshSkipped?.(reason, result.tokens);
        // identical tokens are a reducer no-op, nothing else re-arms the proactive timer
        const p = options.kernel.phase;
        if (p.kind === 'online' && timer === undefined) {
          schedule(p.target);
        }
      } else {
        options.onRefreshSuccess?.(reason, result.tokens);
      }
    } catch (err) {
      if (detached) return false;
      const transient = lockTimedOut || isTransient(err);
      // a 5xx stays transient but gets the smaller budget, retrying can't fix a down server
      const serverError = transient && isServerError(err);
      const budget = serverError ? maxServerErrorRetries : maxTransientRetries;
      if (transient && transientRetries < budget) {
        transientRetries++;
        const retriesLeft = budget - transientRetries;
        options.onRefreshError?.(reason, err, { transient: true, serverError, retriesLeft, willRetry: true });
        tokenComing = true;
        retryLater(reason, transientRetryDelayMs);
      } else if (transient && options.isReachable?.() === true) {
        // the channels still work on the current token, a 401 meanwhile retries at once
        const delayMs = reachableRetryDelaysMs[Math.min(slowRetries, reachableRetryDelaysMs.length - 1)]!;
        slowRetries++;
        lastSlowFailureAt = now();
        options.onRefreshError?.(reason, err, { transient: true, serverError, retriesLeft: 0, willRetry: true });
        retryLater(reason, delayMs);
      } else {
        transientRetries = 0;
        slowRetries = 0;
        options.onRefreshError?.(reason, err, { transient, serverError, retriesLeft: 0, willRetry: false });
        options.kernel.dispatch({ type: 'TOKENS_INVALID', reason: stringifyError(err), transient });
      }
    } finally {
      inflight = null;
      settle(tokenComing);
      // outside the inflight guard so the queued auth-error runs normally
      if (!detached && pendingAuthError) {
        pendingAuthError = false;
        triggerOnAuthError();
      }
    }
    return tokenComing;
  }

  function triggerOnAuthError(): Promise<boolean> {
    // the refresh failed moments ago and its retry timer is armed, another attempt would fail the same way
    if (slowRetries > 0 && now() - lastSlowFailureAt < AUTH_ERROR_RETRY_GAP_MS) {
      options.onTriggerSkipped?.('auth-error', 'throttled', options.kernel.phase.kind);
      return Promise.resolve(false);
    }
    return triggerRefresh('auth-error');
  }

  const unsubKernel = options.kernel.subscribe((next, prev) => {
    if (next.kind === 'online') {
      const targetChanged = prev.kind !== 'online' || prev.target.tokens.access !== next.target.tokens.access;
      if (targetChanged) {
        if (prev.kind === 'online') {
          refreshFloorUntil = now() + refreshFloorFor(next.target.tokens);
          rotatedAccess = next.target.tokens.access;
        }
        transientRetries = 0;
        slowRetries = 0;
        schedule(next.target);
      }
    } else {
      cancelTimer();
      transientRetries = 0;
      slowRetries = 0;
    }
  });
  cleanups.push(unsubKernel);

  for (const transport of options.transports) {
    const off = transport.on('auth-error', (event) => {
      if (event.access && isCurrentAccess(event.access)) rejectedAccess = event.access;
      const refresh = triggerOnAuthError();
      event.holdFor?.(refresh);
    });
    cleanups.push(off);
  }

  if (options.kernel.phase.kind === 'online') {
    schedule(options.kernel.phase.target);
  }

  function detach(): void {
    detached = true;
    cancelTimer();
    stopLockWait?.();
    for (const fn of cleanups) fn();
  }

  function wake(): void {
    if (detached) return;
    const phase = options.kernel.phase;
    const target = phase.kind === 'online' ? phase.target : null;
    if (!target) {
      options.onWakeChecked?.({ decision: 'no-target', phase: phase.kind });
      return;
    }
    const exp = target.tokens.accessExpiresAt;
    if (!exp) {
      options.onWakeChecked?.({ decision: 'no-expiry', phase: phase.kind });
      return;
    }
    const remaining = exp - now();
    if (remaining < graceMs && insideRefreshFloor()) {
      options.onWakeChecked?.({ decision: 'throttled', remainingMs: remaining, phase: phase.kind });
    } else if (remaining < graceMs) {
      options.onWakeChecked?.({ decision: 'refresh-now', remainingMs: remaining, phase: phase.kind });
      triggerRefresh('proactive');
    } else {
      options.onWakeChecked?.({ decision: 'still-fresh', remainingMs: remaining, phase: phase.kind });
    }
  }

  return { detach, wake };
}

export function localAccessExpiry(access: string, serverExpiresAt?: number, receivedAt = Date.now()): number | undefined {
  const claims = decodeJwtClaims(access);
  const iat = claims?.iat;
  const exp = claims?.exp;
  if (typeof iat === 'number' && typeof exp === 'number' && exp > iat) return receivedAt + (exp - iat) * 1000;
  return serverExpiresAt;
}

function decodeJwtClaims(token: string): { readonly iat?: unknown; readonly exp?: unknown } | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const claims: unknown = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')));
    return typeof claims === 'object' && claims !== null ? claims : null;
  } catch {
    return null;
  }
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'refresh-failed';
}
