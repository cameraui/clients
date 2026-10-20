import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createKernel } from '../../core/kernel.js';
import { attachBackoff } from '../backoff.js';

import type { ConnectionPhase, Endpoint, ReducerContext, Tokens } from '../../core/types.js';

const LAN: Endpoint = { url: 'https://nvr.local', mode: 'direct-lan' };
const TOKENS: Tokens = { access: 'at' };
const T0 = 1_000_000;

function makeCtx(): ReducerContext {
  return { now: () => Date.now() };
}

function offlineWith(nextRetryAt = T0): ConnectionPhase {
  return { kind: 'offline', instanceId: 'a', lastError: 'test', nextRetryAt };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('attachBackoff — basic schedule', () => {
  it('does not schedule when starting from non-offline phase', () => {
    const kernel = createKernel({ context: makeCtx() });
    const onScheduled = vi.fn();
    attachBackoff({ kernel, schedule: [5_000], onScheduled });
    expect(onScheduled).not.toHaveBeenCalled();
  });

  it('schedules immediately when starting from offline', () => {
    const kernel = createKernel({ context: makeCtx(), initial: offlineWith() });
    const onScheduled = vi.fn();
    attachBackoff({ kernel, schedule: [5_000], onScheduled });
    expect(onScheduled).toHaveBeenCalledWith(1, 5_000);
  });

  it('dispatches USER_RETRY when the timer fires', () => {
    const kernel = createKernel({ context: makeCtx(), initial: offlineWith() });
    const dispatchSpy = vi.spyOn(kernel, 'dispatch');
    attachBackoff({ kernel, schedule: [5_000] });

    vi.advanceTimersByTime(4_999);
    expect(dispatchSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(dispatchSpy).toHaveBeenCalledWith({ type: 'USER_RETRY' });
  });
});

describe('attachBackoff — exponential / capped schedule', () => {
  it('uses successive delays for repeated offlines', () => {
    const schedule = [5_000, 10_000, 30_000];
    const kernel = createKernel({ context: makeCtx() });
    const onScheduled = vi.fn();
    attachBackoff({ kernel, schedule, onScheduled });

    kernel.dispatch({ type: 'BOOT', instanceId: 'a' });
    kernel.dispatch({ type: 'PROBE_FAILED_ALL', error: 'x' });
    expect(onScheduled).toHaveBeenLastCalledWith(1, 5_000);

    vi.advanceTimersByTime(5_001);
    kernel.dispatch({ type: 'PROBE_FAILED_ALL', error: 'x' });
    expect(onScheduled).toHaveBeenLastCalledWith(2, 10_000);

    vi.advanceTimersByTime(10_001);
    kernel.dispatch({ type: 'PROBE_FAILED_ALL', error: 'x' });
    expect(onScheduled).toHaveBeenLastCalledWith(3, 30_000);
  });

  it('caps at the last schedule entry for further attempts', () => {
    const schedule = [5_000, 8_000];
    const kernel = createKernel({ context: makeCtx() });
    const onScheduled = vi.fn();
    attachBackoff({ kernel, schedule, onScheduled });

    kernel.dispatch({ type: 'BOOT', instanceId: 'a' });
    kernel.dispatch({ type: 'PROBE_FAILED_ALL', error: 'x' });
    vi.advanceTimersByTime(5_001);
    kernel.dispatch({ type: 'PROBE_FAILED_ALL', error: 'x' });
    vi.advanceTimersByTime(8_001);
    kernel.dispatch({ type: 'PROBE_FAILED_ALL', error: 'x' });
    vi.advanceTimersByTime(8_001);
    kernel.dispatch({ type: 'PROBE_FAILED_ALL', error: 'x' });

    expect(onScheduled.mock.calls.map((c) => c[1])).toEqual([5_000, 8_000, 8_000, 8_000]);
  });
});

describe('attachBackoff — cancel + reset', () => {
  it('cancels the timer when phase leaves offline', () => {
    const kernel = createKernel({ context: makeCtx(), initial: offlineWith() });
    const onFire = vi.fn();
    const onCancelled = vi.fn();
    attachBackoff({ kernel, schedule: [5_000], onFire, onCancelled });

    kernel.dispatch({ type: 'USER_RETRY' });
    expect(kernel.phase.kind).toBe('discovering');
    vi.advanceTimersByTime(10_000);
    expect(onFire).not.toHaveBeenCalled();
    expect(onCancelled).toHaveBeenCalledWith('phase-left-offline');
  });

  it('resets the attempt counter on online', () => {
    const schedule = [5_000, 10_000];
    const kernel = createKernel({ context: makeCtx() });
    const onScheduled = vi.fn();
    attachBackoff({ kernel, schedule, onScheduled });

    kernel.dispatch({ type: 'BOOT', instanceId: 'a' });
    kernel.dispatch({ type: 'PROBE_FAILED_ALL', error: 'x' });
    vi.advanceTimersByTime(5_001); // fires USER_RETRY
    kernel.dispatch({ type: 'PROBE_FAILED_ALL', error: 'x' });
    expect(onScheduled.mock.calls.map((c) => c[1])).toEqual([5_000, 10_000]);

    kernel.dispatch({ type: 'USER_RETRY' });
    kernel.dispatch({ type: 'PROBE_SUCCEEDED', endpoint: LAN, tokens: TOKENS });
    expect(kernel.phase.kind).toBe('online');

    // TOKENS_INVALID goes to needs-auth without backoff, so restart via RESET + BOOT
    kernel.dispatch({ type: 'RESET' });
    kernel.dispatch({ type: 'BOOT', instanceId: 'a' });
    kernel.dispatch({ type: 'PROBE_FAILED_ALL', error: 'x' });
    expect(kernel.phase.kind).toBe('offline');
    expect(onScheduled.mock.calls.map((c) => c[1])).toEqual([5_000, 10_000, 5_000]);
  });

  it('resets the attempt counter on idle (logout)', () => {
    const schedule = [5_000, 10_000];
    const kernel = createKernel({ context: makeCtx() });
    const onScheduled = vi.fn();
    attachBackoff({ kernel, schedule, onScheduled });

    kernel.dispatch({ type: 'BOOT', instanceId: 'a' });
    kernel.dispatch({ type: 'PROBE_FAILED_ALL', error: 'x' });
    vi.advanceTimersByTime(5_001);
    kernel.dispatch({ type: 'PROBE_FAILED_ALL', error: 'x' });
    expect(onScheduled.mock.calls.map((c) => c[1])).toEqual([5_000, 10_000]);

    kernel.dispatch({ type: 'RESET' });
    expect(kernel.phase.kind).toBe('idle');

    kernel.dispatch({ type: 'BOOT', instanceId: 'a' });
    kernel.dispatch({ type: 'PROBE_FAILED_ALL', error: 'x' });
    expect(onScheduled.mock.calls.map((c) => c[1])).toEqual([5_000, 10_000, 5_000]);
  });
});

describe('attachBackoff — BACKOFF_HINT', () => {
  it('extends the wait when a server hint pushes nextRetryAt further out', () => {
    const schedule = [5_000];
    const kernel = createKernel({ context: makeCtx() });
    const onScheduled = vi.fn();
    const onHintApplied = vi.fn();
    attachBackoff({ kernel, schedule, onScheduled, onHintApplied });

    kernel.dispatch({ type: 'BOOT', instanceId: 'a' });
    kernel.dispatch({ type: 'PROBE_FAILED_ALL', error: 'x' });
    expect(onScheduled).toHaveBeenLastCalledWith(1, 5_000);
    expect(onHintApplied).not.toHaveBeenCalled();

    kernel.dispatch({ type: 'BACKOFF_HINT', retryAfterMs: 30_000, source: 'tunnel-503' });

    expect(onScheduled).toHaveBeenLastCalledWith(1, 30_000);
    expect(onHintApplied).toHaveBeenCalledWith(30_000, 'tunnel-503');

    vi.advanceTimersByTime(5_500);
    if (kernel.phase.kind !== 'offline') throw new Error('expected offline');
    expect(kernel.phase.kind).toBe('offline');

    vi.advanceTimersByTime(25_000);
    expect(kernel.phase.kind).toBe('discovering');
  });

  it('keeps the longer wait when the hint is shorter than the local schedule', () => {
    const schedule = [60_000];
    const kernel = createKernel({ context: makeCtx() });
    const onScheduled = vi.fn();
    const onHintApplied = vi.fn();
    attachBackoff({ kernel, schedule, onScheduled, onHintApplied });

    kernel.dispatch({ type: 'BOOT', instanceId: 'a' });
    kernel.dispatch({ type: 'PROBE_FAILED_ALL', error: 'x' });
    expect(onScheduled).toHaveBeenLastCalledWith(1, 60_000);

    kernel.dispatch({ type: 'BACKOFF_HINT', retryAfterMs: 5_000 });

    expect(onScheduled).toHaveBeenCalledTimes(1);
    expect(onHintApplied).not.toHaveBeenCalled();
  });

  it('records the hint in phase.backoffHint for UI consumption', () => {
    const kernel = createKernel({ context: makeCtx() });
    attachBackoff({ kernel, schedule: [5_000] });

    kernel.dispatch({ type: 'BOOT', instanceId: 'a' });
    kernel.dispatch({ type: 'PROBE_FAILED_ALL', error: 'x' });
    kernel.dispatch({ type: 'BACKOFF_HINT', retryAfterMs: 30_000, source: 'tunnel-503' });

    if (kernel.phase.kind !== 'offline') throw new Error('expected offline');
    expect(kernel.phase.backoffHint?.retryAfterMs).toBe(30_000);
    expect(kernel.phase.backoffHint?.source).toBe('tunnel-503');
  });

  it('is a no-op when not offline', () => {
    const kernel = createKernel({ context: makeCtx() });
    attachBackoff({ kernel, schedule: [5_000] });
    const phaseBefore = kernel.phase;

    kernel.dispatch({ type: 'BACKOFF_HINT', retryAfterMs: 30_000 });
    expect(kernel.phase).toBe(phaseBefore);
  });
});

describe('attachBackoff — detach', () => {
  it('detach cancels pending timer and removes subscribers', () => {
    const kernel = createKernel({ context: makeCtx(), initial: offlineWith() });
    const onFire = vi.fn();
    const onCancelled = vi.fn();
    const detach = attachBackoff({ kernel, schedule: [5_000], onFire, onCancelled });

    detach();
    vi.advanceTimersByTime(10_000);
    expect(onFire).not.toHaveBeenCalled();
    expect(onCancelled).toHaveBeenCalledWith('detach');
  });

  it('detach prevents future scheduling', () => {
    const kernel = createKernel({ context: makeCtx() });
    const onScheduled = vi.fn();
    const detach = attachBackoff({ kernel, schedule: [5_000], onScheduled });
    detach();

    kernel.dispatch({ type: 'BOOT', instanceId: 'a' });
    kernel.dispatch({ type: 'PROBE_FAILED_ALL', error: 'x' });
    expect(onScheduled).not.toHaveBeenCalled();
  });
});

describe('attachBackoff — firstAttemptDelayMs', () => {
  it('shortens only the first attempt', () => {
    const kernel = createKernel({ context: makeCtx(), initial: offlineWith() });
    const onScheduled = vi.fn();
    const dispatchSpy = vi.spyOn(kernel, 'dispatch');
    attachBackoff({ kernel, schedule: [5_000, 5_000], firstAttemptDelayMs: () => 1_500, onScheduled });

    expect(onScheduled).toHaveBeenCalledWith(1, 1_500);
    vi.advanceTimersByTime(1_500);
    expect(dispatchSpy).toHaveBeenCalledWith({ type: 'USER_RETRY' });

    kernel.dispatch({ type: 'PROBE_FAILED_ALL', error: 'still down' });
    expect(onScheduled).toHaveBeenLastCalledWith(2, 5_000);
  });

  it('cannot extend the schedule', () => {
    const kernel = createKernel({ context: makeCtx(), initial: offlineWith() });
    const onScheduled = vi.fn();
    attachBackoff({ kernel, schedule: [1_000], firstAttemptDelayMs: () => 60_000, onScheduled });
    expect(onScheduled).toHaveBeenCalledWith(1, 1_000);
  });

  it('shortens the first attempt of an offline phase the reducer produced', () => {
    const kernel = createKernel({ context: makeCtx() });
    const onScheduled = vi.fn();
    const onFire = vi.fn();
    attachBackoff({ kernel, schedule: [5_000], firstAttemptDelayMs: () => 1_500, onScheduled, onFire });

    kernel.dispatch({ type: 'BOOT', instanceId: 'a' });
    kernel.dispatch({ type: 'PROBE_FAILED_ALL', error: 'radio not ready' });
    expect(onScheduled).toHaveBeenCalledWith(1, 1_500);

    vi.advanceTimersByTime(1_500);
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(kernel.phase.kind).toBe('discovering');
  });

  it('never undercuts a server backoff hint', () => {
    const kernel = createKernel({ context: makeCtx() });
    const onScheduled = vi.fn();
    attachBackoff({ kernel, schedule: [5_000], firstAttemptDelayMs: () => 1_500, onScheduled });

    kernel.dispatch({ type: 'BOOT', instanceId: 'a' });
    kernel.dispatch({ type: 'PROBE_FAILED_ALL', error: 'x' });
    kernel.dispatch({ type: 'BACKOFF_HINT', retryAfterMs: 30_000, source: 'retry-after' });
    expect(onScheduled).toHaveBeenLastCalledWith(1, 30_000);
  });

  it('waits for a server hint that lands in the same millisecond as the failure', () => {
    const kernel = createKernel({ context: makeCtx() });
    const onScheduled = vi.fn();
    const onFire = vi.fn();
    attachBackoff({ kernel, schedule: [5_000], firstAttemptDelayMs: () => 1_500, onScheduled, onFire });

    kernel.dispatch({ type: 'BOOT', instanceId: 'a' });
    kernel.dispatch({ type: 'PROBE_FAILED_ALL', error: 'x' });
    kernel.dispatch({ type: 'BACKOFF_HINT', retryAfterMs: 5_000, source: 'retry-after' });
    expect(onScheduled).toHaveBeenLastCalledWith(1, 5_000);

    vi.advanceTimersByTime(4_999);
    expect(onFire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it('waits for a server hint shorter than the default retry', () => {
    const kernel = createKernel({ context: makeCtx() });
    const onScheduled = vi.fn();
    attachBackoff({ kernel, schedule: [5_000], firstAttemptDelayMs: () => 1_500, onScheduled });

    kernel.dispatch({ type: 'BOOT', instanceId: 'a' });
    kernel.dispatch({ type: 'PROBE_FAILED_ALL', error: 'x' });
    kernel.dispatch({ type: 'BACKOFF_HINT', retryAfterMs: 3_000, source: 'retry-after' });
    expect(onScheduled).toHaveBeenLastCalledWith(1, 3_000);
  });

  it('keeps the schedule when a server hint is shorter than it', () => {
    const kernel = createKernel({ context: makeCtx() });
    const onScheduled = vi.fn();
    attachBackoff({ kernel, schedule: [5_000], onScheduled });

    kernel.dispatch({ type: 'BOOT', instanceId: 'a' });
    kernel.dispatch({ type: 'PROBE_FAILED_ALL', error: 'x' });
    kernel.dispatch({ type: 'BACKOFF_HINT', retryAfterMs: 3_000, source: 'retry-after' });
    expect(onScheduled).toHaveBeenLastCalledWith(1, 5_000);
  });

  it('falls back to the schedule when the hook returns null', () => {
    const kernel = createKernel({ context: makeCtx(), initial: offlineWith() });
    const onScheduled = vi.fn();
    attachBackoff({ kernel, schedule: [5_000], firstAttemptDelayMs: () => null, onScheduled });
    expect(onScheduled).toHaveBeenCalledWith(1, 5_000);
  });

  it('restarts the schedule when a retry from outside lands while the fast path is open', () => {
    let woke = false;
    const kernel = createKernel({ context: makeCtx() });
    const onScheduled = vi.fn();
    attachBackoff({ kernel, schedule: [5_000, 10_000, 30_000], firstAttemptDelayMs: () => (woke ? 1_500 : null), onScheduled });

    kernel.dispatch({ type: 'BOOT', instanceId: 'a' });
    kernel.dispatch({ type: 'PROBE_FAILED_ALL', error: 'x' });
    vi.advanceTimersByTime(5_000);
    kernel.dispatch({ type: 'PROBE_FAILED_ALL', error: 'x' });
    vi.advanceTimersByTime(10_000);
    kernel.dispatch({ type: 'PROBE_FAILED_ALL', error: 'x' });
    expect(onScheduled).toHaveBeenLastCalledWith(3, 30_000);

    woke = true;
    kernel.dispatch({ type: 'USER_RETRY' });
    kernel.dispatch({ type: 'PROBE_FAILED_ALL', error: 'x' });
    expect(onScheduled).toHaveBeenLastCalledWith(1, 1_500);

    vi.advanceTimersByTime(1_500);
    kernel.dispatch({ type: 'PROBE_FAILED_ALL', error: 'x' });
    expect(onScheduled).toHaveBeenLastCalledWith(2, 10_000);
  });

  it('keeps its place in the schedule for a retry from outside while the fast path is closed', () => {
    const kernel = createKernel({ context: makeCtx() });
    const onScheduled = vi.fn();
    attachBackoff({ kernel, schedule: [5_000, 10_000, 30_000], firstAttemptDelayMs: () => null, onScheduled });

    kernel.dispatch({ type: 'BOOT', instanceId: 'a' });
    kernel.dispatch({ type: 'PROBE_FAILED_ALL', error: 'x' });
    vi.advanceTimersByTime(5_000);
    kernel.dispatch({ type: 'PROBE_FAILED_ALL', error: 'x' });
    expect(onScheduled).toHaveBeenLastCalledWith(2, 10_000);

    kernel.dispatch({ type: 'USER_RETRY' });
    kernel.dispatch({ type: 'PROBE_FAILED_ALL', error: 'x' });
    expect(onScheduled).toHaveBeenLastCalledWith(2, 10_000);
  });

  it('never restarts the schedule on its own retries while the fast path is open', () => {
    const kernel = createKernel({ context: makeCtx() });
    const onScheduled = vi.fn();
    attachBackoff({ kernel, schedule: [5_000, 10_000, 30_000], firstAttemptDelayMs: () => 1_500, onScheduled });

    kernel.dispatch({ type: 'BOOT', instanceId: 'a' });
    kernel.dispatch({ type: 'PROBE_FAILED_ALL', error: 'x' });
    vi.advanceTimersByTime(1_500);
    kernel.dispatch({ type: 'PROBE_FAILED_ALL', error: 'x' });
    vi.advanceTimersByTime(10_000);
    kernel.dispatch({ type: 'PROBE_FAILED_ALL', error: 'x' });
    expect(onScheduled.mock.calls.map((c) => c[1])).toEqual([1_500, 10_000, 30_000]);
  });
});
