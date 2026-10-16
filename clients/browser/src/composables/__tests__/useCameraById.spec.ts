import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, effectScope, ref, shallowRef } from 'vue';

import { CAMERA_UI_INJECTION_KEY, createCameraUiPlugin } from '../../plugin.js';
import { clearCameraCache, useCameraById } from '../useCameraById.js';
import { clearSnapshotCache, useSnapshot } from '../useSnapshot.js';

import type { RPCClient } from '@camera.ui/rpc';
import type { NatsTransport } from '@camera.ui/transport/transports/nats';
import type { DBCamera } from '../../server/index.js';
import type { CameraUiContext } from '../../types.js';

type Listener = (msg: unknown) => void;

const CAMERA = { _id: 'cam-1', name: 'Front', sources: [] };

function fakeRpc() {
  const listeners = new Set<Listener>();
  const getCamera = vi.fn(async (): Promise<unknown> => CAMERA);
  const refreshStates = vi.fn(async () => ({ camera: CAMERA, cameraState: true, frameWorkerState: false, sensorStates: {} }));
  const snapshotWithMeta = vi.fn(async () => ({ data: new ArrayBuffer(3), ageMs: 0 }));

  const client = {
    async subscribe(_subject: string, cb: Listener) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    createProxy: () => ({ getCamera, refreshStates, snapshotWithMeta }),
  } as unknown as RPCClient;

  function emit(msg: unknown): void {
    for (const cb of [...listeners]) cb(msg);
  }

  return { client, getCamera, refreshStates, emit, active: () => listeners.size };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function inContext<T>(rpc: RPCClient, fn: () => T): { result: T; stop: () => void } {
  const app = createApp({});
  app.provide(CAMERA_UI_INJECTION_KEY, { rpc: shallowRef(rpc), isConnected: ref(true), on: () => {}, off: () => {} } as unknown as CameraUiContext);
  const scope = effectScope();
  const result = app.runWithContext(() => scope.run(fn)!);
  return { result, stop: () => scope.stop() };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  clearCameraCache();
  clearSnapshotCache();
  vi.useRealTimers();
});

describe('useCameraById by name and by id', () => {
  it('shares one device between a card by name and its snapshot by id', async () => {
    const rpc = fakeRpc();

    const card = inContext(rpc.client, () => ({ byName: useCameraById('Front'), snapshot: useSnapshot(CAMERA as unknown as DBCamera) }));
    await flush();

    expect(rpc.getCamera).toHaveBeenCalledTimes(1);
    expect(rpc.refreshStates).toHaveBeenCalledTimes(1);
    expect(rpc.active()).toBe(2);
    expect(card.result.byName.camera.value?.id).toBe('cam-1');
    card.stop();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(rpc.active()).toBe(0);
  });

  it('takes the cached device for a name once it was loaded by id', async () => {
    const rpc = fakeRpc();
    const byId = inContext(rpc.client, () => useCameraById('cam-1'));
    await flush();

    const byName = inContext(rpc.client, () => useCameraById('Front'));

    expect(byName.result.camera.value).toBe(byId.result.camera.value);
    expect(rpc.getCamera).toHaveBeenCalledTimes(1);
    byId.stop();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(rpc.active()).toBe(2);
    byName.stop();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(rpc.active()).toBe(0);
  });

  it('closes the second device when a load by name and one by id ran side by side', async () => {
    const rpc = fakeRpc();

    const byName = inContext(rpc.client, () => useCameraById('Front'));
    const byId = inContext(rpc.client, () => useCameraById('cam-1'));
    await flush();

    expect(byName.result.camera.value).toBe(byId.result.camera.value);
    expect(rpc.active()).toBe(2);
    byName.stop();
    byId.stop();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(rpc.active()).toBe(0);
  });

  it('keeps the device of a renamed camera for its new name', async () => {
    const rpc = fakeRpc();
    const name = ref('Front');
    const view = inContext(rpc.client, () => useCameraById(name));
    await flush();
    const device = view.result.camera.value;

    rpc.emit({ type: 'updated', data: { ...CAMERA, name: 'Back' } });
    name.value = 'Back';
    await flush();

    expect(view.result.camera.value).toBe(device);
    expect(rpc.getCamera).toHaveBeenCalledTimes(1);
    expect(rpc.active()).toBe(2);
    view.stop();
  });

  it('does not hand a renamed camera to its old name', async () => {
    const rpc = fakeRpc();
    const view = inContext(rpc.client, () => useCameraById('cam-1'));
    await flush();
    rpc.emit({ type: 'updated', data: { ...CAMERA, name: 'Back' } });
    rpc.getCamera.mockResolvedValueOnce({ _id: 'cam-2', name: 'Front', sources: [] });

    const other = inContext(rpc.client, () => useCameraById('Front'));
    await flush();

    expect(rpc.getCamera).toHaveBeenLastCalledWith('Front', '@camera.ui/browser');
    expect(other.result.camera.value?.id).toBe('cam-2');
    view.stop();
    other.stop();
  });

  it('loads its own device when the name a snapshot passed on now belongs to another camera', async () => {
    const rpc = fakeRpc();
    const cameras: Record<string, unknown> = { 'cam-1': { _id: 'cam-1', name: 'Back', sources: [] }, 'cam-2': { _id: 'cam-2', name: 'Front', sources: [] } };
    rpc.getCamera.mockImplementation(async (...args: unknown[]) => (args[0] === 'cam-1' ? cameras['cam-1'] : cameras['cam-2']));
    (rpc.client as unknown as { createProxy: unknown }).createProxy = (namespace: string) => ({
      getCamera: rpc.getCamera,
      refreshStates: async () => ({ camera: cameras[namespace.split('.')[1]], cameraState: true, frameWorkerState: false, sensorStates: {} }),
      snapshotWithMeta: async () => ({ data: new ArrayBuffer(3), ageMs: 0 }),
    });

    const card = inContext(rpc.client, () => ({
      snapshot: useSnapshot({ _id: 'cam-1', name: 'Front' } as unknown as DBCamera),
      byName: useCameraById('Front'),
    }));
    await flush();
    await flush();

    expect(rpc.getCamera).toHaveBeenLastCalledWith('Front', '@camera.ui/browser');
    expect(card.result.byName.camera.value?.id).toBe('cam-2');
    card.stop();
  });

  it('lets a view join the load after a cache clear when the load from before the clear fails', async () => {
    const rpc = fakeRpc();
    let failFirst!: () => void;
    let finishSecond!: () => void;
    rpc.getCamera.mockImplementationOnce(() => new Promise((_resolve, reject) => (failFirst = () => reject(new Error('boom')))));
    rpc.getCamera.mockImplementationOnce(() => new Promise((resolve) => (finishSecond = () => resolve(CAMERA))));

    const first = inContext(rpc.client, () => useCameraById('cam-1'));
    await flush();
    clearCameraCache();
    const second = inContext(rpc.client, () => useCameraById('cam-1'));
    await flush();
    failFirst();
    await flush();
    const third = inContext(rpc.client, () => useCameraById('cam-1'));
    await flush();

    expect(rpc.getCamera).toHaveBeenCalledTimes(2);
    finishSecond();
    await flush();
    expect(third.result.camera.value).toBeDefined();
    expect(third.result.camera.value).toBe(second.result.camera.value);
    first.stop();
    second.stop();
    third.stop();
  });
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

  it('does not release a newer device when a view from before the cache clear ends', async () => {
    const rpc = fakeRpc();
    const old = inContext(rpc.client, () => useCameraById('cam-1'));
    await flush();

    clearCameraCache();
    const fresh = inContext(rpc.client, () => useCameraById('cam-1'));
    await flush();
    const device = fresh.result.camera.value;
    old.stop();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(device).toBeDefined();
    expect(rpc.active()).toBe(2);
    fresh.stop();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(rpc.active()).toBe(0);
  });

  it('does not close a newer device when a view from before the cache clear refreshes', async () => {
    const rpc = fakeRpc();
    const old = inContext(rpc.client, () => useCameraById('cam-1'));
    await flush();

    clearCameraCache();
    const fresh = inContext(rpc.client, () => useCameraById('cam-1'));
    await flush();
    await old.result.refresh();
    await flush();

    expect(old.result.camera.value).toBe(fresh.result.camera.value);
    expect(rpc.active()).toBe(2);
    old.stop();
    fresh.stop();
  });

  it('closes the device it loaded when another view cached one after a cache clear', async () => {
    const rpc = fakeRpc();
    let finish!: (value: unknown) => void;
    rpc.getCamera.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    const early = inContext(rpc.client, () => useCameraById('cam-1'));
    await flush();

    clearCameraCache();
    const late = inContext(rpc.client, () => useCameraById('cam-1'));
    await flush();
    finish(CAMERA);
    await flush();

    expect(early.result.camera.value).toBe(late.result.camera.value);
    expect(rpc.active()).toBe(2);
    early.stop();
    late.stop();
    await vi.advanceTimersByTimeAsync(2_000);
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

describe('useCameraById after a connection drop', () => {
  function transportContext(initial: RPCClient) {
    let current: RPCClient | null = initial;
    const listeners = new Set<(client: RPCClient | null) => void>();
    const natsTransport = {
      getClient: () => current,
      subscribeClient(listener: (client: RPCClient | null) => void) {
        listeners.add(listener);
        listener(current);
        return () => listeners.delete(listener);
      },
      on: () => () => {},
    } as unknown as NatsTransport;
    let context!: CameraUiContext;
    createCameraUiPlugin({ natsTransport, target: ref(null) }).install({ provide: (_key, value) => (context = value as CameraUiContext) });

    function link(next: RPCClient | null): void {
      current = next;
      for (const listener of listeners) listener(next);
    }
    function mount() {
      const app = createApp({});
      app.provide(CAMERA_UI_INJECTION_KEY, context);
      const scope = effectScope();
      const result = app.runWithContext(() => scope.run(() => useCameraById('cam-1'))!);
      return { result, stop: () => scope.stop() };
    }
    return { link, mount };
  }

  it('refreshes the camera state after a short drop of the same client', async () => {
    const rpc = fakeRpc();
    (rpc.client as unknown as { isConnected: boolean }).isConnected = true;
    const app = transportContext(rpc.client);
    const { result, stop } = app.mount();
    await flush();
    expect(rpc.refreshStates).toHaveBeenCalledTimes(1);
    rpc.refreshStates.mockResolvedValueOnce({ camera: CAMERA, cameraState: false, frameWorkerState: false, sensorStates: {} });

    app.link(null);
    await vi.advanceTimersByTimeAsync(1_500);
    app.link(rpc.client);
    await flush();

    expect(rpc.refreshStates).toHaveBeenCalledTimes(2);
    expect(result.camera.value?.connected.value).toBe(false);
    expect(rpc.active()).toBe(2);
    stop();
  });

  it('subscribes again when the refresh after a short drop fails', async () => {
    const rpc = fakeRpc();
    (rpc.client as unknown as { isConnected: boolean }).isConnected = true;
    const app = transportContext(rpc.client);
    const { stop } = app.mount();
    await flush();
    rpc.refreshStates.mockRejectedValueOnce(new Error('boom'));

    app.link(null);
    await vi.advanceTimersByTimeAsync(1_500);
    app.link(rpc.client);
    await flush();

    expect(rpc.refreshStates).toHaveBeenCalledTimes(3);
    expect(rpc.active()).toBe(2);
    stop();
  });
});
