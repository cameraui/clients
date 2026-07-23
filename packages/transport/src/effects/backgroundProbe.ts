import { raceFirst } from '../race.js';

import type { Kernel } from '../core/kernel.js';
import type { ConnectionTarget, Endpoint, Tokens } from '../core/types.js';
import type { RaceCandidate, TimeoutByModeFn } from '../race.js';
import type { ProbeContext } from './probeLoop.js';

export type BackgroundProbeOutcome = 'swap' | 'same' | 'failed' | 'skipped';

export interface BackgroundProbeOptions {
  readonly kernel: Kernel;
  readonly discover: (signal: AbortSignal) => Promise<readonly Endpoint[]>;
  readonly probe: (ctx: ProbeContext) => Promise<Tokens>;
  readonly lastTarget?: () => ConnectionTarget | null;
  readonly timeoutByMode?: TimeoutByModeFn;
  readonly prefer?: (endpoint: Endpoint) => boolean;
  readonly preferGraceMs?: number;
  readonly onResult?: (outcome: BackgroundProbeOutcome, detail?: string) => void;
}

export interface BackgroundProbe {
  run(): Promise<BackgroundProbeOutcome>;
  dispose(): void;
}

export function createBackgroundProbe(options: BackgroundProbeOptions): BackgroundProbe {
  let inflight: Promise<BackgroundProbeOutcome> | null = null;
  let disposed = false;

  async function round(): Promise<BackgroundProbeOutcome> {
    if (options.kernel.phase.kind !== 'online') {
      options.onResult?.('skipped', `phase=${options.kernel.phase.kind}`);
      return 'skipped';
    }
    const ctrl = new AbortController();
    try {
      const pool = await options.discover(ctrl.signal);
      if (disposed || options.kernel.phase.kind !== 'online') return 'skipped';
      if (pool.length === 0) {
        options.onResult?.('failed', 'empty pool');
        return 'failed';
      }
      const lastTokens = options.lastTarget?.()?.tokens;
      const candidates: RaceCandidate<Tokens>[] = pool.map((endpoint) => ({
        endpoint,
        run: (signal) => options.probe({ endpoint, lastTokens, signal }),
      }));
      const { endpoint, value: tokens } = await raceFirst(candidates, {
        timeoutByMode: options.timeoutByMode,
        parentSignal: ctrl.signal,
        prefer: options.prefer,
        preferGraceMs: options.preferGraceMs,
      });
      if (disposed) return 'skipped';
      const phase = options.kernel.phase;
      if (phase.kind !== 'online') {
        options.onResult?.('skipped', `phase=${phase.kind}`);
        return 'skipped';
      }
      const same = phase.target.endpoint.url === endpoint.url && phase.target.endpoint.mode === endpoint.mode;
      options.kernel.dispatch({ type: 'ENDPOINT_SWAP', endpoint, tokens });
      const outcome = same ? 'same' : 'swap';
      options.onResult?.(outcome, endpoint.url);
      return outcome;
    } catch (err) {
      options.onResult?.('failed', err instanceof Error ? err.message : String(err));
      return 'failed';
    }
  }

  return {
    run() {
      if (disposed) return Promise.resolve<BackgroundProbeOutcome>('skipped');
      if (inflight) return inflight;
      inflight = round().finally(() => {
        inflight = null;
      });
      return inflight;
    },
    dispose() {
      disposed = true;
    },
  };
}
