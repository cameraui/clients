import { SensorType } from '@camera.ui/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, effectScope, ref, shallowRef } from 'vue';

import { CAMERA_UI_INJECTION_KEY } from '../../plugin.js';
import { clearSensorCache, createSensorManager, useAllSensors, useClassifierSensors, useMotionSensor, useSensors } from '../useSensor.js';

import type { RPCClient } from '@camera.ui/rpc';
import type { CameraUiContext } from '../../types.js';

type Listener = (msg: unknown) => void;

const SENSORS = [
  { id: 'motion-1', type: SensorType.Motion, name: 'Motion', pluginId: 'p', assignedCameraIds: ['cam-1'], exposed: true, connected: true },
  { id: 'motion-2', type: SensorType.Motion, name: 'Motion 2', pluginId: 'p', assignedCameraIds: ['cam-2'], exposed: true, connected: true },
];

function fakeRpc() {
  const listeners = new Map<string, Set<Listener>>();
  const getSensors = vi.fn(async (): Promise<unknown[]> => SENSORS);
  const getSensorStates = vi.fn(async () => ({}));
  const failSubscribe = new Set<string>();

  const client = {
    async subscribe(subject: string, cb: Listener) {
      if (failSubscribe.has(subject)) throw new Error(`subscribe ${subject}`);
      const set = listeners.get(subject) ?? new Set<Listener>();
      set.add(cb);
      listeners.set(subject, set);
      return () => set.delete(cb);
    },
    createProxy: () => ({ getSensors, getSensorStates }),
  } as unknown as RPCClient;

  function active(): number {
    let count = 0;
    for (const set of listeners.values()) count += set.size;
    return count;
  }

  return { client, getSensors, getSensorStates, failSubscribe, active };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
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
  clearSensorCache();
  vi.useRealTimers();
});

describe('createSensorManager', () => {
  it('retries a failed init by itself', async () => {
    const rpc = fakeRpc();
    rpc.getSensors.mockRejectedValueOnce(new Error('boom'));
    const manager = createSensorManager(rpc.client);

    await expect(manager.ensureInitialized()).rejects.toThrow('boom');
    expect(manager.isInitialized.value).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(manager.isInitialized.value).toBe(true);
    expect(manager.sensors.value.map((s) => s.id)).toEqual(['motion-1', 'motion-2']);
    manager.close();
  });

  it('drops every subscription of a failed init so registry events do not pile up', async () => {
    const rpc = fakeRpc();
    rpc.failSubscribe.add('sensor.motion-2.subject');
    const manager = createSensorManager(rpc.client);

    await expect(manager.ensureInitialized()).rejects.toThrow();

    expect(rpc.active()).toBe(0);
    expect(manager.sensors.value).toEqual([]);
    manager.close();
  });

  it('leaves no subscriptions when closed while init is in flight', async () => {
    const rpc = fakeRpc();
    const pending = deferred<unknown[]>();
    rpc.getSensors.mockReturnValueOnce(pending.promise);
    const manager = createSensorManager(rpc.client);

    const init = manager.ensureInitialized();
    await flush();
    manager.close();
    pending.resolve(SENSORS);

    await expect(init).rejects.toThrow('sensor manager closed');
    expect(rpc.active()).toBe(0);
    expect(manager.sensors.value).toEqual([]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(rpc.getSensors).toHaveBeenCalledTimes(1);
  });

  it('stops retrying once closed', async () => {
    const rpc = fakeRpc();
    rpc.getSensors.mockRejectedValue(new Error('boom'));
    const manager = createSensorManager(rpc.client);

    await expect(manager.ensureInitialized()).rejects.toThrow('boom');
    manager.close();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(rpc.getSensors).toHaveBeenCalledTimes(1);
  });
});

describe('sensor composables', () => {
  it('fill in after a failed first load without a reconnect', async () => {
    const rpc = fakeRpc();
    rpc.getSensors.mockRejectedValueOnce(new Error('boom'));

    const { result, stop } = inContext(rpc.client, () => useAllSensors());
    await flush();
    expect(result.sensors.value).toEqual([]);
    expect(result.error.value?.message).toBe('boom');

    await vi.advanceTimersByTimeAsync(1_000);

    expect(result.sensors.value.map((s) => s.id)).toEqual(['motion-1', 'motion-2']);
    expect(result.error.value).toBeUndefined();
    stop();
  });

  it('fill in camera sensors after a failed first load', async () => {
    const rpc = fakeRpc();
    rpc.getSensors.mockRejectedValueOnce(new Error('boom'));

    const { result, stop } = inContext(rpc.client, () => ({ motion: useMotionSensor('cam-1'), all: useSensors('cam-1'), classifiers: useClassifierSensors('cam-1') }));
    await flush();
    expect(result.motion.sensor.value).toBeUndefined();
    expect(result.all.sensors.value).toEqual([]);
    expect(result.classifiers.error.value?.message).toBe('boom');

    await vi.advanceTimersByTimeAsync(1_000);

    expect(result.motion.sensor.value?.id).toBe('motion-1');
    expect(result.motion.error.value).toBeUndefined();
    expect(result.all.sensors.value.map((s) => s.id)).toEqual(['motion-1']);
    expect(result.all.error.value).toBeUndefined();
    expect(result.classifiers.error.value).toBeUndefined();
    stop();
  });

  it('stay unbound when the camera goes away while init is in flight', async () => {
    const rpc = fakeRpc();
    const pending = deferred<unknown[]>();
    rpc.getSensors.mockReturnValueOnce(pending.promise);
    const camera = ref<string | undefined>('cam-1');

    const { result, stop } = inContext(rpc.client, () => useMotionSensor(camera));
    await flush();
    camera.value = undefined;
    await flush();
    pending.resolve(SENSORS);
    await vi.advanceTimersByTimeAsync(0);

    expect(result.sensor.value).toBeUndefined();
    stop();
  });

  it('bind the sensor of the current camera', async () => {
    const rpc = fakeRpc();
    const camera = ref<string | undefined>('cam-1');

    const { result, stop } = inContext(rpc.client, () => useMotionSensor(camera));
    await vi.advanceTimersByTimeAsync(0);
    expect(result.sensor.value?.id).toBe('motion-1');

    camera.value = 'cam-2';
    await vi.advanceTimersByTimeAsync(0);
    expect(result.sensor.value?.id).toBe('motion-2');
    stop();
  });

  it('close the shared manager after camera changes once the scope ends', async () => {
    const rpc = fakeRpc();
    const camera = ref<string | undefined>('cam-1');
    const plugin = ref<string | undefined>();

    const { stop } = inContext(rpc.client, () => ({ motion: useMotionSensor(camera, plugin), all: useSensors(camera) }));
    await vi.advanceTimersByTimeAsync(0);
    camera.value = 'cam-2';
    await vi.advanceTimersByTimeAsync(0);
    plugin.value = 'p';
    await vi.advanceTimersByTimeAsync(0);
    expect(rpc.active()).toBeGreaterThan(0);

    stop();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(rpc.active()).toBe(0);
  });

  it('take a new manager after the cache was cleared', async () => {
    const rpc = fakeRpc();
    const camera = ref<string | undefined>('cam-1');

    const { result, stop } = inContext(rpc.client, () => useMotionSensor(camera));
    await vi.advanceTimersByTimeAsync(0);
    clearSensorCache();
    expect(rpc.active()).toBe(0);

    camera.value = 'cam-2';
    await vi.advanceTimersByTimeAsync(0);
    expect(result.sensor.value?.id).toBe('motion-2');
    expect(rpc.active()).toBeGreaterThan(0);

    stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(rpc.active()).toBe(0);
  });

  it('do not release a newer manager when a composable from before the cache clear ends', async () => {
    const rpc = fakeRpc();

    const before = inContext(rpc.client, () => useMotionSensor('cam-1'));
    await vi.advanceTimersByTimeAsync(0);
    clearSensorCache();

    const after = inContext(rpc.client, () => useMotionSensor('cam-2'));
    await vi.advanceTimersByTimeAsync(0);
    before.stop();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(after.result.sensor.value?.id).toBe('motion-2');
    expect(rpc.active()).toBeGreaterThan(0);

    after.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(rpc.active()).toBe(0);
  });
});
