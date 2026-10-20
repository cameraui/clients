import { DEFAULT_RACE_TIMEOUT_BY_MODE, raceFirst, RaceFirstError } from '../race.js';

import type { Kernel } from '../core/kernel.js';
import type { ConnectionTarget, Endpoint, Tokens } from '../core/types.js';
import type { RaceCandidate, TimeoutByModeFn } from '../race.js';

export type Detach = () => void;

export type ProbeFailureKind = 'transient' | 'needs-auth' | 'fatal' | 'aborted';

export interface ProbeFailure extends Error {
  readonly kind: ProbeFailureKind;
}

export function makeProbeFailure(kind: ProbeFailureKind, message: string): ProbeFailure {
  const err = new Error(message) as ProbeFailure;
  (err as { kind: ProbeFailureKind }).kind = kind;
  return err;
}

export function isProbeFailure(err: unknown): err is ProbeFailure {
  return err instanceof Error && typeof (err as { kind?: unknown }).kind === 'string';
}

export interface ProbeContext {
  readonly endpoint: Endpoint;
  readonly lastTokens?: Tokens;
  readonly signal: AbortSignal;
}

export interface ProbeLoopOptions {
  readonly kernel: Kernel;
  readonly preferGraceMs?: number;
  readonly discover: (signal: AbortSignal) => Promise<readonly Endpoint[]>;
  readonly probe: (ctx: ProbeContext) => Promise<Tokens>;
  readonly timeoutByMode?: TimeoutByModeFn;
  readonly prefer?: (endpoint: Endpoint) => boolean;
  readonly onDiscoverStart?: () => void;
  readonly onDiscoverSuccess?: (pool: readonly Endpoint[]) => void;
  readonly onDiscoverError?: (err: unknown) => void;
  readonly onProbeStart?: (endpoint: Endpoint) => void;
  readonly onProbeSuccess?: (endpoint: Endpoint, tokens: Tokens) => void;
  readonly onProbeError?: (endpoint: Endpoint, err: unknown) => void;
  readonly onAllFailed?: (reason: string) => void;
  readonly lastTarget?: () => ConnectionTarget | null;
  readonly ready?: () => Promise<unknown>;
}

const CANCELED_RERUN_MS = 200;
const MAX_CANCELED_ROUNDS = 3;

export function attachProbeLoop(options: ProbeLoopOptions): Detach {
  let masterAbort: AbortController | undefined;
  let detached = false;
  let canceledRounds = 0;
  let rerunTimer: ReturnType<typeof setTimeout> | undefined;

  function cancel(): void {
    if (rerunTimer !== undefined) {
      clearTimeout(rerunTimer);
      rerunTimer = undefined;
    }
    if (masterAbort) {
      masterAbort.abort();
      masterAbort = undefined;
    }
  }

  async function runRound(): Promise<void> {
    if (detached) return;
    cancel();
    const ctrl = new AbortController();
    masterAbort = ctrl;
    const startPhase = options.kernel.phase;
    const pendingAtStart = startPhase.kind === 'discovering' ? startPhase.pendingTokens : undefined;

    let pool: readonly Endpoint[];
    try {
      options.onDiscoverStart?.();
      pool = await options.discover(ctrl.signal);
      if (ctrl.signal.aborted) return;
      options.onDiscoverSuccess?.(pool);
    } catch (err) {
      if (ctrl.signal.aborted) return;
      options.onDiscoverError?.(err);
      const reason = err instanceof Error ? `discover: ${err.message}` : 'discover failed';
      options.onAllFailed?.(reason);
      options.kernel.dispatch({ type: 'PROBE_FAILED_ALL', error: reason });
      return;
    }

    if (pool.length === 0) {
      const reason = 'discover returned empty pool';
      options.onAllFailed?.(reason);
      options.kernel.dispatch({ type: 'PROBE_FAILED_ALL', error: reason });
      return;
    }

    if (options.ready) {
      // an async storage may still be restoring the session the probe needs
      await options.ready().catch(() => undefined);
      if (ctrl.signal.aborted) return;
    }
    const lastTokens = options.lastTarget?.()?.tokens;

    const candidates: RaceCandidate<Tokens>[] = pool.map((endpoint) => ({
      endpoint,
      run: async (signal) => {
        options.onProbeStart?.(endpoint);
        try {
          const tokens = await options.probe({ endpoint, lastTokens, signal });
          options.onProbeSuccess?.(endpoint, tokens);
          return tokens;
        } catch (err) {
          // the reason tells the own timer from cleanup after the race settled, a cancel at 80ms is no 2s timeout
          let finalErr = err;
          if (signal.aborted && !ctrl.signal.aborted && !isProbeFailure(err)) {
            if ((signal as AbortSignal & { reason?: unknown }).reason === 'race-settled') {
              finalErr = makeProbeFailure('transient', 'superseded');
            } else {
              const timeout = (options.timeoutByMode ?? ((m) => DEFAULT_RACE_TIMEOUT_BY_MODE[m] ?? 5_000))(endpoint.mode);
              finalErr = makeProbeFailure('transient', `timeout (${timeout}ms)`);
            }
          }
          options.onProbeError?.(endpoint, finalErr);
          throw finalErr;
        }
      },
    }));

    try {
      const { endpoint, value } = await raceFirst(candidates, {
        timeoutByMode: options.timeoutByMode,
        parentSignal: ctrl.signal,
        prefer: options.prefer,
        preferGraceMs: options.preferGraceMs,
        // not on aborted: Android WebViews reject cert-blocked requests as cancels, that must not kill a healthy candidate
        shortCircuit: (err) => isProbeFailure(err) && (err.kind === 'needs-auth' || err.kind === 'fatal'),
        // canceled requests lose the error pick, so the quick re-run only triggers when all were canceled
        informative: (cause) => !(isProbeFailure(cause) && cause.kind === 'aborted'),
      });
      if (ctrl.signal.aborted) return;
      // a confirming probe must not undo a refresh from this round, pending tokens from before it may predate a newer login
      const phase = options.kernel.phase;
      const refreshed = phase.kind === 'discovering' && phase.pendingTokens !== pendingAtStart ? phase.pendingTokens : undefined;
      const tokens = value === lastTokens && refreshed ? refreshed : value;
      options.kernel.dispatch({ type: 'PROBE_SUCCEEDED', endpoint, tokens });
    } catch (err) {
      if (ctrl.signal.aborted) return;

      const underlying = err instanceof RaceFirstError ? err.cause : err;

      // external cancellation (navigation, page unload) is no connection failure, re-run instead of going offline
      const allCanceled = isProbeFailure(underlying) && underlying.kind === 'aborted';
      if (allCanceled && ++canceledRounds < MAX_CANCELED_ROUNDS) {
        rerunTimer = setTimeout(() => {
          rerunTimer = undefined;
          // the kernel may have left discovering by now
          if (!detached && options.kernel.phase.kind === 'discovering') runRound();
        }, CANCELED_RERUN_MS);
        return;
      }
      // a cancel on every round is no navigation: Android WebViews cancel requests to hosts with an untrusted cert
      const reason = allCanceled
        ? `${underlying.message} (${canceledRounds} rounds, certificate blocked?)`
        : isProbeFailure(underlying) && underlying.kind === 'needs-auth'
          ? 'needs-auth'
          : underlying instanceof Error
            ? underlying.message
            : 'all endpoints failed';
      options.onAllFailed?.(reason);
      options.kernel.dispatch({ type: 'PROBE_FAILED_ALL', error: reason });
    }
  }

  const unsub = options.kernel.subscribe((next, prev) => {
    if (next.kind !== prev.kind) canceledRounds = 0;
    if (next.kind === 'discovering' && prev.kind !== 'discovering') {
      runRound();
    } else if (next.kind !== 'discovering' && prev.kind === 'discovering') {
      cancel();
    }
  });

  if (options.kernel.phase.kind === 'discovering') {
    runRound();
  }

  return () => {
    detached = true;
    cancel();
    unsub();
  };
}
