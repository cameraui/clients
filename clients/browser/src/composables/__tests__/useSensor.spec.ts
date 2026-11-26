import { SensorType } from '@camera.ui/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, effectScope, isReactive, isRef, ref, shallowRef, watch } from 'vue';

import { CAMERA_UI_INJECTION_KEY } from '../../plugin.js';
import {
  acquireSensorManager,
  clearSensorCache,
  createSensorManager,
  reconnectAllSensorManagers,
  releaseSensorManager,
  useAllSensors,
  useClassifierSensors,
  useMotionSensor,
  useSensorById,
  useSensorByType,
  useSensors,
} from '../useSensor.js';

import type { RPCClient } from '@camera.ui/rpc';
import type { ShallowRef } from 'vue';
import type { CameraUiContext } from '../../types.js';

type Listener = (msg: unknown) => void;

const SENSORS = [
  { id: 'motion-1', type: SensorType.Motion, name: 'Motion', pluginId: 'p', assignedCameraIds: ['cam-1'], exposed: true, connected: true },
  { id: 'motion-2', type: SensorType.Motion, name: 'Motion 2', pluginId: 'p', assignedCameraIds: ['cam-2'], exposed: true, connected: true },
];

function fakeRpc(sensors: typeof SENSORS = SENSORS) {
  const listeners = new Map<string, Set<Listener>>();
  const values = new Map<string, Record<string, unknown>>();
  // the registry leaves disconnected sensors out of getSensorStates
  const offline = new Set<string>();
  const getSensors = vi.fn(async (): Promise<unknown[]> => sensors);
  const getSensorStates = vi.fn(async (): Promise<Record<string, unknown>> => states());
  // viewers may not call it, so the client never should
  const getSensorState = vi.fn(async (_sensorId: string): Promise<unknown> => undefined);
  const updateValue = vi.fn(async (_property: string, _value: unknown): Promise<void> => {});
  const failSubscribe = new Set<string>();
  const blockedSubscribe = new Map<string, Promise<void>>();

  const client = {
    async subscribe(subject: string, cb: Listener) {
      if (failSubscribe.has(subject)) throw new Error(`subscribe ${subject}`);
      await blockedSubscribe.get(subject);
      const set = listeners.get(subject) ?? new Set<Listener>();
      set.add(cb);
      listeners.set(subject, set);
      return () => set.delete(cb);
    },
    createProxy: () => ({ getSensors, getSensorStates, getSensorState, updateValue }),
  } as unknown as RPCClient;

  function active(): number {
    let count = 0;
    for (const set of listeners.values()) count += set.size;
    return count;
  }

  function subjects(): string[] {
    return [...listeners]
      .filter(([, set]) => set.size > 0)
      .map(([subject]) => subject)
      .sort();
  }

  function emit(subject: string, msg: unknown): void {
    for (const cb of listeners.get(subject) ?? []) cb(msg);
  }

  function states(): Record<string, unknown> {
    return Object.fromEntries(sensors.filter((s) => !offline.has(s.id)).map((s) => [s.id, { type: s.type, properties: { ...values.get(s.id) }, capabilities: [] }]));
  }

  function seed(sensorId: string, properties: Record<string, unknown>): void {
    values.set(sensorId, { ...values.get(sensorId), ...properties });
  }

  function write(sensorId: string, property: string, value: unknown): void {
    values.set(sensorId, { ...values.get(sensorId), [property]: value });
    emit(`sensor.${sensorId}.subject`, { type: 'property:changed', data: { sensorId, property, value, timestamp: Date.now() } });
  }

  function setConnected(sensorId: string, connected: boolean, seeded: Record<string, unknown> = {}): void {
    // a returning plugin seeds its values without property events
    values.set(sensorId, { ...values.get(sensorId), ...seeded });
    if (connected) offline.delete(sensorId);
    else offline.add(sensorId);
    emit('sensors.subject', { type: 'sensor:connected:changed', data: { sensorId, connected } });
  }

  function blockSubscribe(subject: string): () => void {
    const gate = deferred<void>();
    blockedSubscribe.set(subject, gate.promise);
    return () => {
      blockedSubscribe.delete(subject);
      gate.resolve();
    };
  }

  return {
    client,
    getSensors,
    getSensorStates,
    getSensorState,
    updateValue,
    failSubscribe,
    offline,
    active,
    subjects,
    emit,
    states,
    write,
    seed,
    setConnected,
    blockSubscribe,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function inContext<T>(rpc: RPCClient | ShallowRef<RPCClient | undefined>, fn: () => T): { result: T; stop: () => void } {
  const app = createApp({});
  app.provide(CAMERA_UI_INJECTION_KEY, { rpc: isRef(rpc) ? rpc : shallowRef(rpc), isConnected: ref(true) } as unknown as CameraUiContext);
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

  it('keeps property values raw and still triggers on replacement', async () => {
    const rpc = fakeRpc();
    rpc.getSensorStates.mockResolvedValueOnce({ 'motion-1': { type: SensorType.Motion, properties: { detections: [{ box: { x: 1 } }] }, capabilities: [] } });
    const manager = createSensorManager(rpc.client);
    await manager.ensureInitialized();
    const sensor = manager.getSensor('motion-1')!;
    const seen: unknown[] = [];
    watch(
      () => sensor.properties.detections,
      (value) => seen.push(value),
      { flush: 'sync' },
    );

    expect(isReactive(sensor.properties.detections)).toBe(false);

    const next = [{ box: { x: 2 } }];
    rpc.emit('sensor.motion-1.subject', { type: 'property:changed', data: { sensorId: 'motion-1', property: 'detections', value: next, timestamp: 1 } });

    expect(seen).toEqual([next]);
    expect(isReactive(sensor.getProperty('detections'))).toBe(false);
    manager.close();
  });
});

describe('live sensor scopes', () => {
  const MOTION_1 = 'sensor.motion-1.subject';
  const MOTION_2 = 'sensor.motion-2.subject';
  const REGISTRY = 'sensors.subject';

  it('subscribe only the sensors of the shown camera', async () => {
    const rpc = fakeRpc();

    const { stop } = inContext(rpc.client, () => useMotionSensor('cam-1'));
    await vi.advanceTimersByTimeAsync(0);

    expect(rpc.subjects()).toEqual([MOTION_1, REGISTRY]);
    stop();
  });

  it('keep every sensor live for useAllSensors and direct manager users', async () => {
    const rpc = fakeRpc();

    const all = inContext(rpc.client, () => useAllSensors());
    await vi.advanceTimersByTimeAsync(0);
    expect(rpc.subjects()).toEqual([MOTION_1, MOTION_2, REGISTRY]);
    all.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(rpc.active()).toBe(0);

    const camera = inContext(rpc.client, () => useMotionSensor('cam-1'));
    const cached = acquireSensorManager(rpc.client);
    await cached.manager.ensureInitialized();
    await vi.advanceTimersByTimeAsync(0);
    expect(rpc.subjects()).toEqual([MOTION_1, MOTION_2, REGISTRY]);

    releaseSensorManager();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(rpc.subjects()).toEqual([MOTION_1, REGISTRY]);
    camera.stop();
  });

  it('move the live subscription with the camera after the release delay', async () => {
    const rpc = fakeRpc();
    const camera = ref('cam-1');

    const { stop } = inContext(rpc.client, () => useMotionSensor(camera));
    await vi.advanceTimersByTimeAsync(0);
    camera.value = 'cam-2';
    await vi.advanceTimersByTimeAsync(0);

    expect(rpc.subjects()).toEqual([MOTION_1, MOTION_2, REGISTRY]);
    expect(rpc.getSensorStates).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(rpc.subjects()).toEqual([MOTION_2, REGISTRY]);
    stop();
  });

  it('refresh a sensor that goes live without overwriting newer events', async () => {
    const rpc = fakeRpc();

    const first = inContext(rpc.client, () => useMotionSensor('cam-1'));
    await vi.advanceTimersByTimeAsync(0);
    const snapshot = deferred<Record<string, unknown>>();
    rpc.getSensorStates.mockReturnValueOnce(snapshot.promise);
    const second = inContext(rpc.client, () => useMotionSensor('cam-2'));
    await vi.advanceTimersByTimeAsync(0);

    rpc.emit(MOTION_2, { type: 'property:changed', data: { sensorId: 'motion-2', property: 'detected', value: true, timestamp: 2 } });
    snapshot.resolve({
      'motion-2': { type: SensorType.Motion, properties: { detected: false, detections: [{ label: 'motion' }] }, capabilities: ['zones'], displayName: 'Yard' },
    });
    await vi.advanceTimersByTimeAsync(0);

    const sensor = second.result.sensor.value!;
    expect({ ...sensor.properties }).toEqual({ detected: true, detections: [{ label: 'motion' }] });
    expect(sensor.displayName.value).toBe('Yard');
    expect(sensor.capabilities.value).toEqual(['zones']);
    first.stop();
    second.stop();
  });

  it('keep name and capability events that are newer than the snapshot', async () => {
    const rpc = fakeRpc();

    const first = inContext(rpc.client, () => useMotionSensor('cam-1'));
    await vi.advanceTimersByTimeAsync(0);
    const snapshot = deferred<Record<string, unknown>>();
    rpc.getSensorStates.mockReturnValueOnce(snapshot.promise);
    const second = inContext(rpc.client, () => useMotionSensor('cam-2'));
    await vi.advanceTimersByTimeAsync(0);

    rpc.emit(MOTION_2, { type: 'sensor:displayName:changed', data: { sensorId: 'motion-2', displayName: 'New' } });
    rpc.emit(MOTION_2, { type: 'sensor:capabilities:changed', data: { sensorId: 'motion-2', capabilities: ['b'] } });
    snapshot.resolve({ 'motion-2': { type: SensorType.Motion, properties: {}, capabilities: ['a'], displayName: 'Old' } });
    await vi.advanceTimersByTimeAsync(0);

    const sensor = second.result.sensor.value!;
    expect(sensor.displayName.value).toBe('New');
    expect(sensor.capabilities.value).toEqual(['b']);
    first.stop();
    second.stop();
  });

  it('follow the property specs and keep a spec event that is newer than the snapshot', async () => {
    const rpc = fakeRpc();

    const first = inContext(rpc.client, () => useMotionSensor('cam-1'));
    await vi.advanceTimersByTimeAsync(0);
    expect(first.result.sensor.value!.propertySpecs.value).toEqual({});
    const snapshot = deferred<Record<string, unknown>>();
    rpc.getSensorStates.mockReturnValueOnce(snapshot.promise);
    const second = inContext(rpc.client, () => useMotionSensor('cam-2'));
    await vi.advanceTimersByTimeAsync(0);

    const narrowed = { level: { type: 'number', min: 0, max: 50, step: 5 } };
    rpc.emit(REGISTRY, { type: 'sensor:specs:changed', data: { sensorId: 'motion-2', sensorType: SensorType.Motion, propertySpecs: narrowed } });
    snapshot.resolve({ 'motion-2': { type: SensorType.Motion, properties: {}, capabilities: [], propertySpecs: {} } });
    await vi.advanceTimersByTimeAsync(0);

    expect(second.result.sensor.value!.propertySpecs.value).toEqual(narrowed);
    first.stop();
    second.stop();
  });

  it('check a write against the property specs before it goes to the plugin', async () => {
    const rpc = fakeRpc();
    const { result, stop } = inContext(rpc.client, () => useMotionSensor('cam-1'));
    await vi.advanceTimersByTimeAsync(0);
    rpc.emit(REGISTRY, {
      type: 'sensor:specs:changed',
      data: { sensorId: 'motion-1', sensorType: SensorType.Motion, propertySpecs: { level: { type: 'number', min: 0, max: 50, step: 5 } } },
    });

    const sensor = result.sensor.value!;
    await expect(sensor.setProperty('level', 60)).rejects.toThrow(/at most 50/);
    await sensor.setProperty('level', 12);
    expect(rpc.updateValue.mock.calls).toEqual([['level', 10]]);
    stop();
  });

  it('show a write at once and keep it until the device reports it', async () => {
    const rpc = fakeRpc();
    rpc.seed('motion-1', { level: 10 });
    const { result, stop } = inContext(rpc.client, () => useMotionSensor('cam-1'));
    await vi.advanceTimersByTimeAsync(0);
    const answer = deferred<void>();
    rpc.updateValue.mockReturnValueOnce(answer.promise);

    const sensor = result.sensor.value!;
    const write = sensor.setProperty('level', 40);
    expect(sensor.getProperty('level')).toBe(40);
    expect(sensor.isPending('level')).toBe(true);
    answer.resolve();
    await write;
    expect(sensor.isPending()).toBe(true);

    rpc.write('motion-1', 'level', 40);
    await flush();
    expect(sensor.isPending()).toBe(false);
    expect(sensor.getProperty('level')).toBe(40);
    stop();
  });

  it('fall back to the reported value when a write fails or the device ignores it', async () => {
    const rpc = fakeRpc();
    rpc.seed('motion-1', { level: 10 });
    const { result, stop } = inContext(rpc.client, () => useMotionSensor('cam-1'));
    await vi.advanceTimersByTimeAsync(0);
    const sensor = result.sensor.value!;

    rpc.updateValue.mockRejectedValueOnce(new Error('offline'));
    await expect(sensor.setProperty('level', 40)).rejects.toThrow('offline');
    expect(sensor.getProperty('level')).toBe(10);
    expect(sensor.isPending('level')).toBe(false);

    await sensor.setProperty('level', 50);
    expect(sensor.getProperty('level')).toBe(50);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sensor.getProperty('level')).toBe(10);
    expect(sensor.isPending('level')).toBe(false);
    stop();
  });

  it('tell why a held value fell back, and stay quiet when the device confirms or a newer write takes over', async () => {
    const rpc = fakeRpc();
    rpc.seed('motion-1', { level: 10 });
    const { result, stop } = inContext(rpc.client, () => useMotionSensor('cam-1'));
    await vi.advanceTimersByTimeAsync(0);
    const sensor = result.sensor.value!;
    const fallbacks: [string, string][] = [];
    const unsubscribe = sensor.onWriteFallback((property, reason) => fallbacks.push([property, reason]));

    rpc.updateValue.mockRejectedValueOnce(new Error('refused'));
    await expect(sensor.setProperty('level', 40)).rejects.toThrow('refused');
    await sensor.setProperty('level', 50);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fallbacks).toEqual([
      ['level', 'failed'],
      ['level', 'unconfirmed'],
    ]);

    await sensor.setProperty('level', 20);
    rpc.write('motion-1', 'level', 20);
    await flush();
    const first = sensor.setProperty('level', 30);
    const second = sensor.setProperty('level', 35);
    await Promise.all([first, second]);
    rpc.write('motion-1', 'level', 35);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fallbacks).toHaveLength(2);

    unsubscribe();
    rpc.updateValue.mockRejectedValueOnce(new Error('refused'));
    await expect(sensor.setProperty('level', 45)).rejects.toThrow('refused');
    expect(fallbacks).toHaveLength(2);
    stop();
  });

  it('count a value the device reports and drops back at once as taken', async () => {
    const rpc = fakeRpc();
    rpc.seed('motion-1', { level: 10 });
    const { result, stop } = inContext(rpc.client, () => useMotionSensor('cam-1'));
    await vi.advanceTimersByTimeAsync(0);
    const sensor = result.sensor.value!;
    const fallbacks: string[] = [];
    sensor.onWriteFallback((_property, reason) => fallbacks.push(reason));

    await sensor.setProperty('level', 40);
    rpc.write('motion-1', 'level', 40);
    rpc.write('motion-1', 'level', 10);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fallbacks).toEqual([]);
    expect(sensor.getProperty('level')).toBe(10);
    stop();
  });

  it('drop a value on its way without a fallback when the sensor goes offline', async () => {
    const rpc = fakeRpc();
    rpc.seed('motion-1', { level: 10 });
    const { result, stop } = inContext(rpc.client, () => useMotionSensor('cam-1'));
    await vi.advanceTimersByTimeAsync(0);
    const sensor = result.sensor.value!;
    const fallbacks: string[] = [];
    sensor.onWriteFallback((_property, reason) => fallbacks.push(reason));

    await sensor.setProperty('level', 40);
    expect(sensor.getProperty('level')).toBe(40);
    rpc.emit('sensors.subject', { type: 'sensor:source:changed', data: { sensorId: 'motion-1', sourceState: 'unavailable' } });
    await flush();
    expect(sensor.isPending()).toBe(false);
    expect(sensor.getProperty('level')).toBe(10);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fallbacks).toEqual([]);
    stop();
  });

  it('refuse a write to a sensor that is not connected', async () => {
    const rpc = fakeRpc();
    rpc.seed('motion-1', { level: 10 });
    const { result, stop } = inContext(rpc.client, () => useMotionSensor('cam-1'));
    await vi.advanceTimersByTimeAsync(0);
    const sensor = result.sensor.value!;

    rpc.setConnected('motion-1', false);
    await flush();
    await expect(sensor.setProperty('level', 40)).rejects.toThrow('not connected');
    expect(rpc.updateValue).not.toHaveBeenCalled();
    expect(sensor.getProperty('level')).toBe(10);
    stop();
  });

  it('go offline and refuse a write while the device or camera is unreachable', async () => {
    const rpc = fakeRpc();
    rpc.seed('motion-1', { level: 10 });
    const { result, stop } = inContext(rpc.client, () => useMotionSensor('cam-1'));
    await vi.advanceTimersByTimeAsync(0);
    const sensor = result.sensor.value!;
    expect(sensor.online.value).toBe(true);

    rpc.emit('sensors.subject', { type: 'sensor:source:changed', data: { sensorId: 'motion-1', sourceState: 'unavailable' } });
    await flush();
    expect(sensor.connected.value).toBe(true);
    expect(sensor.online.value).toBe(false);
    await expect(sensor.setProperty('level', 40)).rejects.toThrow('not reachable');
    expect(rpc.updateValue).not.toHaveBeenCalled();

    rpc.emit('sensors.subject', { type: 'sensor:source:changed', data: { sensorId: 'motion-1' } });
    await flush();
    expect(sensor.online.value).toBe(true);
    stop();
  });

  it('send a command once and show no value in its place', async () => {
    const rpc = fakeRpc([{ id: 'tv-1', type: SensorType.MediaPlayer, name: 'TV', pluginId: 'p', assignedCameraIds: ['cam-1'], exposed: true, connected: true }]);
    const { result, stop } = inContext(rpc.client, () => useSensorById('cam-1', 'tv-1'));
    await vi.advanceTimersByTimeAsync(0);
    const tv = result.sensor.value!;

    const answer = deferred<void>();
    rpc.updateValue.mockReturnValueOnce(answer.promise);
    const sent = tv.setProperty('command', 'next');
    expect(tv.isPending()).toBe(false);
    answer.resolve();
    await sent;

    rpc.updateValue.mockRejectedValueOnce(new Error('Not connected'));
    await expect(tv.setProperty('command', 'next')).rejects.toThrow('Not connected');
    expect(rpc.updateValue).toHaveBeenCalledTimes(2);
    stop();
  });

  it('send a cover stop as a command, the device never reports it back', async () => {
    const rpc = fakeRpc([{ id: 'blind-1', type: SensorType.Cover, name: 'Blind', pluginId: 'p', assignedCameraIds: ['cam-1'], exposed: true, connected: true }]);
    const { result, stop } = inContext(rpc.client, () => useSensorById('cam-1', 'blind-1'));
    await vi.advanceTimersByTimeAsync(0);
    const blind = result.sensor.value!;
    const fallbacks: string[] = [];
    blind.onWriteFallback((_property, reason) => fallbacks.push(reason));

    await blind.setProperty('stop', true);
    expect(blind.isPending()).toBe(false);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fallbacks).toEqual([]);
    stop();
  });

  it('let a newer write take over from one still on its way', async () => {
    const rpc = fakeRpc();
    rpc.seed('motion-1', { level: 10 });
    const { result, stop } = inContext(rpc.client, () => useMotionSensor('cam-1'));
    await vi.advanceTimersByTimeAsync(0);
    const first = deferred<void>();
    rpc.updateValue.mockReturnValueOnce(first.promise);
    const sensor = result.sensor.value!;

    const slow = sensor.setProperty('level', 30);
    await sensor.setProperty('level', 60);
    first.resolve();
    await slow;
    expect(sensor.getProperty('level')).toBe(60);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sensor.getProperty('level')).toBe(10);
    stop();
  });

  it('ignore a snapshot that belongs to an earlier subscription', async () => {
    const rpc = fakeRpc();
    const camera = ref('cam-1');

    const { result, stop } = inContext(rpc.client, () => useMotionSensor(camera));
    await vi.advanceTimersByTimeAsync(0);
    const late = deferred<Record<string, unknown>>();
    rpc.getSensorStates.mockReturnValueOnce(late.promise);
    camera.value = 'cam-2';
    await vi.advanceTimersByTimeAsync(0);
    camera.value = 'cam-1';
    await vi.advanceTimersByTimeAsync(1_000);
    rpc.write('motion-2', 'detected', false);
    camera.value = 'cam-2';
    await vi.advanceTimersByTimeAsync(0);

    late.resolve({ 'motion-2': { type: SensorType.Motion, properties: { detected: true }, capabilities: [] } });
    await vi.advanceTimersByTimeAsync(0);

    expect(result.sensor.value?.properties.detected).toBe(false);
    stop();
  });

  it('never show values from before the camera was released', async () => {
    const rpc = fakeRpc();
    const camera = ref('cam-2');
    // another view keeps the shared manager alive
    const other = inContext(rpc.client, () => useMotionSensor('cam-1'));
    const { result, stop } = inContext(rpc.client, () => useMotionSensor(camera));
    await vi.advanceTimersByTimeAsync(0);
    const seen: unknown[] = [];
    watch(
      () => result.sensor.value?.properties.detections,
      (detections) => seen.push(detections),
      { deep: true, flush: 'sync' },
    );

    rpc.write('motion-2', 'detections', [{ label: 'person' }]);
    camera.value = 'cam-1';
    await vi.advanceTimersByTimeAsync(1_000);
    rpc.write('motion-2', 'detections', []);

    const snapshot = deferred<Record<string, unknown>>();
    rpc.getSensorStates.mockReturnValueOnce(snapshot.promise);
    seen.length = 0;
    camera.value = 'cam-2';
    await vi.advanceTimersByTimeAsync(0);
    expect(result.sensor.value?.id).toBe('motion-2');
    expect(seen).not.toContainEqual([{ label: 'person' }]);

    snapshot.resolve(rpc.states());
    await vi.advanceTimersByTimeAsync(0);
    expect(result.sensor.value?.properties.detections).toEqual([]);
    expect(seen).not.toContainEqual([{ label: 'person' }]);
    stop();
    other.stop();
  });

  it('bind a view only after the snapshot of its camera', async () => {
    const rpc = fakeRpc();
    const other = inContext(rpc.client, () => useMotionSensor('cam-1'));
    const first = inContext(rpc.client, () => useMotionSensor('cam-2'));
    await vi.advanceTimersByTimeAsync(0);
    rpc.write('motion-2', 'detected', true);
    first.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    rpc.write('motion-2', 'detected', false);

    const snapshot = deferred<Record<string, unknown>>();
    rpc.getSensorStates.mockReturnValueOnce(snapshot.promise);
    const second = inContext(rpc.client, () => useMotionSensor('cam-2'));
    await vi.advanceTimersByTimeAsync(0);
    expect(second.result.isLoading.value).toBe(true);
    expect(second.result.sensor.value).toBeUndefined();

    snapshot.resolve(rpc.states());
    await vi.advanceTimersByTimeAsync(0);
    expect(second.result.isLoading.value).toBe(false);
    expect(second.result.sensor.value?.properties.detected).toBe(false);
    second.stop();
    other.stop();
  });

  it('retry a refresh that failed', async () => {
    const rpc = fakeRpc();
    const camera = ref('cam-1');

    const { result, stop } = inContext(rpc.client, () => useMotionSensor(camera));
    await vi.advanceTimersByTimeAsync(0);
    rpc.write('motion-2', 'detected', true);
    rpc.getSensorStates.mockRejectedValueOnce(new Error('boom'));
    camera.value = 'cam-2';
    await vi.advanceTimersByTimeAsync(0);
    expect(result.sensor.value?.id).toBe('motion-2');
    expect(result.sensor.value?.properties.detected).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(result.sensor.value?.properties.detected).toBe(true);
    expect(rpc.getSensorStates).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(rpc.getSensorStates).toHaveBeenCalledTimes(3);
    stop();
  });

  it('refresh a sensor that was offline once its plugin is back', async () => {
    const rpc = fakeRpc();
    const camera = ref('cam-1');

    const { result, stop } = inContext(rpc.client, () => useMotionSensor(camera));
    await vi.advanceTimersByTimeAsync(0);
    rpc.write('motion-2', 'detected', true);
    // the registry dropped the sensor before its connected event reached the client
    rpc.offline.add('motion-2');
    camera.value = 'cam-2';
    await vi.advanceTimersByTimeAsync(0);
    expect(result.sensor.value?.properties.detected).toBeUndefined();
    expect(rpc.getSensorStates).toHaveBeenCalledTimes(2);

    rpc.setConnected('motion-2', false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(rpc.getSensorStates).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(rpc.getSensorStates).toHaveBeenCalledTimes(3);

    rpc.setConnected('motion-2', true, { detected: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(result.sensor.value?.properties.detected).toBe(false);
    expect(rpc.getSensorStates).toHaveBeenCalledTimes(4);
    stop();
  });

  it('load a multi-camera view with one state call', async () => {
    const cameras = Array.from({ length: 10 }, (_, c) => `cam-${c}`);
    const sensors = cameras.flatMap((cameraId) =>
      [0, 1, 2].map((k) => ({ ...SENSORS[0], id: `${cameraId}-${k}`, name: `${cameraId}-${k}`, assignedCameraIds: [cameraId] })),
    );
    const rpc = fakeRpc(sensors);

    const single = inContext(rpc.client, () => useSensors('cam-0'));
    await vi.advanceTimersByTimeAsync(0);
    single.stop();
    const grid = cameras.map((cameraId) => inContext(rpc.client, () => useSensors(cameraId)));
    await vi.advanceTimersByTimeAsync(0);

    expect(rpc.getSensorStates).toHaveBeenCalledTimes(2);
    expect(rpc.getSensorState).not.toHaveBeenCalled();
    expect(rpc.subjects()).toHaveLength(31);
    expect(grid.every(({ result }) => result.sensors.value.length === 3 && !result.isLoading.value)).toBe(true);
    for (const view of grid) view.stop();
  });

  it('follow sensors that are added or change their camera', async () => {
    const rpc = fakeRpc();

    const { stop } = inContext(rpc.client, () => useMotionSensor('cam-1'));
    await vi.advanceTimersByTimeAsync(0);

    rpc.emit(REGISTRY, { type: 'sensor:assignment:changed', data: { sensorId: 'motion-2', cameraId: 'cam-1', assigned: true } });
    await vi.advanceTimersByTimeAsync(0);
    expect(rpc.subjects()).toEqual([MOTION_1, MOTION_2, REGISTRY]);

    rpc.emit(REGISTRY, { type: 'sensor:assignment:changed', data: { sensorId: 'motion-2', cameraId: 'cam-1', assigned: false } });
    await vi.advanceTimersByTimeAsync(0);
    expect(rpc.subjects()).toEqual([MOTION_1, REGISTRY]);

    function added(id: string, cameraIds: string[]) {
      return {
        type: 'sensor:added',
        data: {
          sensor: { id, type: SensorType.Object, name: id, pluginId: 'p', assignedCameraIds: cameraIds, exposed: true, connected: true },
          state: { type: SensorType.Object, properties: {}, capabilities: [] },
        },
      };
    }
    rpc.emit(REGISTRY, added('object-2', ['cam-2']));
    rpc.emit(REGISTRY, added('object-1', ['cam-1']));
    await vi.advanceTimersByTimeAsync(0);
    expect(rpc.subjects()).toEqual([MOTION_1, 'sensor.object-1.subject', REGISTRY]);
    stop();
  });

  it('keep sensors without a camera live', async () => {
    const rpc = fakeRpc();
    rpc.getSensors.mockResolvedValueOnce([
      ...SENSORS,
      { id: 'switch-1', type: SensorType.Switch, name: 'Switch', pluginId: 'p', assignedCameraIds: [], exposed: true, connected: true },
    ]);

    const { stop } = inContext(rpc.client, () => useMotionSensor('cam-1'));
    await vi.advanceTimersByTimeAsync(0);

    expect(rpc.subjects()).toEqual([MOTION_1, 'sensor.switch-1.subject', REGISTRY]);
    stop();
  });

  it('hold the requested sensor for useSensorById', async () => {
    const rpc = fakeRpc();

    const { result, stop } = inContext(rpc.client, () => useSensorById('cam-1', 'motion-2'));
    await vi.advanceTimersByTimeAsync(0);

    expect(result.sensor.value?.id).toBe('motion-2');
    expect(rpc.subjects()).toEqual([MOTION_2, REGISTRY]);
    stop();
  });

  it('release the camera of a view that ends while another view keeps the manager', async () => {
    const rpc = fakeRpc();

    const one = inContext(rpc.client, () => useMotionSensor('cam-1'));
    const two = inContext(rpc.client, () => useMotionSensor('cam-2'));
    await vi.advanceTimersByTimeAsync(0);
    two.stop();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(rpc.subjects()).toEqual([MOTION_1, REGISTRY]);
    one.stop();
  });

  it('subscribe once when two views make the same sensor live at once', async () => {
    const rpc = fakeRpc();

    const one = inContext(rpc.client, () => useMotionSensor('cam-1'));
    await vi.advanceTimersByTimeAsync(0);
    const unblock = rpc.blockSubscribe(MOTION_2);
    const two = inContext(rpc.client, () => useMotionSensor('cam-2'));
    const three = inContext(rpc.client, () => useSensorById('cam-1', 'motion-2'));
    await vi.advanceTimersByTimeAsync(0);
    unblock();
    await vi.advanceTimersByTimeAsync(0);

    expect(rpc.active()).toBe(3);
    one.stop();
    two.stop();
    three.stop();
  });

  it('undo a sensor subscribe that was in flight across a reconnect', async () => {
    const rpc = fakeRpc();

    const one = inContext(rpc.client, () => useMotionSensor('cam-1'));
    await vi.advanceTimersByTimeAsync(0);
    const unblock = rpc.blockSubscribe(MOTION_2);
    const two = inContext(rpc.client, () => useMotionSensor('cam-2'));
    await vi.advanceTimersByTimeAsync(0);
    reconnectAllSensorManagers();
    await vi.advanceTimersByTimeAsync(0);
    unblock();
    await vi.advanceTimersByTimeAsync(0);

    expect(rpc.active()).toBe(3);
    one.stop();
    two.stop();
  });

  it('undo a sensor subscribe that was in flight when the cache was cleared', async () => {
    const rpc = fakeRpc();

    const one = inContext(rpc.client, () => useMotionSensor('cam-1'));
    await vi.advanceTimersByTimeAsync(0);
    const unblock = rpc.blockSubscribe(MOTION_2);
    const two = inContext(rpc.client, () => useMotionSensor('cam-2'));
    await vi.advanceTimersByTimeAsync(0);
    clearSensorCache();
    unblock();
    await vi.advanceTimersByTimeAsync(0);

    expect(rpc.active()).toBe(0);
    one.stop();
    two.stop();
  });

  it('follow the sensor across a reconnect', async () => {
    const rpc = fakeRpc();

    const { result, stop } = inContext(rpc.client, () => ({
      byId: useSensorById('cam-1', 'motion-1'),
      byType: useSensorByType('cam-1', SensorType.Motion),
      typed: useMotionSensor('cam-1'),
    }));
    await vi.advanceTimersByTimeAsync(0);
    reconnectAllSensorManagers();
    await vi.advanceTimersByTimeAsync(0);
    rpc.write('motion-1', 'detected', true);

    expect(result.byId.sensor.value?.properties.detected).toBe(true);
    expect(result.byType.sensor.value?.properties.detected).toBe(true);
    expect(result.typed.sensor.value?.properties.detected).toBe(true);
    stop();
  });

  it('keep the sensor objects and the list across a reconnect', async () => {
    const rpc = fakeRpc();

    const { result, stop } = inContext(rpc.client, () => ({ byId: useSensorById('cam-1', 'motion-1'), all: useAllSensors() }));
    await vi.advanceTimersByTimeAsync(0);
    const held = result.byId.sensor.value!;
    const sizes: number[] = [];
    watch(result.all.sensors, (list) => sizes.push(list.length), { flush: 'sync' });

    reconnectAllSensorManagers();
    await vi.advanceTimersByTimeAsync(0);
    rpc.write('motion-1', 'detected', true);

    expect(result.all.sensors.value.find((sensor) => sensor.id === 'motion-1')).toBe(held);
    expect(result.byId.sensor.value).toBe(held);
    expect(held.properties.detected).toBe(true);
    expect(sizes).not.toContain(0);
    stop();
  });

  it('bring kept sensors up to date and follow sensors that came or went during a reconnect', async () => {
    const sensors = SENSORS.map((sensor) => ({ ...sensor, assignedCameraIds: [...sensor.assignedCameraIds] }));
    const rpc = fakeRpc(sensors);
    const manager = createSensorManager(rpc.client);
    await manager.ensureInitialized();
    const kept = manager.getSensor('motion-1')!;
    const gone = manager.getSensor('motion-2')!;
    rpc.write('motion-1', 'detected', true);

    rpc.seed('motion-1', { detected: false });
    sensors[0] = { ...sensors[0]!, exposed: false, assignedCameraIds: ['cam-1', 'cam-3'] };
    sensors[1] = { ...gone, id: 'motion-3', name: 'Motion 3', assignedCameraIds: ['cam-3'], exposed: true, connected: true } as (typeof SENSORS)[number];
    await manager.reconnect();

    expect(manager.getSensor('motion-1')).toBe(kept);
    expect(kept.properties.detected).toBe(false);
    expect(kept.exposed.value).toBe(false);
    expect(kept.assignedCameraIds.value).toEqual(['cam-1', 'cam-3']);
    expect(manager.getSensor('motion-2')).toBeUndefined();
    expect(manager.getSensor('motion-3')?.name).toBe('Motion 3');
    manager.close();
  });

  it.each([
    ['name', { name: 'Renamed' }],
    ['type', { type: SensorType.Contact }],
  ])('build a new object for a sensor whose %s changed during a reconnect', async (_field, change) => {
    const sensors = SENSORS.map((sensor) => ({ ...sensor, assignedCameraIds: [...sensor.assignedCameraIds] }));
    const rpc = fakeRpc(sensors);
    const manager = createSensorManager(rpc.client);
    await manager.ensureInitialized();
    const before = manager.getSensor('motion-1')!;

    sensors[0] = { ...sensors[0]!, ...change } as (typeof SENSORS)[number];
    await manager.reconnect();

    expect(manager.getSensor('motion-1')).not.toBe(before);
    expect(manager.getSensor('motion-1')).toMatchObject(change);
    manager.close();
  });

  it('drop the properties a kept sensor lost and report its new capabilities after a reconnect', async () => {
    const rpc = fakeRpc();
    rpc.seed('motion-1', { detected: true });
    const manager = createSensorManager(rpc.client);
    await manager.ensureInitialized();
    const kept = manager.getSensor('motion-1')!;
    expect(kept.properties.detected).toBe(true);
    const reported: string[][] = [];
    kept.onCapabilitiesChanged((capabilities) => reported.push([...capabilities]));

    rpc.getSensorStates.mockResolvedValueOnce({
      'motion-1': { type: SensorType.Motion, properties: {}, capabilities: ['zones'] },
      'motion-2': { type: SensorType.Motion, properties: {}, capabilities: [] },
    });
    await manager.reconnect();

    expect(manager.getSensor('motion-1')).toBe(kept);
    expect('detected' in kept.properties).toBe(false);
    expect(kept.capabilities.value).toEqual(['zones']);
    expect(reported).toEqual([['zones']]);
    manager.close();
  });

  it('keep the previous sensors while a reconnect fails and reuse them once it works', async () => {
    const rpc = fakeRpc();
    const manager = createSensorManager(rpc.client);
    await manager.ensureInitialized();
    const before = manager.sensors.value;
    rpc.getSensors.mockRejectedValueOnce(new Error('boom'));

    await expect(manager.reconnect()).rejects.toThrow('boom');
    expect(manager.isInitialized.value).toBe(false);
    expect(manager.sensors.value).toEqual(before);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(manager.isInitialized.value).toBe(true);
    expect(manager.sensors.value).toEqual(before);
    expect(manager.sensors.value[0]).toBe(before[0]);
    manager.close();
  });

  it('restore only the held scopes on reconnect', async () => {
    const rpc = fakeRpc();

    const { stop } = inContext(rpc.client, () => useSensors('cam-1'));
    await vi.advanceTimersByTimeAsync(0);
    reconnectAllSensorManagers();
    await vi.advanceTimersByTimeAsync(0);

    expect(rpc.getSensors).toHaveBeenCalledTimes(2);
    expect(rpc.subjects()).toEqual([MOTION_1, REGISTRY]);
    stop();
  });

  it('drop a subscription that lands after its camera was released', async () => {
    const rpc = fakeRpc();
    const camera = ref('cam-1');

    const { stop } = inContext(rpc.client, () => useMotionSensor(camera));
    await vi.advanceTimersByTimeAsync(0);
    const unblock = rpc.blockSubscribe(MOTION_2);
    camera.value = 'cam-2';
    await vi.advanceTimersByTimeAsync(0);
    camera.value = 'cam-1';
    await vi.advanceTimersByTimeAsync(1_000);

    unblock();
    await vi.advanceTimersByTimeAsync(0);

    expect(rpc.subjects()).toEqual([MOTION_1, REGISTRY]);
    expect(rpc.getSensorStates).toHaveBeenCalledTimes(1);
    stop();
  });
});

describe('sensor composables', () => {
  it('bind once the link is back when they mount during a short drop', async () => {
    const rpc = fakeRpc();
    const link = shallowRef<RPCClient | undefined>();

    const { result, stop } = inContext(link, () => ({ typed: useMotionSensor('cam-1'), byId: useSensorById('cam-1', 'motion-1'), all: useAllSensors() }));
    await vi.advanceTimersByTimeAsync(0);
    expect(result.typed.isLoading.value).toBe(true);

    link.value = rpc.client;
    await vi.advanceTimersByTimeAsync(0);

    expect(result.typed.sensor.value?.id).toBe('motion-1');
    expect(result.byId.sensor.value?.id).toBe('motion-1');
    expect(result.all.sensors.value).toHaveLength(2);
    expect(result.typed.isLoading.value).toBe(false);
    expect(rpc.getSensors).toHaveBeenCalledTimes(1);
    stop();
  });

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
