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
}

export function attachProbeLoop(options: ProbeLoopOptions): Detach {
  let masterAbort: AbortController | undefined;
  let detached = false;

  function cancel(): void {
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
          // Translate per-candidate timeout (signal aborted, no typed kind)
          // into a typed `transient` so downstream logging + the
          // `shortCircuit` predicate below agree.
          const isLocalTimeout = signal.aborted && !ctrl.signal.aborted && !isProbeFailure(err);
          const timeout = (options.timeoutByMode ?? ((m) => DEFAULT_RACE_TIMEOUT_BY_MODE[m] ?? 5_000))(endpoint.mode);
          const finalErr = isLocalTimeout ? makeProbeFailure('transient', `timeout (${timeout}ms)`) : err;
          options.onProbeError?.(endpoint, finalErr);
          throw finalErr;
        }
      },
    }));

    try {
      const { endpoint, value: tokens } = await raceFirst(candidates, {
        timeoutByMode: options.timeoutByMode,
        parentSignal: ctrl.signal,
        prefer: options.prefer,
        preferGraceMs: options.preferGraceMs,
        // needs-auth/fatal short-circuit because the same tokens (or lack
        // thereof) reject every endpoint in this pool. `aborted` short-
        // circuits because external cancellation (browser navigation, SW)
        // affects all in-flight requests synchronously.
        shortCircuit: (err) => isProbeFailure(err) && (err.kind === 'needs-auth' || err.kind === 'fatal' || err.kind === 'aborted'),
      });
      if (ctrl.signal.aborted) return;
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
      if (isProbeFailure(underlying) && underlying.kind === 'aborted') {
        setTimeout(() => {
          // Phase re-check: by the time this fires the kernel may have left
          // discovering (RESET) or a NEW round may already be running —
          // runRound() would cancel and restart that legitimate round.
          if (!detached && options.kernel.phase.kind === 'discovering') runRound();
        }, 200);
        return;
      }
      const reason =
        isProbeFailure(underlying) && underlying.kind === 'needs-auth' ? 'needs-auth' : underlying instanceof Error ? underlying.message : 'all endpoints failed';
      options.onAllFailed?.(reason);
      options.kernel.dispatch({ type: 'PROBE_FAILED_ALL', error: reason });
    }
  }

  const unsub = options.kernel.subscribe((next, prev) => {
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
