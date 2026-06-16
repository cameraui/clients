import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RaceFirstError, raceFirst } from '../race.js';

import type { Endpoint } from '../core/types.js';
import type { RaceCandidate } from '../race.js';

const LAN: Endpoint = { url: 'https://lan.local:3443', mode: 'direct-lan' };
const WAN: Endpoint = { url: 'https://wan.example.com', mode: 'direct-wan' };

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('raceFirst — happy paths', () => {
  it('resolves with the first successful candidate', async () => {
    const fast = deferred<string>();

    const candidates: RaceCandidate<string>[] = [
      { endpoint: LAN, run: () => new Promise<string>(() => {}) /* never */ },
      { endpoint: WAN, run: () => fast.promise },
    ];

    const racePromise = raceFirst(candidates);
    fast.resolve('hit-wan');

    await expect(racePromise).resolves.toEqual({ endpoint: WAN, value: 'hit-wan' });
  });

  it('aborts losing candidates when the winner resolves', async () => {
    const aborts: AbortSignal[] = [];

    const candidates: RaceCandidate<string>[] = [
      {
        endpoint: LAN,
        run: (signal) => {
          aborts.push(signal);
          return new Promise<string>((_, rej) => {
            signal.addEventListener('abort', () => rej(new Error('aborted')));
          });
        },
      },
      {
        endpoint: WAN,
        run: () => Promise.resolve('win'),
      },
    ];

    await raceFirst(candidates);
    // Microtask flush for the loser's abort to propagate.
    await Promise.resolve();
    expect(aborts[0]!.aborted).toBe(true);
  });

  it('single candidate still races (timer + abort path)', async () => {
    const candidates: RaceCandidate<string>[] = [{ endpoint: LAN, run: () => Promise.resolve('solo') }];
    await expect(raceFirst(candidates)).resolves.toEqual({ endpoint: LAN, value: 'solo' });
  });
});

describe('raceFirst — failure semantics', () => {
  it('rejects with all-failed when every candidate errors', async () => {
    const candidates: RaceCandidate<string>[] = [
      { endpoint: LAN, run: () => Promise.reject(new Error('lan-down')) },
      { endpoint: WAN, run: () => Promise.reject(new Error('wan-down')) },
    ];

    await expect(raceFirst(candidates)).rejects.toMatchObject({
      name: 'RaceFirstError',
      kind: 'all-failed',
    });
  });

  it('short-circuits on the first matching error and surfaces the matched endpoint', async () => {
    const candidates: RaceCandidate<string>[] = [
      {
        endpoint: LAN,
        run: () => Promise.reject(Object.assign(new Error('lan'), { kind: 'needs-auth' })),
      },
      { endpoint: WAN, run: () => new Promise<string>(() => {}) /* never */ },
    ];

    const err = await raceFirst(candidates, {
      shortCircuit: (e) => (e as { kind?: string }).kind === 'needs-auth',
    }).then(
      () => null,
      (e) => e as RaceFirstError,
    );

    expect(err).toBeInstanceOf(RaceFirstError);
    expect(err!.kind).toBe('short-circuit');
    expect(err!.endpoint).toEqual(LAN);
  });

  it('rejects with aborted when parent signal fires before any candidate settles', async () => {
    const ctrl = new AbortController();
    const candidates: RaceCandidate<string>[] = [
      { endpoint: LAN, run: () => new Promise<string>(() => {}) },
      { endpoint: WAN, run: () => new Promise<string>(() => {}) },
    ];

    const racePromise = raceFirst(candidates, { parentSignal: ctrl.signal });
    ctrl.abort();
    await expect(racePromise).rejects.toMatchObject({ name: 'RaceFirstError', kind: 'aborted' });
  });

  it('rejects immediately if parent signal is already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const candidates: RaceCandidate<string>[] = [{ endpoint: LAN, run: () => Promise.resolve('x') }];
    await expect(raceFirst(candidates, { parentSignal: ctrl.signal })).rejects.toMatchObject({ kind: 'aborted' });
  });

  it('rejects all-failed when candidates list is empty', async () => {
    await expect(raceFirst([])).rejects.toMatchObject({ kind: 'all-failed' });
  });
});

describe('raceFirst — per-mode timeout', () => {
  it('aborts a LAN candidate after the LAN timeout (default 2s) without rejecting other candidates', async () => {
    const wanResolve = deferred<string>();
    let lanAborted = false;
    const candidates: RaceCandidate<string>[] = [
      {
        endpoint: LAN,
        run: (signal) => {
          return new Promise<string>((_, rej) => {
            signal.addEventListener('abort', () => {
              lanAborted = true;
              rej(new Error('timed-out'));
            });
          });
        },
      },
      { endpoint: WAN, run: () => wanResolve.promise },
    ];

    const racePromise = raceFirst(candidates);
    await vi.advanceTimersByTimeAsync(2_001);
    expect(lanAborted).toBe(true);

    wanResolve.resolve('wan-win');
    await expect(racePromise).resolves.toEqual({ endpoint: WAN, value: 'wan-win' });
  });

  it('honors custom timeoutByMode override', async () => {
    let lanAborted = false;
    const candidates: RaceCandidate<string>[] = [
      {
        endpoint: LAN,
        run: (signal) =>
          new Promise<string>((_, rej) =>
            signal.addEventListener('abort', () => {
              lanAborted = true;
              rej(new Error('to'));
            }),
          ),
      },
    ];

    const racePromise = raceFirst(candidates, { timeoutByMode: () => 500 });
    const assertion = expect(racePromise).rejects.toMatchObject({ kind: 'all-failed' });
    await vi.advanceTimersByTimeAsync(501);
    expect(lanAborted).toBe(true);
    await assertion;
  });
});
