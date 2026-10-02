import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, effectScope, ref, shallowRef } from 'vue';

import { CAMERA_UI_INJECTION_KEY } from '../../plugin.js';
import { clearCameraCache, useCameraById } from '../useCameraById.js';

import type { RPCClient } from '@camera.ui/rpc';
import type { CameraUiContext } from '../../types.js';

type Listener = (msg: unknown) => void;

const CAMERA = { _id: 'cam-1', name: 'Front', sources: [] };

function fakeRpc() {
  const listeners = new Set<Listener>();
  const getCamera = vi.fn(async (): Promise<unknown> => CAMERA);
  const refreshStates = vi.fn(async () => ({ camera: CAMERA, cameraState: true, frameWorkerState: false, sensorStates: {} }));

  const client = {
    async subscribe(_subject: string, cb: Listener) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    createProxy: () => ({ getCamera, refreshStates }),
  } as unknown as RPCClient;

  return { client, getCamera, refreshStates, active: () => listeners.size };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function inContext<T>(rpc: RPCClient, fn: () => T): { result: T; stop: () => void } {
  const app = createApp({});
  app.provide(CAMERA_UI_INJECTION_KEY, { rpc: shallowRef(rpc), isConnected: ref(true) } as unknown as CameraUiContext);
  const scope = effectScope();
  const result = app.runWithContext(() => scope.run(fn)!);
  return { result, stop: () => scope.stop() };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  clearCameraCache();
  vi.useRealTimers();
});

describe('useCameraById', () => {
  it('loads the camera by itself after a failed first load', async () => {
    const rpc = fakeRpc();
    rpc.getCamera.mockRejectedValueOnce(new Error('boom'));

    const { result, stop } = inContext(rpc.client, () => useCameraById('cam-1'));
    await flush();
    expect(result.camera.value).toBeUndefined();
    expect(result.error.value?.message).toBe('boom');

    await vi.advanceTimersByTimeAsync(1_000);

    expect(result.camera.value?.id).toBe('cam-1');
    expect(result.error.value).toBeUndefined();
    stop();
  });

  it('keeps the error and the idle state while a retry is in flight', async () => {
    const rpc = fakeRpc();
    rpc.getCamera.mockRejectedValueOnce(new Error('boom'));
    let finish!: (value: unknown) => void;
    rpc.getCamera.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));

    const { result, stop } = inContext(rpc.client, () => useCameraById('cam-1'));
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(rpc.getCamera).toHaveBeenCalledTimes(2);
    expect(result.isLoading.value).toBe(false);
    expect(result.error.value?.message).toBe('boom');

    finish(CAMERA);
    await flush();
    expect(result.camera.value?.id).toBe('cam-1');
    expect(result.error.value).toBeUndefined();
    stop();
  });

  it('leaves no subscriptions of a device whose init failed', async () => {
    const rpc = fakeRpc();
    rpc.refreshStates.mockRejectedValueOnce(new Error('boom'));

    const { result, stop } = inContext(rpc.client, () => useCameraById('cam-1'));
    await flush();
    expect(result.error.value?.message).toBe('boom');
    expect(rpc.active()).toBe(0);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(result.camera.value?.id).toBe('cam-1');
    expect(rpc.active()).toBe(2);
    stop();
  });

  it('backs off between retries and stops once the scope ends', async () => {
    const rpc = fakeRpc();
    rpc.getCamera.mockRejectedValue(new Error('boom'));

    const { stop } = inContext(rpc.client, () => useCameraById('cam-1'));
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(rpc.getCamera).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(rpc.getCamera).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(rpc.getCamera).toHaveBeenCalledTimes(3);

    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(rpc.getCamera).toHaveBeenCalledTimes(3);
  });

  it('does not retry a load that fails after the scope ended', async () => {
    const rpc = fakeRpc();
    let fail!: (err: Error) => void;
    rpc.getCamera.mockReturnValueOnce(new Promise((_resolve, reject) => (fail = reject)));

    const { stop } = inContext(rpc.client, () => useCameraById('cam-1'));
    await flush();
    stop();
    fail(new Error('boom'));
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(rpc.getCamera).toHaveBeenCalledTimes(1);
    expect(rpc.active()).toBe(0);
  });

  it('closes a device that finishes loading after the scope ended', async () => {
    const rpc = fakeRpc();
    let finish!: (value: unknown) => void;
    rpc.getCamera.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));

    const { result, stop } = inContext(rpc.client, () => useCameraById('cam-1'));
    await flush();
    stop();
    finish(CAMERA);
    await flush();
    expect(result.camera.value).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(rpc.active()).toBe(0);
  });

  it('drops the retry for a camera the caller moved away from', async () => {
    const rpc = fakeRpc();
    rpc.getCamera.mockRejectedValueOnce(new Error('boom'));
    const id = ref('cam-1');

    const { stop } = inContext(rpc.client, () => useCameraById(id));
    await flush();
    id.value = '';
    await vi.advanceTimersByTimeAsync(60_000);

    expect(rpc.getCamera).toHaveBeenCalledTimes(1);
    stop();
  });
});
