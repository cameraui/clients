import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createActivityMode } from '../activityMode.js';

import type { CameraActivityMode } from '../activityMode.js';

function fakeStream(initialMode: CameraActivityMode, { playsOnStart = true } = {}) {
  let playing = false;
  const onStreamStart = vi.fn(() => {
    if (playsOnStart) playing = true;
  });
  const onStreamStop = vi.fn(() => {
    playing = false;
  });
  const activity = createActivityMode({ initialMode, onStreamStart, onStreamStop, isStreamPlaying: () => playing });
  // useCameraStream re-arms the idle timer when the first frame plays
  function firstFrame() {
    playing = true;
    activity.resetIdleTimer();
  }
  return { activity, onStreamStart, onStreamStop, firstFrame };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createActivityMode', () => {
  it('starts the stream on the first activity of a camera that opened in activity mode', () => {
    const { activity, onStreamStart } = fakeStream('activity');

    activity.reportActivity(true);

    expect(onStreamStart).toHaveBeenCalledOnce();
    expect(activity.inStandby.value).toBe(false);
    activity.dispose();
  });

  it('starts a camera that opens in always-on and keeps it running', () => {
    const { activity, onStreamStart, onStreamStop } = fakeStream('always-on');

    activity.engage();
    expect(onStreamStart).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(60_000);
    expect(onStreamStop).not.toHaveBeenCalled();
    expect(activity.inStandby.value).toBe(false);
    activity.dispose();
  });

  it('rests a camera that opens in activity mode until something happens', () => {
    const { activity, onStreamStart } = fakeStream('activity');

    activity.engage();
    expect(activity.inStandby.value).toBe(true);
    expect(onStreamStart).not.toHaveBeenCalled();

    activity.reportActivity(true);
    expect(onStreamStart).toHaveBeenCalledOnce();
    expect(activity.inStandby.value).toBe(false);

    activity.reportActivity(false);
    vi.advanceTimersByTime(5_000);
    expect(activity.inStandby.value).toBe(true);
    activity.dispose();
  });

  it('rests a camera that opens in standby until it is tapped', () => {
    const { activity, onStreamStart, onStreamStop } = fakeStream('standby');

    activity.engage();
    activity.resetIdleTimer();
    vi.advanceTimersByTime(60_000);
    expect(onStreamStart).not.toHaveBeenCalled();
    expect(activity.inStandby.value).toBe(true);

    activity.resumeFromStandby();
    expect(onStreamStart).toHaveBeenCalledOnce();
    expect(activity.inStandby.value).toBe(false);

    vi.advanceTimersByTime(5_000);
    expect(onStreamStop).toHaveBeenCalledTimes(2);
    expect(activity.inStandby.value).toBe(true);
    activity.dispose();
  });

  it('does not start the stream when standby arrives before the first engage', () => {
    const { activity, onStreamStart } = fakeStream('always-on');

    activity.setMode('standby');
    activity.engage();

    expect(onStreamStart).not.toHaveBeenCalled();
    expect(activity.inStandby.value).toBe(true);
    activity.dispose();
  });

  it('counts the standby timeout from the first frame of a slow camera', () => {
    const { activity, onStreamStart, onStreamStop, firstFrame } = fakeStream('standby', { playsOnStart: false });
    activity.engage();
    onStreamStop.mockClear();

    activity.resumeFromStandby();
    expect(onStreamStart).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(8_000);
    expect(onStreamStop).not.toHaveBeenCalled();

    firstFrame();
    vi.advanceTimersByTime(4_999);
    expect(onStreamStop).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onStreamStop).toHaveBeenCalledOnce();
    expect(activity.inStandby.value).toBe(true);
    activity.dispose();
  });

  it('rests a standby camera that never delivers a picture after the wake timeout', () => {
    const { activity, onStreamStop } = fakeStream('standby', { playsOnStart: false });
    activity.engage();
    activity.resumeFromStandby();
    onStreamStop.mockClear();

    vi.advanceTimersByTime(29_999);
    expect(onStreamStop).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onStreamStop).toHaveBeenCalledOnce();
    expect(activity.inStandby.value).toBe(true);
    activity.dispose();
  });

  it('keeps a standby stream that another view already plays until the timeout', () => {
    const { activity, onStreamStart, onStreamStop } = fakeStream('standby');
    onStreamStart();

    activity.engage();
    expect(activity.inStandby.value).toBe(false);
    expect(onStreamStop).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5_000);
    expect(onStreamStop).toHaveBeenCalledOnce();
    expect(activity.inStandby.value).toBe(true);
    activity.dispose();
  });

  it('restarts the standby timeout on every interaction', () => {
    const { activity, onStreamStop } = fakeStream('standby');
    activity.engage();
    activity.resumeFromStandby();
    onStreamStop.mockClear();

    vi.advanceTimersByTime(4_000);
    activity.resetIdleTimer();
    vi.advanceTimersByTime(4_000);
    expect(onStreamStop).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1_000);
    expect(onStreamStop).toHaveBeenCalledOnce();
    expect(activity.inStandby.value).toBe(true);
    activity.dispose();
  });

  it('keeps a standby stream awake while a session holds it', () => {
    const { activity, onStreamStart, onStreamStop } = fakeStream('standby');
    activity.engage();
    onStreamStop.mockClear();

    activity.setKeepAwake(true);
    expect(onStreamStart).not.toHaveBeenCalled();

    activity.resumeFromStandby();
    vi.advanceTimersByTime(60_000);
    expect(onStreamStop).not.toHaveBeenCalled();
    expect(activity.inStandby.value).toBe(false);

    activity.setKeepAwake(false);
    vi.advanceTimersByTime(4_999);
    expect(onStreamStop).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onStreamStop).toHaveBeenCalledOnce();
    expect(activity.inStandby.value).toBe(true);
    activity.dispose();
  });

  it('keeps the hold across a switch from always on to standby', () => {
    const { activity, onStreamStop } = fakeStream('always-on');
    activity.engage();

    activity.setKeepAwake(true);
    activity.setMode('standby');
    vi.advanceTimersByTime(60_000);
    expect(onStreamStop).not.toHaveBeenCalled();

    activity.setKeepAwake(false);
    vi.advanceTimersByTime(5_000);
    expect(onStreamStop).toHaveBeenCalledOnce();
    expect(activity.inStandby.value).toBe(true);
    activity.dispose();
  });

  it('lets an activity stream rest after the activity ends even while held', () => {
    const { activity } = fakeStream('activity');
    activity.engage();
    activity.reportActivity(true);

    activity.setKeepAwake(true);
    activity.reportActivity(false);
    vi.advanceTimersByTime(5_000);
    expect(activity.inStandby.value).toBe(true);
    activity.dispose();
  });

  it('keeps an activity stream that is already playing until the grace period ends', () => {
    const { activity, onStreamStart, onStreamStop } = fakeStream('always-on');
    onStreamStart();
    activity.engage();

    activity.setMode('activity');
    activity.reportActivity(true);
    expect(onStreamStart).toHaveBeenCalledOnce();
    expect(onStreamStop).not.toHaveBeenCalled();
    activity.dispose();
  });
});
