import type { Endpoint, EndpointMode } from './core/types.js';

export type TimeoutByModeFn = (mode: EndpointMode) => number;

export const DEFAULT_RACE_TIMEOUT_BY_MODE: Readonly<Record<EndpointMode, number>> = {
  'direct-lan': 2_000,
  'direct-wan': 5_000,
};

export interface RaceCandidate<T> {
  readonly endpoint: Endpoint;
  readonly run: (signal: AbortSignal) => Promise<T>;
}

export interface RaceFirstOptions {
  readonly timeoutByMode?: TimeoutByModeFn;
  readonly shortCircuit?: (err: unknown) => boolean;
  readonly parentSignal?: AbortSignal;
  readonly prefer?: (endpoint: Endpoint) => boolean;
  readonly preferGraceMs?: number;
}

const DEFAULT_PREFER_GRACE_MS = 400;

export interface RaceFirstResult<T> {
  readonly endpoint: Endpoint;
  readonly value: T;
}

export class RaceFirstError extends Error {
  public readonly endpoint: Endpoint;
  public readonly cause: unknown;
  public readonly kind: 'short-circuit' | 'all-failed' | 'aborted';

  constructor(message: string, endpoint: Endpoint, cause: unknown, kind: RaceFirstError['kind']) {
    super(message);
    this.name = 'RaceFirstError';
    this.endpoint = endpoint;
    this.cause = cause;
    this.kind = kind;
  }
}

export function raceFirst<T>(candidates: readonly RaceCandidate<T>[], options: RaceFirstOptions = {}): Promise<RaceFirstResult<T>> {
  const { timeoutByMode = (mode) => DEFAULT_RACE_TIMEOUT_BY_MODE[mode] ?? 5_000, shortCircuit, parentSignal, prefer } = options;
  const preferGraceMs = options.preferGraceMs ?? DEFAULT_PREFER_GRACE_MS;

  return new Promise<RaceFirstResult<T>>((resolve, reject) => {
    if (candidates.length === 0) {
      reject(new RaceFirstError('raceFirst: no candidates', { url: '', mode: 'direct-lan' }, undefined, 'all-failed'));
      return;
    }

    if (parentSignal?.aborted) {
      reject(new RaceFirstError('raceFirst: parent aborted', candidates[0]!.endpoint, undefined, 'aborted'));
      return;
    }

    let settled = false;
    let remaining = candidates.length;
    let pendingPreferred = prefer ? candidates.filter((c) => prefer(c.endpoint)).length : 0;
    let held: { endpoint: Endpoint; value: T; ctrl: AbortController } | null = null;
    const lastErrors = new Map<Endpoint, unknown>();
    const abortControllers: AbortController[] = [];
    const timers: ReturnType<typeof setTimeout>[] = [];

    function cleanupAllExcept(except: AbortController | null): void {
      for (const t of timers) clearTimeout(t);
      for (const a of abortControllers) {
        if (a !== except) a.abort();
      }
    }

    function finishSuccess(endpoint: Endpoint, value: T, except: AbortController): void {
      if (settled) return;
      settled = true;
      cleanupAllExcept(except);
      if (onParentAbort) parentSignal?.removeEventListener('abort', onParentAbort);
      resolve({ endpoint, value });
    }

    function settleHeld(): void {
      if (!held) return;
      finishSuccess(held.endpoint, held.value, held.ctrl);
    }

    function handleSuccess(endpoint: Endpoint, value: T, ctrl: AbortController): void {
      if (settled) return;
      if (!prefer || prefer(endpoint) || pendingPreferred <= 0) {
        finishSuccess(endpoint, value, ctrl);
        return;
      }
      if (held) return; // first held result wins if no preferred shows up
      held = { endpoint, value, ctrl };
      const holdTimer = setTimeout(settleHeld, preferGraceMs);
      timers.push(holdTimer);
    }

    function finishFail(error: RaceFirstError): void {
      if (settled) return;
      settled = true;
      cleanupAllExcept(null);
      if (onParentAbort) parentSignal?.removeEventListener('abort', onParentAbort);
      reject(error);
    }

    const onParentAbort = parentSignal ? (): void => finishFail(new RaceFirstError('raceFirst: parent aborted', candidates[0]!.endpoint, undefined, 'aborted')) : null;
    if (onParentAbort) parentSignal!.addEventListener('abort', onParentAbort);

    candidates.forEach((cand) => {
      const ctrl = new AbortController();
      abortControllers.push(ctrl);
      const delay = timeoutByMode(cand.endpoint.mode);
      const timer = setTimeout(() => ctrl.abort(), delay);
      timers.push(timer);

      cand.run(ctrl.signal).then(
        (value) => handleSuccess(cand.endpoint, value, ctrl),
        (err) => {
          if (settled) {
            lastErrors.set(cand.endpoint, err);
            return;
          }
          if (prefer?.(cand.endpoint)) {
            pendingPreferred--;
            if (held && pendingPreferred <= 0) {
              lastErrors.set(cand.endpoint, err);
              settleHeld();
              return;
            }
          }
          // Distinguish self-timeout (per-candidate signal) from parent-abort
          // and from genuine errors — the consumer of `RaceFirstError.cause`
          // can introspect more, but at this layer a timeout is just another
          // failure that disqualifies the candidate.
          const isTimeout = ctrl.signal.aborted && !parentSignal?.aborted;
          const finalErr = isTimeout ? new RaceFirstError(`timeout (${delay}ms)`, cand.endpoint, err, 'all-failed') : err;
          lastErrors.set(cand.endpoint, finalErr);

          if (shortCircuit?.(finalErr)) {
            finishFail(new RaceFirstError('raceFirst: short-circuit', cand.endpoint, finalErr, 'short-circuit'));
            return;
          }

          remaining--;
          if (remaining <= 0) {
            // Prefer the most informative recent error — first one in iteration
            // order whose cause is not a vanilla timeout, otherwise just the
            // last one seen.
            const informative = [...lastErrors.entries()].find(([, e]) => {
              if (e instanceof RaceFirstError) return e.kind !== 'all-failed' || !(e.cause instanceof Error && e.cause.message === 'aborted');
              return true;
            });
            const [endpoint, cause] = informative ?? [cand.endpoint, finalErr];
            finishFail(new RaceFirstError('raceFirst: all candidates failed', endpoint, cause, 'all-failed'));
          }
        },
      );
    });
  });
}
