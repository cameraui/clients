import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref, shallowRef } from 'vue';

import { createStreamManager, restartConnectedStreams, streamManager } from '../streamManager.js';

import type { ReactiveStream, StreamStatus } from '../types.js';

function fakeStream() {
  return { destroy: vi.fn(), stop: vi.fn() } as unknown as ReactiveStream & { destroy: ReturnType<typeof vi.fn> };
}

function liveStream(status: StreamStatus, paused = false) {
  return { status: ref(status), paused: ref(paused), restart: vi.fn(async () => {}), destroy: vi.fn(), stop: vi.fn() } as unknown as ReactiveStream & {
    restart: ReturnType<typeof vi.fn>;
  };
}

function register(manager: ReturnType<typeof createStreamManager>, name = 'Garage') {
  const stream = fakeStream();
  manager.register(name, stream, shallowRef(), shallowRef(), shallowRef(), undefined);
  return stream;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('streamManager', () => {
  it('keeps a shared stream while any consumer holds it', async () => {
    const manager = createStreamManager({ releaseDelay: 2000 });
    const stream = register(manager);
    manager.acquire('Garage');
    expect(manager.getRefCount('Garage')).toBe(2);

    manager.release('Garage');
    await vi.advanceTimersByTimeAsync(10_000);

    expect(stream.destroy).not.toHaveBeenCalled();
    expect(manager.getRefCount('Garage')).toBe(1);
  });

  it('destroys the stream once the last consumer left and the release delay passed', async () => {
    const manager = createStreamManager({ releaseDelay: 2000 });
    const stream = register(manager);

    manager.release('Garage');
    await vi.advanceTimersByTimeAsync(1999);
    expect(stream.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(stream.destroy).toHaveBeenCalledTimes(1);
    expect(manager.has('Garage')).toBe(false);
  });

  it('hands the running stream to a consumer that comes back within the release delay', async () => {
    const manager = createStreamManager({ releaseDelay: 2000 });
    const stream = register(manager);

    manager.release('Garage');
    await vi.advanceTimersByTimeAsync(1000);
    const entry = manager.acquire('Garage');
    await vi.advanceTimersByTimeAsync(10_000);

    expect(entry?.stream).toBe(stream);
    expect(stream.destroy).not.toHaveBeenCalled();
    expect(manager.getRefCount('Garage')).toBe(1);
  });

  it('stops every stream and pending release on clear', async () => {
    const manager = createStreamManager({ releaseDelay: 2000 });
    const garage = register(manager, 'Garage');
    const door = register(manager, 'Door');
    manager.release('Door');

    manager.clear();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(garage.destroy).toHaveBeenCalledTimes(1);
    expect(door.destroy).toHaveBeenCalledTimes(1);
    expect(manager.has('Garage')).toBe(false);
  });
});

describe('restarting connected streams', () => {
  it('restarts the shared and standalone streams that are connected and not paused', () => {
    const manager = createStreamManager();
    const shared = liveStream('connected');
    const retrying = liveStream('reconnecting');
    const paused = liveStream('connected', true);
    const standalone = liveStream('connected');
    manager.register('Garage', shared, shallowRef(), shallowRef(), shallowRef(), undefined);
    manager.register('Door', retrying, shallowRef(), shallowRef(), shallowRef(), undefined);
    manager.register('Yard', paused, shallowRef(), shallowRef(), shallowRef(), undefined);
    manager.track(standalone);

    expect(manager.restartConnected()).toBe(2);
    expect(shared.restart).toHaveBeenCalledTimes(1);
    expect(standalone.restart).toHaveBeenCalledTimes(1);
    expect(retrying.restart).not.toHaveBeenCalled();
    expect(paused.restart).not.toHaveBeenCalled();
    manager.clear();
  });

  it('leaves a standalone stream alone once it is no longer tracked', () => {
    const manager = createStreamManager();
    const standalone = liveStream('connected');
    const untrack = manager.track(standalone);

    untrack();

    expect(manager.restartConnected()).toBe(0);
    expect(standalone.restart).not.toHaveBeenCalled();
  });

  it('restarts the streams of the shared manager', () => {
    const stream = liveStream('connected');
    streamManager.register('Garage', stream, shallowRef(), shallowRef(), shallowRef(), undefined);

    expect(restartConnectedStreams()).toBe(1);
    expect(stream.restart).toHaveBeenCalledTimes(1);
    streamManager.clear();
  });
});
