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

    // Build candidates as a wrapper around `options.probe` that also fires
    // per-attempt lifecycle callbacks (onProbeStart / onProbeSuccess /
    // onProbeError). raceFirst handles the actual abort + timeout + short-
    // circuit machinery; we only translate its outcome back into the kernel's
    // PROBE_SUCCEEDED / PROBE_FAILED_ALL contract.
    const candidates: RaceCandidate<Tokens>[] = pool.map((endpoint) => ({
      endpoint,
      run: async (signal) => {
        options.onProbeStart?.(endpoint);
        try {
          const tokens = await options.probe({ endpoint, lastTokens, signal });
          options.onProbeSuccess?.(endpoint, tokens);
          return tokens;
        } catch (err) {
          // Translate per-candidate aborts (signal aborted, no typed kind)
          // into typed `transient` failures. The signal reason separates the
          // candidate's own timer from cleanup after the race settled — a
          // candidate canceled at 80ms must not be logged as a 2s timeout.
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
        // needs-auth/fatal short-circuit because the same tokens (or lack
        // thereof) reject every endpoint in this pool. `aborted` deliberately
        // does NOT: Android's WebView rejects cert-blocked requests with
        // cancellation-shaped errors, and one poisoned endpoint must not kill
        // a healthy candidate mid-flight.
        shortCircuit: (err) => isProbeFailure(err) && (err.kind === 'needs-auth' || err.kind === 'fatal'),
        // canceled-request noise loses the representative-error pick, so the
        // quick re-run below only triggers when ALL candidates were canceled
        informative: (cause) => !(isProbeFailure(cause) && cause.kind === 'aborted'),
      });
      if (ctrl.signal.aborted) return;
      // a probe that only confirmed the round's tokens must not undo a refresh that landed during the round,
      // one carried over from offline may predate a login seeded since
      const phase = options.kernel.phase;
      const refreshed = phase.kind === 'discovering' && phase.pendingTokens !== pendingAtStart ? phase.pendingTokens : undefined;
      const tokens = value === lastTokens && refreshed ? refreshed : value;
      options.kernel.dispatch({ type: 'PROBE_SUCCEEDED', endpoint, tokens });
    } catch (err) {
      if (ctrl.signal.aborted) return;

      // Unwrap raceFirst's envelope: the `cause` carries the original probe
      // error (timeout, needs-auth, etc.) — that's what downstream consumers
      // (reducer, UI logger) reason about.
      const underlying = err instanceof RaceFirstError ? err.cause : err;

      // External cancellation (browser navigation, service worker, page
      // unload) is NOT a real connection failure — re-run the round shortly
      // instead of flapping through `offline` and showing a disconnect banner
      // for a non-issue.
      const allCanceled = isProbeFailure(underlying) && underlying.kind === 'aborted';
      if (allCanceled && ++canceledRounds < MAX_CANCELED_ROUNDS) {
        rerunTimer = setTimeout(() => {
          rerunTimer = undefined;
          // Phase re-check: by the time this fires the kernel may have left
          // discovering (RESET) or a NEW round may already be running —
          // runRound() would cancel and restart that legitimate round.
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

  // Catch up if the kernel is already discovering when the effect is attached.
  if (options.kernel.phase.kind === 'discovering') {
    runRound();
  }

  return () => {
    detached = true;
    cancel();
    unsub();
  };
}
