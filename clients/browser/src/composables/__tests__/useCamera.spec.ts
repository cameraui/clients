import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shallowRef } from 'vue';

import { createReactiveCameraDevice } from '../useCamera.js';
import { markLinkRestored } from '../useRpc.js';

import type { RPCClient } from '@camera.ui/rpc';
import type { Camera } from '@camera.ui/sdk';

const CAMERA = { _id: 'cam-1', name: 'Front', sources: [{ _id: 'src-1', role: 'high-resolution' }] } as unknown as Camera;

function timeout(): Error {
  return Object.assign(new Error('RPC call to "rpc.camera.cam-1.controller.rpc" timed out after 10000ms'), { code: 'TIMEOUT' });
}

// what the rpc lib throws when nobody serves the subject, e.g. a server without the method
function noResponders(): Error {
  return Object.assign(new Error("no responders: 'rpc.camera.cam-1.controller.rpc.snapshotWithMeta'"), { name: 'NoResponders' });
}

function fakeController() {
  const controller = {
    refreshStates: vi.fn(async () => ({ camera: CAMERA, cameraState: true, frameWorkerState: false, sensorStates: {} })),
    probeStream: vi.fn(async (): Promise<unknown> => ({ sdp: 'v=0' })),
    snapshotWithMeta: vi.fn(async (): Promise<unknown> => ({ data: new ArrayBuffer(4), ageMs: 0 })),
    snapshot: vi.fn(async (): Promise<unknown> => new ArrayBuffer(4)),
  };
  const client = {
    isConnected: true,
    isClosed: false,
    subscribe: async () => () => {},
    createProxy: () => controller,
  } as unknown as RPCClient;
  return { client, controller };
}

async function settle<T>(promise: Promise<T>): Promise<{ value?: T; error?: unknown }> {
  const result = promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await vi.runAllTimersAsync();
  return result;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createReactiveCameraDevice timeouts', () => {
  it('retries a timed out cached probe', async () => {
    const { client, controller } = fakeController();
    const device = await createReactiveCameraDevice({ rpc: shallowRef(client) }, CAMERA);
    controller.probeStream.mockRejectedValueOnce(timeout());

    const { value } = await settle(device.probeStream('src-1'));

    expect(value).toEqual({ sdp: 'v=0' });
    expect(controller.probeStream).toHaveBeenCalledTimes(2);
  });

  it('does not retry a timed out probe that forces a refresh', async () => {
    const { client, controller } = fakeController();
    const device = await createReactiveCameraDevice({ rpc: shallowRef(client) }, CAMERA);
    controller.probeStream.mockRejectedValueOnce(timeout());

    const { error } = await settle(device.probeStream('src-1', undefined, true));

    expect((error as { code?: string }).code).toBe('TIMEOUT');
    expect(controller.probeStream).toHaveBeenCalledTimes(1);
  });

  it('retries a timed out cached snapshot', async () => {
    const { client, controller } = fakeController();
    const device = await createReactiveCameraDevice({ rpc: shallowRef(client) }, CAMERA);
    controller.snapshotWithMeta.mockRejectedValueOnce(timeout());

    const { value } = await settle(device.fetchSnapshot('src-1'));

    expect(value?.byteLength).toBe(4);
    expect(controller.snapshotWithMeta).toHaveBeenCalledTimes(2);
    expect(controller.snapshot).not.toHaveBeenCalled();
  });

  it('retries a timed out cached snapshot on the legacy call', async () => {
    const { client, controller } = fakeController();
    const device = await createReactiveCameraDevice({ rpc: shallowRef(client) }, CAMERA);
    controller.snapshotWithMeta.mockRejectedValue(Object.assign(new Error('Method not found'), { code: 'METHOD_NOT_FOUND' }));
    controller.snapshot.mockRejectedValueOnce(timeout());

    const { value } = await settle(device.fetchSnapshot('src-1'));

    expect(value?.byteLength).toBe(4);
    expect(controller.snapshotWithMeta).toHaveBeenCalledTimes(1);
    expect(controller.snapshot).toHaveBeenCalledTimes(2);
  });

  it('does not retry a timed out forced snapshot', async () => {
    const { client, controller } = fakeController();
    const device = await createReactiveCameraDevice({ rpc: shallowRef(client) }, CAMERA);
    controller.snapshotWithMeta.mockRejectedValue(timeout());
    controller.snapshot.mockRejectedValue(timeout());

    const { error } = await settle(device.fetchSnapshot('src-1', true));

    expect((error as { code?: string }).code).toBe('TIMEOUT');
    expect(controller.snapshotWithMeta).toHaveBeenCalledTimes(1);
    expect(controller.snapshot).toHaveBeenCalledTimes(1);
  });
});

describe('createReactiveCameraDevice snapshot call', () => {
  it('does not fall back to the legacy call when the snapshot times out on a server that answered it', async () => {
    const { client, controller } = fakeController();
    const device = await createReactiveCameraDevice({ rpc: shallowRef(client) }, CAMERA);
    await settle(device.fetchSnapshot('src-1'));
    controller.snapshotWithMeta.mockRejectedValue(timeout());

    const { error } = await settle(device.fetchSnapshot('src-1'));

    expect((error as { code?: string }).code).toBe('TIMEOUT');
    expect(controller.snapshotWithMeta).toHaveBeenCalledTimes(5);
    expect(controller.snapshot).not.toHaveBeenCalled();
  });

  it('tries the legacy call once when the snapshot keeps timing out on a server that never answered it', async () => {
    const { client, controller } = fakeController();
    const device = await createReactiveCameraDevice({ rpc: shallowRef(client) }, CAMERA);
    controller.snapshotWithMeta.mockRejectedValue(timeout());

    const { value } = await settle(device.fetchSnapshot('src-1'));

    expect(value?.byteLength).toBe(4);
    expect(controller.snapshotWithMeta).toHaveBeenCalledTimes(4);
    expect(controller.snapshot).toHaveBeenCalledTimes(1);
  });

  it('keeps asking the new method after a timeout sent it to the legacy call', async () => {
    const { client, controller } = fakeController();
    const device = await createReactiveCameraDevice({ rpc: shallowRef(client) }, CAMERA);
    controller.snapshotWithMeta.mockRejectedValueOnce(timeout()).mockRejectedValueOnce(timeout()).mockRejectedValueOnce(timeout()).mockRejectedValueOnce(timeout());
    await settle(device.fetchSnapshot('src-1'));

    await settle(device.fetchSnapshot('src-1'));

    expect(controller.snapshotWithMeta).toHaveBeenCalledTimes(5);
    expect(controller.snapshot).toHaveBeenCalledTimes(1);
  });

  it('keeps the new method for the other cameras when one has no responder right after a reconnect', async () => {
    const { client, controller } = fakeController();
    const rpc = shallowRef<RPCClient | undefined>(client);
    const front = await createReactiveCameraDevice({ rpc }, CAMERA);
    const back = await createReactiveCameraDevice({ rpc }, { ...CAMERA, _id: 'cam-2' } as Camera);
    markLinkRestored(rpc);
    controller.snapshotWithMeta.mockRejectedValueOnce(noResponders());

    expect((await settle(front.fetchSnapshot('src-1'))).value?.byteLength).toBe(4);
    expect((await settle(back.fetchSnapshot('src-1'))).value?.byteLength).toBe(4);

    expect(controller.snapshotWithMeta).toHaveBeenCalledTimes(2);
    expect(controller.snapshot).toHaveBeenCalledTimes(1);
  });

  it('uses the legacy call on a server without the method and stays with it', async () => {
    const { client, controller } = fakeController();
    const device = await createReactiveCameraDevice({ rpc: shallowRef(client) }, CAMERA);
    controller.snapshotWithMeta.mockRejectedValue(noResponders());

    expect((await settle(device.fetchSnapshot('src-1'))).value?.byteLength).toBe(4);
    expect((await settle(device.fetchSnapshot('src-1'))).value?.byteLength).toBe(4);

    expect(controller.snapshotWithMeta).toHaveBeenCalledTimes(1);
    expect(controller.snapshot).toHaveBeenCalledTimes(2);
  });

  it('does not fall back on missing responders once the server answered the method', async () => {
    const { client, controller } = fakeController();
    const device = await createReactiveCameraDevice({ rpc: shallowRef(client) }, CAMERA);
    await settle(device.fetchSnapshot('src-1'));
    controller.snapshotWithMeta.mockRejectedValue(noResponders());

    const { error } = await settle(device.fetchSnapshot('src-1'));

    expect((error as Error).name).toBe('NoResponders');
    expect(controller.snapshot).not.toHaveBeenCalled();
  });

  it('asks the new method again on a new client', async () => {
    const { client, controller } = fakeController();
    const rpc = shallowRef(client);
    const device = await createReactiveCameraDevice({ rpc }, CAMERA);
    controller.snapshotWithMeta.mockRejectedValueOnce(noResponders());
    await settle(device.fetchSnapshot('src-1'));

    rpc.value = { ...client } as RPCClient;
    await settle(device.fetchSnapshot('src-1'));

    expect(controller.snapshotWithMeta).toHaveBeenCalledTimes(2);
    expect(controller.snapshot).toHaveBeenCalledTimes(1);
  });
});

describe('createReactiveCameraDevice reconnect', () => {
  function subscribeCounter(client: RPCClient) {
    const active = new Set<() => void>();
    (client as unknown as { subscribe: unknown }).subscribe = async () => {
      const off = (): void => {
        active.delete(off);
      };
      active.add(off);
      return off;
    };
    return active;
  }

  it('keeps retrying a failed reconnect until the camera state is back', async () => {
    const { client, controller } = fakeController();
    const device = await createReactiveCameraDevice({ rpc: shallowRef(client) }, CAMERA);
    controller.refreshStates.mockRejectedValueOnce(new Error('boom')).mockRejectedValueOnce(new Error('boom'));
    controller.refreshStates.mockResolvedValueOnce({ camera: CAMERA, cameraState: false, frameWorkerState: false, sensorStates: {} });

    const { error } = await settle(device.reconnect());

    expect((error as Error).message).toBe('boom');
    expect(controller.refreshStates).toHaveBeenCalledTimes(4);
    expect(device.connected.value).toBe(false);
  });

  it('backs off between reconnect attempts up to 30 s', async () => {
    const { client, controller } = fakeController();
    const device = await createReactiveCameraDevice({ rpc: shallowRef(client) }, CAMERA);
    controller.refreshStates.mockRejectedValue(new Error('boom'));

    device.reconnect().catch(() => {});
    const calls: number[] = [];
    for (let s = 0; s < 120; s++) {
      await vi.advanceTimersByTimeAsync(1_000);
      calls.push(controller.refreshStates.mock.calls.length);
    }

    // initial load and first attempt, then retries after 1, 2, 4, 8, 16, 30, 30 and 30 s
    expect(calls[0]).toBe(3);
    expect(calls[119]! - calls[59]!).toBe(2);
    device.close();
  });

  it('runs one reconnect at a time and subscribes once more for calls that came in meanwhile', async () => {
    const { client, controller } = fakeController();
    const active = subscribeCounter(client);
    const device = await createReactiveCameraDevice({ rpc: shallowRef(client) }, CAMERA);

    const runs = [device.reconnect(), device.reconnect(), device.reconnect()];
    await settle(Promise.all(runs));

    expect(controller.refreshStates).toHaveBeenCalledTimes(3);
    expect(active.size).toBe(2);
  });

  it('stops retrying and leaves no subscriptions once closed', async () => {
    const { client, controller } = fakeController();
    const active = subscribeCounter(client);
    const device = await createReactiveCameraDevice({ rpc: shallowRef(client) }, CAMERA);
    controller.refreshStates.mockRejectedValue(new Error('boom'));

    device.reconnect().catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    await device.close();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(controller.refreshStates).toHaveBeenCalledTimes(2);
    expect(active.size).toBe(0);
  });

  it('makes no call when asked to reconnect after close', async () => {
    const { client, controller } = fakeController();
    const subscribe = vi.fn(async () => () => {});
    (client as unknown as { subscribe: unknown }).subscribe = subscribe;
    const device = await createReactiveCameraDevice({ rpc: shallowRef(client) }, CAMERA);
    await device.close();
    subscribe.mockClear();

    await settle(device.reconnect());

    expect(subscribe).not.toHaveBeenCalled();
    expect(controller.refreshStates).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['camera event', 0],
    ['sensor event', 1],
  ])('drops a %s subscription that lands after close', async (_name, gated) => {
    const { client } = fakeController();
    const active = subscribeCounter(client);
    const device = await createReactiveCameraDevice({ rpc: shallowRef(client) }, CAMERA);
    const subscribe = (client as unknown as { subscribe: () => Promise<() => void> }).subscribe;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let calls = 0;
    (client as unknown as { subscribe: unknown }).subscribe = async () => {
      if (calls++ === gated) await gate;
      return subscribe();
    };

    const run = device.reconnect();
    await vi.advanceTimersByTimeAsync(0);
    await device.close();
    open();
    await settle(run);

    expect(active.size).toBe(0);
  });
});

describe('createReactiveCameraDevice sensor events', () => {
  function busClient() {
    const { client, controller } = fakeController();
    const subs = new Map<string, Set<(msg: unknown) => void>>();
    const subscribed: string[] = [];
    (client as unknown as { subscribe: unknown }).subscribe = async (subject: string, cb: (msg: unknown) => void) => {
      subscribed.push(subject);
      let set = subs.get(subject);
      if (!set) subs.set(subject, (set = new Set()));
      set.add(cb);
      return () => set.delete(cb);
    };
    function publish(subject: string, msg: unknown): void {
      for (const cb of [...(subs.get(subject) ?? [])]) cb(msg);
    }
    function sensorConnected(sensorId: string, extra: Record<string, unknown> = {}): void {
      publish('sensors.subject', { type: 'sensor:connected:changed', data: { sensorId, sensorType: 'motion', connected: true, ...extra } });
    }
    return { client, controller, subscribed, publish, sensorConnected, active: (subject: string) => subs.get(subject)?.size ?? 0 };
  }

  function camera(id: string): Camera {
    return { ...CAMERA, _id: id } as Camera;
  }

  it('shares one sensor event subscription per client', async () => {
    const bus = busClient();
    const devices = await Promise.all(['cam-1', 'cam-2', 'cam-3'].map((id) => createReactiveCameraDevice({ rpc: shallowRef(bus.client) }, camera(id))));
    bus.controller.refreshStates.mockClear();

    bus.sensorConnected('s-1');
    await vi.advanceTimersByTimeAsync(0);

    expect(bus.subscribed.filter((s) => s === 'sensors.subject')).toHaveLength(1);
    expect(bus.active('sensors.subject')).toBe(1);
    expect(bus.controller.refreshStates).toHaveBeenCalledTimes(3);

    await devices[0].close();
    expect(bus.active('sensors.subject')).toBe(1);
    await Promise.all(devices.slice(1).map((d) => d.close()));
    expect(bus.active('sensors.subject')).toBe(0);
  });

  it('subscribes again for a camera that comes after the last one left', async () => {
    const bus = busClient();
    const first = await createReactiveCameraDevice({ rpc: shallowRef(bus.client) }, camera('cam-1'));
    await first.close();

    const second = await createReactiveCameraDevice({ rpc: shallowRef(bus.client) }, camera('cam-2'));
    bus.controller.refreshStates.mockClear();
    bus.sensorConnected('s-1');
    await vi.advanceTimersByTimeAsync(0);

    expect(bus.active('sensors.subject')).toBe(1);
    expect(bus.controller.refreshStates).toHaveBeenCalledTimes(1);
    await second.close();
  });

  it('refreshes once for a burst of sensor reconnects', async () => {
    const bus = busClient();
    const device = await createReactiveCameraDevice({ rpc: shallowRef(bus.client) }, CAMERA);
    bus.controller.refreshStates.mockClear();

    for (let i = 0; i < 40; i++) bus.sensorConnected(`s-${i}`);
    await vi.advanceTimersByTimeAsync(0);

    expect(bus.controller.refreshStates).toHaveBeenCalledTimes(1);
    await device.close();
  });

  it('refreshes once more after the running call for reconnects that came in meanwhile', async () => {
    const bus = busClient();
    const device = await createReactiveCameraDevice({ rpc: shallowRef(bus.client) }, CAMERA);
    let finish!: () => void;
    bus.controller.refreshStates.mockClear();
    bus.controller.refreshStates.mockImplementationOnce(
      () => new Promise((resolve) => (finish = () => resolve({ camera: CAMERA, cameraState: true, frameWorkerState: false, sensorStates: {} }))),
    );

    bus.sensorConnected('s-1');
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 2; i < 20; i++) {
      bus.sensorConnected(`s-${i}`);
      await vi.advanceTimersByTimeAsync(25);
    }
    expect(bus.controller.refreshStates).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(0);

    expect(bus.controller.refreshStates).toHaveBeenCalledTimes(2);
    await device.close();
  });

  it('picks up a sensor state the call before the last reconnect missed', async () => {
    const bus = busClient();
    const device = await createReactiveCameraDevice({ rpc: shallowRef(bus.client) }, CAMERA);
    let finish!: () => void;
    bus.controller.refreshStates.mockImplementationOnce(
      () => new Promise((resolve) => (finish = () => resolve({ camera: CAMERA, cameraState: true, frameWorkerState: false, sensorStates: {} }))),
    );
    bus.controller.refreshStates.mockResolvedValueOnce({
      camera: CAMERA,
      cameraState: true,
      frameWorkerState: false,
      sensorStates: { 's-2': { type: 'motion', properties: {}, capabilities: [] } },
    } as never);

    bus.sensorConnected('s-1');
    await vi.advanceTimersByTimeAsync(0);
    bus.sensorConnected('s-2');
    finish();
    await vi.advanceTimersByTimeAsync(0);

    expect(device.capabilities.value).toEqual(['motion']);
    await device.close();
  });

  it('skips a sensor reconnect whose event names only other cameras', async () => {
    const bus = busClient();
    const device = await createReactiveCameraDevice({ rpc: shallowRef(bus.client) }, CAMERA);
    bus.controller.refreshStates.mockClear();

    bus.sensorConnected('s-1', { assignedCameraIds: ['cam-2'] });
    await vi.advanceTimersByTimeAsync(0);
    expect(bus.controller.refreshStates).not.toHaveBeenCalled();

    bus.sensorConnected('s-2', { assignedCameraIds: ['cam-2', 'cam-1'] });
    await vi.advanceTimersByTimeAsync(0);
    expect(bus.controller.refreshStates).toHaveBeenCalledTimes(1);
    await device.close();
  });

  it('does not refresh again for sensor reconnects a later refresh already covered', async () => {
    const bus = busClient();
    const device = await createReactiveCameraDevice({ rpc: shallowRef(bus.client) }, CAMERA);
    let finish!: () => void;
    bus.controller.refreshStates.mockClear();
    bus.controller.refreshStates.mockImplementationOnce(
      () => new Promise((resolve) => (finish = () => resolve({ camera: CAMERA, cameraState: true, frameWorkerState: false, sensorStates: {} }))),
    );

    bus.sensorConnected('s-1');
    await vi.advanceTimersByTimeAsync(0);
    bus.sensorConnected('s-2');
    await vi.advanceTimersByTimeAsync(0);
    await device.refreshStates();
    finish();
    await vi.advanceTimersByTimeAsync(0);

    expect(bus.controller.refreshStates).toHaveBeenCalledTimes(2);
    await device.close();
  });

  it('keeps handing a sensor event to the other cameras when one of them throws', async () => {
    const bus = busClient();
    const devices = await Promise.all(['cam-1', 'cam-2', 'cam-3'].map((id) => createReactiveCameraDevice({ rpc: shallowRef(bus.client) }, camera(id))));
    bus.controller.refreshStates.mockClear();
    let reads = 0;
    const data = {
      sensorId: 's-1',
      sensorType: 'motion',
      connected: true,
      get assignedCameraIds(): string[] | undefined {
        if (reads++ === 0) throw new Error('boom');
        return undefined;
      },
    };

    bus.publish('sensors.subject', { type: 'sensor:connected:changed', data });
    await vi.advanceTimersByTimeAsync(0);

    expect(bus.controller.refreshStates).toHaveBeenCalledTimes(2);
    await Promise.all(devices.map((d) => d.close()));
  });

  it('subscribes again after the shared sensor subscription failed', async () => {
    const bus = busClient();
    const subscribe = (bus.client as unknown as { subscribe: (subject: string, cb: (msg: unknown) => void) => Promise<() => void> }).subscribe;
    let failed = false;
    (bus.client as unknown as { subscribe: unknown }).subscribe = async (subject: string, cb: (msg: unknown) => void) => {
      if (subject === 'sensors.subject' && !failed) {
        failed = true;
        throw new Error('boom');
      }
      return subscribe(subject, cb);
    };

    await expect(createReactiveCameraDevice({ rpc: shallowRef(bus.client) }, CAMERA)).rejects.toThrow('boom');
    const device = await createReactiveCameraDevice({ rpc: shallowRef(bus.client) }, CAMERA);
    bus.controller.refreshStates.mockClear();
    bus.sensorConnected('s-1');
    await vi.advanceTimersByTimeAsync(0);

    expect(bus.active('sensors.subject')).toBe(1);
    expect(bus.controller.refreshStates).toHaveBeenCalledTimes(1);
    await device.close();
  });
});

describe('createReactiveCameraDevice state refresh', () => {
  function state(cameraState: boolean) {
    return { camera: CAMERA, cameraState, frameWorkerState: false, sensorStates: {} };
  }

  it('asks at once after a drop while a call from before it still waits for its lost reply', async () => {
    const { client, controller } = fakeController();
    const rpc = shallowRef<RPCClient | undefined>(client);
    const device = await createReactiveCameraDevice({ rpc }, CAMERA);
    controller.refreshStates.mockClear();
    controller.refreshStates.mockImplementationOnce(() => new Promise((_resolve, reject) => setTimeout(() => reject(timeout()), 10_000)));
    controller.refreshStates.mockResolvedValueOnce(state(false));

    device.refreshStates().catch(() => {});
    await vi.advanceTimersByTimeAsync(100);
    rpc.value = undefined;
    rpc.value = client;
    device.refreshStates();
    await vi.advanceTimersByTimeAsync(100);

    expect(controller.refreshStates).toHaveBeenCalledTimes(2);
    expect(device.connected.value).toBe(false);
    await vi.runAllTimersAsync();
    expect(device.connected.value).toBe(false);
    await device.close();
  });

  it('keeps the answer of a later call over an older one that lands after it', async () => {
    const { client, controller } = fakeController();
    const device = await createReactiveCameraDevice({ rpc: shallowRef(client) }, CAMERA);
    let finish!: () => void;
    controller.refreshStates.mockClear();
    controller.refreshStates.mockImplementationOnce(() => new Promise((resolve) => (finish = () => resolve(state(true)))));
    controller.refreshStates.mockResolvedValueOnce(state(false));

    const first = device.refreshStates();
    await device.refreshStates();
    finish();
    await first;

    expect(controller.refreshStates).toHaveBeenCalledTimes(2);
    expect(device.connected.value).toBe(false);
    await device.close();
  });
});
