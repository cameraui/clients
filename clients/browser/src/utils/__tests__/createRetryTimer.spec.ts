import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRetryTimer } from '../createRetryTimer.js';

import type { RetryTimer } from '../createRetryTimer.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// schedules again from every run, like a retry that keeps failing
async function delaysOf(retry: RetryTimer, runs: number): Promise<number[]> {
  const delays: number[] = [];
  let last = Date.now();
  function run(): void {
    delays.push(Date.now() - last);
    last = Date.now();
    if (delays.length < runs) retry.schedule(run);
  }
  retry.schedule(run);
  await vi.runAllTimersAsync();
  return delays;
}

describe('createRetryTimer', () => {
  it('doubles the delay from 1 s and holds it at 30 s', async () => {
    expect(await delaysOf(createRetryTimer(), 9)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000, 30_000]);
  });

  it('keeps one waiting run and its delay when asked again', async () => {
    const retry = createRetryTimer();
    const first = vi.fn();
    const second = vi.fn();

    retry.schedule(first);
    await vi.advanceTimersByTimeAsync(500);
    retry.schedule(second);
    await vi.advanceTimersByTimeAsync(500);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    expect(await delaysOf(retry, 1)).toEqual([2_000]);
  });

  it('starts over at 1 s after a reset', async () => {
    const retry = createRetryTimer();
    await delaysOf(retry, 4);

    retry.reset();

    expect(await delaysOf(retry, 2)).toEqual([1_000, 2_000]);
  });

  it('drops the waiting run on cancel and keeps the grown delay', async () => {
    const retry = createRetryTimer();
    const dropped = vi.fn();
    await delaysOf(retry, 2);

    retry.schedule(dropped);
    retry.cancel();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(dropped).not.toHaveBeenCalled();
    expect(await delaysOf(retry, 1)).toEqual([8_000]);
  });

  it('leaves a waiting run in place on reset', async () => {
    const retry = createRetryTimer();
    const waiting = vi.fn();
    await delaysOf(retry, 3);

    retry.schedule(waiting);
    retry.reset();
    await vi.advanceTimersByTimeAsync(7_999);
    expect(waiting).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(waiting).toHaveBeenCalledTimes(1);
    expect(await delaysOf(retry, 1)).toEqual([1_000]);
  });
});
