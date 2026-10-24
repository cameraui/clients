import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, effectScope, ref, shallowRef } from 'vue';

import { CAMERA_UI_INJECTION_KEY } from '../../plugin.js';
import { createReactiveCameraDevice } from '../useCamera.js';
import { clearCameraCache } from '../useCameraById.js';
import { clearSnapshotCache, getSnapshot, getSnapshotStamp, getSnapshotTimestamp, setSnapshot, subscribeSnapshot, useSnapshot } from '../useSnapshot.js';

import type { RPCClient } from '@camera.ui/rpc';
import type { Camera } from '@camera.ui/sdk';
import type { DBCamera } from '../../server/index.js';
import type { CameraUiContext } from '../../types.js';

type Listener = (msg: unknown) => void;

const { tabVisible } = vi.hoisted(() => ({ tabVisible: new Set<() => void>() }));

vi.mock('../useTabVisibility.js', () => ({
  useTabVisibility: () => ({
    onTabVisible: (cb: () => void) => {
      tabVisible.add(cb);
      return () => tabVisible.delete(cb);
    },
  }),
}));

const CAMERA = { _id: 'cam-1', name: 'Front', sources: [{ _id: 'src-1', role: 'high-resolution' }] } as unknown as Camera;
const CAMERA_SUBJECT = 'camera.cam-1.subscriber';

function jpeg(tag: number): ArrayBuffer {
  return new Uint8Array([0xff, 0xd8, tag]).buffer;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function fakeClient() {
  const listeners = new Map<string, Set<Listener>>();
  const controller = {
    getCamera: vi.fn(async (): Promise<unknown> => CAMERA),
    refreshStates: vi.fn(async () => ({ camera: CAMERA, cameraState: true, frameWorkerState: false, sensorStates: {} })),
    snapshotWithMeta: vi.fn(async (): Promise<unknown> => ({ data: jpeg(1), ageMs: 0 })),
    snapshot: vi.fn(async (): Promise<unknown> => jpeg(1)),
  };
  const flush = vi.fn(async (_timeoutMs?: number): Promise<void> => {});
  const client = {
    isConnected: true,
    isClosed: false,
    async subscribe(subject: string, cb: Listener) {
      let set = listeners.get(subject);
      if (!set) listeners.set(subject, (set = new Set()));
      set.add(cb);
      return () => set.delete(cb);
    },
    createProxy: () => controller,
    flush,
  } as unknown as RPCClient;

  function push(data: ArrayBuffer, fetchedAt: number): void {
    for (const cb of listeners.get(CAMERA_SUBJECT) ?? []) cb({ type: 'snapshot:updated', data: { sourceId: 'src-1', snapshot: data, fetchedAt } });
  }

  function active(): number {
    let n = 0;
    for (const set of listeners.values()) n += set.size;
    return n;
  }

  return { client, controller, flush, push, active };
}

function timeoutError(): Error {
  return Object.assign(new Error('timed out'), { code: 'TIMEOUT' });
}

function timeOut(ms = 10_000): Promise<never> {
  return new Promise((_resolve, reject) => setTimeout(() => reject(timeoutError()), ms));
}

function goDead(lane: ReturnType<typeof fakeClient>): void {
  lane.controller.snapshotWithMeta.mockImplementation(() => timeOut());
  lane.controller.snapshot.mockImplementation(() => timeOut());
  lane.flush.mockImplementation((timeoutMs) => timeOut(timeoutMs));
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

async function timed(fetching: Promise<unknown>): Promise<number> {
  const start = Date.now();
  const done = fetching.then(() => Date.now() - start);
  await vi.runAllTimersAsync();
  return done;
}

function inContext<T>(ctx: Partial<CameraUiContext>, fn: () => T): { result: T; stop: () => void } {
  const app = createApp({});
  app.provide(CAMERA_UI_INJECTION_KEY, { isConnected: ref(true), on: () => {}, off: () => {}, ...ctx } as unknown as CameraUiContext);
  const scope = effectScope();
  const result = app.runWithContext(() => scope.run(fn)!);
  return { result, stop: () => scope.stop() };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  tabVisible.clear();
  clearCameraCache();
  clearSnapshotCache();
  vi.useRealTimers();
});

describe('setSnapshot order', () => {
  it('keeps a push over an older reply that lands after it', async () => {
    const pushed = jpeg(2);
    const notified = vi.fn();
    subscribeSnapshot('cam-1', notified);
    setSnapshot('cam-1', jpeg(1), 1_000, Date.now());
    await vi.advanceTimersByTimeAsync(1_000);
    setSnapshot('cam-1', pushed, 50_000);
    await vi.advanceTimersByTimeAsync(500);

    setSnapshot('cam-1', jpeg(3), 40_000, Date.now() - 3_000);

    expect(getSnapshot('cam-1')).toBe(pushed);
    expect(getSnapshotTimestamp('cam-1')).toBe(50_000);
    expect(notified).toHaveBeenCalledTimes(2);
  });

  it('takes a reply whose image is newer than the push before it', async () => {
    const replied = jpeg(3);
    setSnapshot('cam-1', jpeg(2), 50_000);
    await vi.advanceTimersByTimeAsync(2_000);

    setSnapshot('cam-1', replied, 52_000, Date.now() - 500);

    expect(getSnapshot('cam-1')).toBe(replied);
    expect(getSnapshotTimestamp('cam-1')).toBe(52_000);
  });

  it('takes a fresh reply that lands in the same millisecond as a push', () => {
    const fresh = jpeg(3);
    setSnapshot('cam-1', jpeg(2), 50_000);

    setSnapshot('cam-1', fresh, Date.now(), Date.now());

    expect(getSnapshot('cam-1')).toBe(fresh);
  });

  it.each([
    ['behind', -15 * 60_000],
    ['ahead', 15 * 60_000],
  ])('orders pushes and replies the same with a server clock %s of this one', async (_name, skew) => {
    const fresh = jpeg(3);
    setSnapshot('cam-1', jpeg(1), Date.now(), Date.now());
    await vi.advanceTimersByTimeAsync(100);
    const pushed = jpeg(2);
    setSnapshot('cam-1', pushed, Date.now() + skew);
    expect(getSnapshot('cam-1')).toBe(pushed);

    await vi.advanceTimersByTimeAsync(100);
    setSnapshot('cam-1', fresh, Date.now(), Date.now());

    expect(getSnapshot('cam-1')).toBe(fresh);
  });

  it('keeps a newer reply over an older one that lands later', async () => {
    const newer = jpeg(2);
    await vi.advanceTimersByTimeAsync(1_000);
    setSnapshot('cam-1', newer, Date.now(), Date.now());
    await vi.advanceTimersByTimeAsync(500);

    setSnapshot('cam-1', jpeg(1), Date.now() - 5_000, Date.now() - 5_000);

    expect(getSnapshot('cam-1')).toBe(newer);
  });

  it('takes a push and the replies after it when this clock stepped back', async () => {
    setSnapshot('cam-1', jpeg(1), Date.now(), Date.now());
    vi.setSystemTime(Date.now() - 60 * 60_000);
    const pushed = jpeg(2);
    setSnapshot('cam-1', pushed, 50_000);
    expect(getSnapshot('cam-1')).toBe(pushed);

    await vi.advanceTimersByTimeAsync(100);
    const fresh = jpeg(3);
    setSnapshot('cam-1', fresh, Date.now(), Date.now());

    expect(getSnapshot('cam-1')).toBe(fresh);
  });

  it('keeps the held image over a reply the server took before it, however late the reply lands', async () => {
    const pushed = jpeg(2);
    setSnapshot('cam-1', pushed, 50_000, undefined, { sourceId: 'src-1', fetchedAt: 50_000 });
    await vi.advanceTimersByTimeAsync(1_500);

    // its age was read on the server, the time it sat on a slow link counts as fresh here
    setSnapshot('cam-1', jpeg(1), Date.now() - 900, Date.now() - 900, { sourceId: 'src-1', fetchedAt: 49_100 });

    expect(getSnapshot('cam-1')).toBe(pushed);
  });

  it('takes a reply the server took after the held image, even when this clock puts it before', async () => {
    const replied = jpeg(3);
    setSnapshot('cam-1', jpeg(2), 50_000, undefined, { sourceId: 'src-1', fetchedAt: 50_000 });
    await vi.advanceTimersByTimeAsync(100);

    setSnapshot('cam-1', replied, Date.now() - 2_000, Date.now() - 2_000, { sourceId: 'src-1', fetchedAt: 50_500 });

    expect(getSnapshot('cam-1')).toBe(replied);
  });

  it('keeps a newer reply over a push the server took before it', () => {
    const replied = jpeg(3);
    const notified = vi.fn();
    subscribeSnapshot('cam-1', notified);
    setSnapshot('cam-1', replied, Date.now(), Date.now(), { sourceId: 'src-1', fetchedAt: 52_000 });

    setSnapshot('cam-1', jpeg(2), 51_000, undefined, { sourceId: 'src-1', fetchedAt: 51_000 });

    expect(getSnapshot('cam-1')).toBe(replied);
    expect(getSnapshotStamp('cam-1', 'src-1')).toBe(52_000);
    expect(notified).toHaveBeenCalledTimes(1);
  });

  it('takes a push the server took after the held image', () => {
    const pushed = jpeg(2);
    setSnapshot('cam-1', jpeg(3), Date.now(), Date.now(), { sourceId: 'src-1', fetchedAt: 52_000 });

    setSnapshot('cam-1', pushed, 52_500, undefined, { sourceId: 'src-1', fetchedAt: 52_500 });

    expect(getSnapshot('cam-1')).toBe(pushed);
    expect(getSnapshotStamp('cam-1', 'src-1')).toBe(52_500);
  });

  it('takes a push when one side has no server stamp', () => {
    const plain = jpeg(2);
    setSnapshot('cam-1', jpeg(3), Date.now(), Date.now(), { sourceId: 'src-1', fetchedAt: 52_000 });
    setSnapshot('cam-1', plain, 51_000);
    expect(getSnapshot('cam-1')).toBe(plain);

    const stamped = jpeg(4);
    setSnapshot('cam-1', jpeg(5), Date.now(), Date.now());
    setSnapshot('cam-1', stamped, 40_000, undefined, { sourceId: 'src-1', fetchedAt: 40_000 });
    expect(getSnapshot('cam-1')).toBe(stamped);
  });

  it('takes a push far older than the held image, the server clock stepped back', () => {
    const pushed = jpeg(2);
    setSnapshot('cam-1', jpeg(3), Date.now(), Date.now(), { sourceId: 'src-1', fetchedAt: 60 * 60_000 });

    setSnapshot('cam-1', pushed, 50_000, undefined, { sourceId: 'src-1', fetchedAt: 50_000 });

    expect(getSnapshot('cam-1')).toBe(pushed);
    expect(getSnapshotStamp('cam-1', 'src-1')).toBe(50_000);
  });

  it('takes a reply far older than the held image, the server clock stepped back', () => {
    const replied = jpeg(2);
    setSnapshot('cam-1', jpeg(3), Date.now(), Date.now(), { sourceId: 'src-1', fetchedAt: 60 * 60_000 });

    setSnapshot('cam-1', replied, Date.now(), Date.now(), { sourceId: 'src-1', fetchedAt: 50_000 });

    expect(getSnapshot('cam-1')).toBe(replied);
    expect(getSnapshotStamp('cam-1', 'src-1')).toBe(50_000);
  });

  it('keeps the held image over a push or reply up to a minute behind it', () => {
    const held = jpeg(3);
    setSnapshot('cam-1', held, Date.now(), Date.now(), { sourceId: 'src-1', fetchedAt: 120_000 });

    setSnapshot('cam-1', jpeg(2), 60_000, undefined, { sourceId: 'src-1', fetchedAt: 60_000 });
    setSnapshot('cam-1', jpeg(4), Date.now(), Date.now(), { sourceId: 'src-1', fetchedAt: 60_000 });

    expect(getSnapshot('cam-1')).toBe(held);
  });

  it('forgets the order with the cache', async () => {
    const older = jpeg(1);
    setSnapshot('cam-1', jpeg(2), 50_000);
    clearSnapshotCache();

    setSnapshot('cam-1', older, 40_000, Date.now() - 10_000);

    expect(getSnapshot('cam-1')).toBe(older);
  });
});

describe('snapshot fetches on the bulk connection', () => {
  it('go over the bulk connection while it is up', async () => {
    const main = fakeClient();
    const bulk = fakeClient();
    const device = await createReactiveCameraDevice({ rpc: shallowRef(main.client), bulkRpc: shallowRef(bulk.client) }, CAMERA);

    await device.fetchSnapshot('src-1');
    await device.fetchSnapshot('src-1', true);

    expect(bulk.controller.snapshotWithMeta).toHaveBeenCalledTimes(2);
    expect(main.controller.snapshotWithMeta).not.toHaveBeenCalled();
    expect(main.controller.refreshStates).toHaveBeenCalledTimes(1);
    expect(bulk.active()).toBe(0);
    await device.close();
  });

  it('go over the main connection while the bulk one is down or missing', async () => {
    const main = fakeClient();
    const bulk = fakeClient();
    const bulkRpc = shallowRef<RPCClient | undefined>();
    const device = await createReactiveCameraDevice({ rpc: shallowRef(main.client), bulkRpc }, CAMERA);
    const older = await createReactiveCameraDevice({ rpc: shallowRef(main.client) }, { ...CAMERA, _id: 'cam-2' } as Camera);

    await device.fetchSnapshot('src-1');
    await older.fetchSnapshot('src-1');
    expect(main.controller.snapshotWithMeta).toHaveBeenCalledTimes(2);

    bulkRpc.value = bulk.client;
    await device.fetchSnapshot('src-1');
    expect(bulk.controller.snapshotWithMeta).toHaveBeenCalledTimes(1);
    expect(main.controller.snapshotWithMeta).toHaveBeenCalledTimes(2);
    await Promise.all([device.close(), older.close()]);
  });

  it('keep a push that overtook a reply with an older image', async () => {
    const main = fakeClient();
    const bulk = fakeClient();
    const device = await createReactiveCameraDevice({ rpc: shallowRef(main.client), bulkRpc: shallowRef(bulk.client) }, CAMERA);
    const reply = deferred<unknown>();
    bulk.controller.snapshotWithMeta.mockReturnValueOnce(reply.promise);
    const pushed = jpeg(2);

    const fetching = device.fetchSnapshot('src-1');
    await vi.advanceTimersByTimeAsync(800);
    main.push(pushed, Date.now());
    await vi.advanceTimersByTimeAsync(400);
    reply.resolve({ data: jpeg(1), ageMs: 5_000 });
    await fetching;

    expect(getSnapshot('cam-1')).toBe(pushed);
    expect(device.snapshot.value).toBe(pushed);
    await device.close();
  });

  it('take a fresh reply that lands after a push', async () => {
    const main = fakeClient();
    const bulk = fakeClient();
    const device = await createReactiveCameraDevice({ rpc: shallowRef(main.client), bulkRpc: shallowRef(bulk.client) }, CAMERA);
    const reply = deferred<unknown>();
    bulk.controller.snapshotWithMeta.mockReturnValueOnce(reply.promise);
    const fresh = jpeg(3);

    const fetching = device.fetchSnapshot('src-1', true);
    await vi.advanceTimersByTimeAsync(800);
    main.push(jpeg(2), Date.now());
    await vi.advanceTimersByTimeAsync(400);
    reply.resolve({ data: fresh, ageMs: 0 });
    await fetching;

    expect(getSnapshot('cam-1')).toBe(fresh);
    await device.close();
  });

  it('keep a newer reply over a push with an older image that lands after it', async () => {
    const main = fakeClient();
    const bulk = fakeClient();
    const device = await createReactiveCameraDevice({ rpc: shallowRef(main.client), bulkRpc: shallowRef(bulk.client) }, CAMERA);
    const fresh = jpeg(3);
    bulk.controller.snapshotWithMeta.mockResolvedValueOnce({ data: fresh, ageMs: 0, fetchedAt: 52_000 });

    await device.fetchSnapshot('src-1', true);
    main.push(jpeg(2), 51_000);

    expect(getSnapshot('cam-1')).toBe(fresh);
    expect(device.snapshot.value).toBe(fresh);
    await device.close();
  });

  it('drop a legacy reply of unknown age when a push came in while it was asked for', async () => {
    const main = fakeClient();
    const bulk = fakeClient();
    const device = await createReactiveCameraDevice({ rpc: shallowRef(main.client), bulkRpc: shallowRef(bulk.client) }, CAMERA);
    bulk.controller.snapshotWithMeta.mockRejectedValue(Object.assign(new Error('Method not found'), { code: 'METHOD_NOT_FOUND' }));
    const reply = deferred<unknown>();
    bulk.controller.snapshot.mockReturnValueOnce(reply.promise);
    const pushed = jpeg(2);

    const fetching = device.fetchSnapshot('src-1');
    await vi.advanceTimersByTimeAsync(100);
    main.push(pushed, Date.now());
    reply.resolve(jpeg(1));
    await fetching;
    expect(getSnapshot('cam-1')).toBe(pushed);

    await vi.advanceTimersByTimeAsync(100);
    const later = jpeg(3);
    bulk.controller.snapshot.mockResolvedValueOnce(later);
    await device.fetchSnapshot('src-1');
    expect(getSnapshot('cam-1')).toBe(later);
    await device.close();
  });

  it('keep the legacy fallback after timeouts on the bulk connection', async () => {
    const main = fakeClient();
    const bulk = fakeClient();
    const device = await createReactiveCameraDevice({ rpc: shallowRef(main.client), bulkRpc: shallowRef(bulk.client) }, CAMERA);
    bulk.controller.snapshotWithMeta.mockRejectedValue(timeoutError());

    const fetching = device.fetchSnapshot('src-1');
    await vi.runAllTimersAsync();
    await fetching;

    expect(bulk.controller.snapshotWithMeta).toHaveBeenCalledTimes(4);
    expect(bulk.controller.snapshot).toHaveBeenCalledTimes(1);
    expect(main.controller.snapshot).not.toHaveBeenCalled();
    await device.close();
  });

  it.each([
    ['cached', undefined],
    ['forced', true],
  ])('finish a %s fetch on the main connection when the bulk one is dead but still up', async (_name, forceNew) => {
    const main = fakeClient();
    const bulk = fakeClient();
    const device = await createReactiveCameraDevice({ rpc: shallowRef(main.client), bulkRpc: shallowRef(bulk.client) }, CAMERA);
    await device.fetchSnapshot('src-1');
    goDead(bulk);
    const fresh = jpeg(4);
    main.controller.snapshotWithMeta.mockResolvedValueOnce({ data: fresh, ageMs: 0 });

    const start = Date.now();
    const took = device.fetchSnapshot('src-1', forceNew).then((data) => ({ data, ms: Date.now() - start }));
    await vi.runAllTimersAsync();

    expect(await took).toEqual({ data: fresh, ms: 12_000 });
    expect(bulk.controller.snapshotWithMeta).toHaveBeenCalledTimes(2);
    expect(bulk.flush).toHaveBeenCalledTimes(1);
    expect(main.controller.snapshotWithMeta).toHaveBeenCalledTimes(1);
    expect(main.controller.snapshotWithMeta).toHaveBeenLastCalledWith('src-1', forceNew);
    expect(getSnapshot('cam-1')).toBe(fresh);
    await device.close();
  });

  it('keep a timed out forced fetch off the main connection while the bulk one answers pings', async () => {
    const main = fakeClient();
    const bulk = fakeClient();
    const device = await createReactiveCameraDevice({ rpc: shallowRef(main.client), bulkRpc: shallowRef(bulk.client) }, CAMERA);
    await device.fetchSnapshot('src-1');
    bulk.controller.snapshotWithMeta.mockImplementation(() => timeOut());

    const failed = expect(device.fetchSnapshot('src-1', true)).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.runAllTimersAsync();
    await failed;

    expect(bulk.flush).toHaveBeenCalledTimes(1);
    expect(main.controller.snapshotWithMeta).not.toHaveBeenCalled();
    expect(main.controller.snapshot).not.toHaveBeenCalled();
    await device.close();
  });

  it('pass an error the server sent over the bulk connection straight through', async () => {
    const main = fakeClient();
    const bulk = fakeClient();
    const device = await createReactiveCameraDevice({ rpc: shallowRef(main.client), bulkRpc: shallowRef(bulk.client) }, CAMERA);
    bulk.controller.snapshotWithMeta.mockRejectedValue(Object.assign(new Error('Source not found'), { code: 'INTERNAL_ERROR' }));

    await expect(device.fetchSnapshot('src-1', true)).rejects.toThrow('Source not found');

    expect(bulk.flush).not.toHaveBeenCalled();
    expect(main.controller.snapshotWithMeta).not.toHaveBeenCalled();
    await device.close();
  });

  it('never probe or repeat a timed out forced fetch without a bulk connection', async () => {
    const main = fakeClient();
    const device = await createReactiveCameraDevice({ rpc: shallowRef(main.client) }, CAMERA);
    await device.fetchSnapshot('src-1');
    main.controller.snapshotWithMeta.mockImplementation(() => timeOut());

    const failed = expect(device.fetchSnapshot('src-1', true)).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.runAllTimersAsync();
    await failed;

    expect(main.flush).not.toHaveBeenCalled();
    expect(main.controller.snapshotWithMeta).toHaveBeenCalledTimes(2);
    await device.close();
  });

  it('run the legacy fallback on the main connection once the bulk one is dead', async () => {
    const main = fakeClient();
    const bulk = fakeClient();
    const device = await createReactiveCameraDevice({ rpc: shallowRef(main.client), bulkRpc: shallowRef(bulk.client) }, CAMERA);
    goDead(bulk);
    main.controller.snapshotWithMeta.mockRejectedValue(timeoutError());
    const legacy = jpeg(5);
    main.controller.snapshot.mockResolvedValueOnce(legacy);

    const fetching = device.fetchSnapshot('src-1');
    await vi.runAllTimersAsync();

    await expect(fetching).resolves.toBe(legacy);
    expect(bulk.controller.snapshotWithMeta).toHaveBeenCalledTimes(1);
    expect(bulk.controller.snapshot).not.toHaveBeenCalled();
    expect(main.controller.snapshot).toHaveBeenCalledTimes(1);
    await device.close();
  });

  it('go straight to the main connection for every camera once one fetch found the bulk one dead', async () => {
    const main = fakeClient();
    const bulk = fakeClient();
    const rpc = shallowRef<RPCClient | undefined>(main.client);
    const bulkRpc = shallowRef<RPCClient | undefined>(bulk.client);
    const devices = await Promise.all(Array.from({ length: 16 }, (_, i) => createReactiveCameraDevice({ rpc, bulkRpc }, { ...CAMERA, _id: `cam-${i + 1}` } as Camera)));
    goDead(bulk);

    const waits: number[] = [];
    for (const device of devices) waits.push(await timed(device.fetchSnapshot('src-1')));

    expect(waits).toEqual([12_000, ...Array<number>(15).fill(0)]);
    expect(bulk.controller.snapshotWithMeta).toHaveBeenCalledTimes(1);
    expect(bulk.flush).toHaveBeenCalledTimes(1);
    expect(main.controller.snapshotWithMeta).toHaveBeenCalledTimes(16);
    await Promise.all(devices.map((device) => device.close()));
  });

  it('share one probe between cameras that time out together on a dead bulk connection', async () => {
    const main = fakeClient();
    const bulk = fakeClient();
    const rpc = shallowRef<RPCClient | undefined>(main.client);
    const bulkRpc = shallowRef<RPCClient | undefined>(bulk.client);
    const devices = await Promise.all(Array.from({ length: 16 }, (_, i) => createReactiveCameraDevice({ rpc, bulkRpc }, { ...CAMERA, _id: `cam-${i + 1}` } as Camera)));
    goDead(bulk);

    const start = Date.now();
    const waits = devices.map((device) => device.fetchSnapshot('src-1').then(() => Date.now() - start));
    await vi.runAllTimersAsync();

    expect(await Promise.all(waits)).toEqual(Array<number>(16).fill(12_000));
    expect(bulk.flush).toHaveBeenCalledTimes(1);
    expect(main.controller.snapshotWithMeta).toHaveBeenCalledTimes(16);
    await Promise.all(devices.map((device) => device.close()));
  });

  it.each([
    ['the same client after a drop', false],
    ['a new client', true],
  ])('go back to the bulk connection once it comes back with %s', async (_name, replaced) => {
    const main = fakeClient();
    const bulk = fakeClient();
    const next = replaced ? fakeClient() : bulk;
    const bulkRpc = shallowRef<RPCClient | undefined>(bulk.client);
    const device = await createReactiveCameraDevice({ rpc: shallowRef(main.client), bulkRpc }, CAMERA);
    goDead(bulk);
    await timed(device.fetchSnapshot('src-1'));

    if (!replaced) bulkRpc.value = undefined;
    const revived = jpeg(6);
    next.controller.snapshotWithMeta.mockImplementation(async () => ({ data: revived, ageMs: 0 }));
    next.flush.mockImplementation(async () => {});
    bulkRpc.value = next.client;

    expect(await timed(device.fetchSnapshot('src-1'))).toBe(0);
    expect(next.controller.snapshotWithMeta).toHaveBeenCalledTimes(replaced ? 1 : 2);
    expect(main.controller.snapshotWithMeta).toHaveBeenCalledTimes(1);
    expect(getSnapshot('cam-1')).toBe(revived);
    await device.close();
  });

  it('keep a bulk client that replaced the dead one while a fetch still waited on it', async () => {
    const main = fakeClient();
    const dead = fakeClient();
    const fresh = fakeClient();
    const bulkRpc = shallowRef<RPCClient | undefined>(dead.client);
    const device = await createReactiveCameraDevice({ rpc: shallowRef(main.client), bulkRpc }, CAMERA);
    goDead(dead);

    const fetching = device.fetchSnapshot('src-1');
    await vi.advanceTimersByTimeAsync(5_000);
    bulkRpc.value = fresh.client;
    await vi.runAllTimersAsync();
    await fetching;
    await device.fetchSnapshot('src-1');

    expect(dead.flush).toHaveBeenCalledTimes(1);
    expect(main.controller.snapshotWithMeta).toHaveBeenCalledTimes(1);
    expect(fresh.controller.snapshotWithMeta).toHaveBeenCalledTimes(1);

    goDead(fresh);
    expect(await timed(device.fetchSnapshot('src-1'))).toBe(12_000);
    expect(await timed(device.fetchSnapshot('src-1'))).toBe(0);
    await device.close();
  });

  it('go back to the bulk connection once a background probe a minute later gets an answer', async () => {
    const main = fakeClient();
    const bulk = fakeClient();
    const device = await createReactiveCameraDevice({ rpc: shallowRef(main.client), bulkRpc: shallowRef(bulk.client) }, CAMERA);
    goDead(bulk);
    expect(await timed(device.fetchSnapshot('src-1'))).toBe(12_000);
    const revived = jpeg(6);
    bulk.controller.snapshotWithMeta.mockImplementation(async () => ({ data: revived, ageMs: 0 }));
    bulk.flush.mockImplementation(async () => {});

    await vi.advanceTimersByTimeAsync(59_000);
    expect(await timed(device.fetchSnapshot('src-1'))).toBe(0);
    expect(bulk.flush).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(await timed(device.fetchSnapshot('src-1'))).toBe(0);
    expect(bulk.flush).toHaveBeenCalledTimes(2);
    expect(bulk.controller.snapshotWithMeta).toHaveBeenCalledTimes(1);
    expect(main.controller.snapshotWithMeta).toHaveBeenCalledTimes(3);

    expect(await timed(device.fetchSnapshot('src-1'))).toBe(0);
    expect(bulk.controller.snapshotWithMeta).toHaveBeenCalledTimes(2);
    expect(main.controller.snapshotWithMeta).toHaveBeenCalledTimes(3);
    expect(getSnapshot('cam-1')).toBe(revived);
    await device.close();
  });

  it('keep the main connection another minute when the background probe gets no answer', async () => {
    const main = fakeClient();
    const bulk = fakeClient();
    const device = await createReactiveCameraDevice({ rpc: shallowRef(main.client), bulkRpc: shallowRef(bulk.client) }, CAMERA);
    goDead(bulk);
    await timed(device.fetchSnapshot('src-1'));

    await vi.advanceTimersByTimeAsync(60_000);
    expect(await timed(device.fetchSnapshot('src-1'))).toBe(0);
    expect(bulk.flush).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(59_000);
    expect(await timed(device.fetchSnapshot('src-1'))).toBe(0);
    expect(bulk.flush).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(await timed(device.fetchSnapshot('src-1'))).toBe(0);
    expect(bulk.flush).toHaveBeenCalledTimes(3);
    expect(bulk.controller.snapshotWithMeta).toHaveBeenCalledTimes(1);
    expect(main.controller.snapshotWithMeta).toHaveBeenCalledTimes(4);
    await device.close();
  });

  it('never make a fetch wait on the background probe, and probe once for every camera', async () => {
    const main = fakeClient();
    const bulk = fakeClient();
    const rpc = shallowRef<RPCClient | undefined>(main.client);
    const bulkRpc = shallowRef<RPCClient | undefined>(bulk.client);
    const devices = await Promise.all(Array.from({ length: 4 }, (_, i) => createReactiveCameraDevice({ rpc, bulkRpc }, { ...CAMERA, _id: `cam-${i + 1}` } as Camera)));
    goDead(bulk);
    await timed(devices[0]!.fetchSnapshot('src-1'));
    await vi.advanceTimersByTimeAsync(60_000);
    const probe = deferred<void>();
    bulk.flush.mockImplementation(() => probe.promise);

    // no timer runs here: a fetch that waited on the probe would never settle
    const fetched = await Promise.all(devices.map((device) => device.fetchSnapshot('src-1')));

    expect(fetched.every((data) => data?.byteLength === 3)).toBe(true);
    expect(bulk.flush).toHaveBeenCalledTimes(2);
    expect(bulk.controller.snapshotWithMeta).toHaveBeenCalledTimes(1);

    bulk.controller.snapshotWithMeta.mockImplementation(async () => ({ data: jpeg(7), ageMs: 0 }));
    probe.resolve();
    await flush();
    await devices[1]!.fetchSnapshot('src-1');
    expect(bulk.controller.snapshotWithMeta).toHaveBeenCalledTimes(2);
    await Promise.all(devices.map((device) => device.close()));
  });

  it('let a late probe of a replaced bulk client leave the new one marked', async () => {
    const main = fakeClient();
    const dead = fakeClient();
    const fresh = fakeClient();
    const bulkRpc = shallowRef<RPCClient | undefined>(dead.client);
    const device = await createReactiveCameraDevice({ rpc: shallowRef(main.client), bulkRpc }, CAMERA);
    goDead(dead);
    await timed(device.fetchSnapshot('src-1'));
    await vi.advanceTimersByTimeAsync(60_000);
    const probe = deferred<void>();
    dead.flush.mockImplementation(() => probe.promise);
    await device.fetchSnapshot('src-1');

    bulkRpc.value = fresh.client;
    goDead(fresh);
    expect(await timed(device.fetchSnapshot('src-1'))).toBe(12_000);
    probe.resolve();
    await flush();

    expect(await timed(device.fetchSnapshot('src-1'))).toBe(0);
    expect(fresh.controller.snapshotWithMeta).toHaveBeenCalledTimes(1);
    await device.close();
  });
});

describe('useSnapshot device hold', () => {
  it('holds the device after a failed first load and then gets its pushes', async () => {
    const rpc = fakeClient();
    rpc.controller.getCamera.mockRejectedValueOnce(new Error('boom')).mockRejectedValueOnce(new Error('boom'));

    const { result, stop } = inContext({ rpc: shallowRef(rpc.client) }, () => useSnapshot('cam-1'));
    await flush();
    expect(rpc.controller.getCamera).toHaveBeenCalledTimes(2);
    expect(rpc.active()).toBe(0);
    expect(result.snapshot.value).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(rpc.controller.getCamera).toHaveBeenCalledTimes(3);
    expect(rpc.active()).toBe(2);
    expect(rpc.controller.snapshotWithMeta).toHaveBeenCalledTimes(1);
    expect(result.snapshot.value?.byteLength).toBe(3);

    const pushed = jpeg(2);
    rpc.push(pushed, Date.now());
    expect(result.snapshot.value).toBe(pushed);
    stop();
  });

  it('backs off between hold retries up to 30 s and stops once the scope ends', async () => {
    const rpc = fakeClient();
    const start = Date.now();
    const calls: number[] = [];
    rpc.controller.getCamera.mockImplementation(async () => {
      calls.push(Date.now() - start);
      throw new Error('boom');
    });

    const { stop } = inContext({ rpc: shallowRef(rpc.client) }, () => useSnapshot('cam-1'));
    await flush();
    await vi.advanceTimersByTimeAsync(91_000);
    expect(calls).toEqual([0, 0, 1_000, 3_000, 7_000, 15_000, 31_000, 61_000, 91_000]);

    stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls).toHaveLength(9);
  });

  it('stops retrying while the link is down', async () => {
    const rpc = fakeClient();
    rpc.controller.getCamera.mockRejectedValue(new Error('boom'));
    const isConnected = ref(true);

    const { stop } = inContext({ rpc: shallowRef(rpc.client), isConnected }, () => useSnapshot('cam-1'));
    await flush();
    isConnected.value = false;
    await flush();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(rpc.controller.getCamera).toHaveBeenCalledTimes(2);
    stop();
  });

  it('does not retry a hold that failed after the link went down', async () => {
    const rpc = fakeClient();
    let fail!: (err: Error) => void;
    rpc.controller.getCamera.mockReturnValueOnce(new Promise((_resolve, reject) => (fail = reject)));
    const isConnected = ref(true);

    const { stop } = inContext({ rpc: shallowRef(rpc.client), isConnected }, () => useSnapshot('cam-1'));
    await flush();
    isConnected.value = false;
    await flush();
    fail(new Error('boom'));
    await flush();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(rpc.controller.getCamera).toHaveBeenCalledTimes(1);
    stop();
  });

  it('retries the camera it shows after a switch', async () => {
    const rpc = fakeClient();
    rpc.controller.getCamera.mockRejectedValue(new Error('boom'));
    const cameraId = ref('cam-1');

    const { stop } = inContext({ rpc: shallowRef(rpc.client) }, () => useSnapshot(cameraId));
    await flush();
    cameraId.value = 'cam-2';
    await flush();
    rpc.controller.getCamera.mockClear();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(rpc.controller.getCamera).toHaveBeenCalledTimes(1);
    expect(rpc.controller.getCamera).toHaveBeenCalledWith('cam-2', '@camera.ui/browser');
    stop();
  });

  it('retries the new camera when the old hold fails after the switch', async () => {
    const rpc = fakeClient();
    let failOld!: (err: Error) => void;
    let failNew!: (err: Error) => void;
    rpc.controller.getCamera
      .mockReturnValueOnce(new Promise((_resolve, reject) => (failOld = reject)))
      .mockReturnValueOnce(new Promise((_resolve, reject) => (failNew = reject)))
      .mockRejectedValue(new Error('boom'));
    const cameraId = ref('cam-1');

    const { stop } = inContext({ rpc: shallowRef(rpc.client) }, () => useSnapshot(cameraId));
    await flush();
    cameraId.value = 'cam-2';
    await flush();
    failOld(new Error('boom'));
    await flush();
    failNew(new Error('boom'));
    await flush();
    rpc.controller.getCamera.mockClear();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(rpc.controller.getCamera).toHaveBeenCalledWith('cam-2', '@camera.ui/browser');
    stop();
  });

  it('does not retry a hold that fails after the camera was disabled', async () => {
    const rpc = fakeClient();
    let fail!: (err: Error) => void;
    rpc.controller.getCamera.mockReturnValueOnce(new Promise((_resolve, reject) => (fail = reject))).mockRejectedValue(new Error('boom'));
    const camera = shallowRef({ _id: 'cam-1', disabled: false } as unknown as DBCamera);

    const { stop } = inContext({ rpc: shallowRef(rpc.client) }, () => useSnapshot(camera));
    await flush();
    camera.value = { ...camera.value, disabled: true };
    await flush();
    fail(new Error('boom'));
    await flush();
    rpc.controller.getCamera.mockClear();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(rpc.controller.getCamera).not.toHaveBeenCalled();
    stop();
  });

  it('keeps a pushed image in the view when a late reply with an older one lands', async () => {
    const main = fakeClient();
    const bulk = fakeClient();
    const reply = deferred<unknown>();
    bulk.controller.snapshotWithMeta.mockReturnValueOnce(reply.promise);
    const pushed = jpeg(2);

    const { result, stop } = inContext({ rpc: shallowRef(main.client), bulkRpc: shallowRef(bulk.client) }, () => useSnapshot('cam-1'));
    await flush();
    expect(bulk.controller.snapshotWithMeta).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(800);
    main.push(pushed, Date.now());
    await vi.advanceTimersByTimeAsync(400);
    reply.resolve({ data: jpeg(1), ageMs: 5_000 });
    await flush();

    expect(result.snapshot.value).toBe(pushed);
    expect(result.isLoading.value).toBe(false);
    stop();
  });

  it('keeps a pushed image after a refresh that joined an older load', async () => {
    const main = fakeClient();
    const bulk = fakeClient();
    const reply = deferred<unknown>();
    bulk.controller.snapshotWithMeta.mockReturnValueOnce(reply.promise);
    const pushed = jpeg(2);

    const { result, stop } = inContext({ rpc: shallowRef(main.client), bulkRpc: shallowRef(bulk.client) }, () => useSnapshot('cam-1'));
    await flush();
    const refreshing = result.refresh();
    await vi.advanceTimersByTimeAsync(800);
    main.push(pushed, Date.now());
    await vi.advanceTimersByTimeAsync(400);
    reply.resolve({ data: jpeg(1), ageMs: 5_000 });
    await refreshing;

    expect(result.snapshot.value).toBe(pushed);
    stop();
  });

  it('does not hold a device that finishes loading after the scope ended', async () => {
    const rpc = fakeClient();
    const loading = deferred<unknown>();
    rpc.controller.getCamera.mockReturnValueOnce(loading.promise);

    const { stop } = inContext({ rpc: shallowRef(rpc.client) }, () => useSnapshot('cam-1'));
    await flush();
    stop();
    loading.resolve(CAMERA);
    await flush();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(rpc.active()).toBe(0);
  });

  it('does not retry a hold that fails after the scope ended', async () => {
    const rpc = fakeClient();
    let fail!: (err: Error) => void;
    rpc.controller.getCamera.mockReturnValueOnce(new Promise((_resolve, reject) => (fail = reject))).mockRejectedValue(new Error('boom'));

    const { stop } = inContext({ rpc: shallowRef(rpc.client) }, () => useSnapshot('cam-1'));
    await flush();
    stop();
    fail(new Error('boom'));
    await flush();
    rpc.controller.getCamera.mockClear();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(rpc.controller.getCamera).not.toHaveBeenCalled();
  });
});

describe('useSnapshot after a reconnect', () => {
  function eventContext(rpc: RPCClient) {
    const listeners = new Map<string, Set<() => void>>();
    const ctx = {
      rpc: shallowRef(rpc),
      isConnected: ref(true),
      on: (event: string, cb: () => void) => {
        let set = listeners.get(event);
        if (!set) listeners.set(event, (set = new Set()));
        set.add(cb);
      },
      off: (event: string, cb: () => void) => listeners.get(event)?.delete(cb),
    };
    function emit(event: string): void {
      for (const cb of [...(listeners.get(event) ?? [])]) cb();
    }
    return { ctx, emit };
  }

  function conditionalServer(rpc: ReturnType<typeof fakeClient>) {
    const stored = { data: jpeg(1), fetchedAt: 1_000 };
    rpc.controller.snapshotWithMeta.mockImplementation(async (...args: unknown[]) => {
      const [, forceNew, known] = args;
      if (forceNew) Object.assign(stored, { data: jpeg(9), fetchedAt: stored.fetchedAt + 1 });
      else if (known === stored.fetchedAt) return { notModified: true, fetchedAt: stored.fetchedAt, ageMs: 0 };
      return { data: stored.data, ageMs: 0, fetchedAt: stored.fetchedAt };
    });
    return stored;
  }

  it('refreshes the snapshots of a second app after its reconnect', async () => {
    const first = fakeClient();
    const second = fakeClient();
    second.controller.getCamera.mockResolvedValue({ ...CAMERA, _id: 'cam-2' });
    const a = eventContext(first.client);
    const b = eventContext(second.client);
    const viewA = inContext(a.ctx, () => useSnapshot('cam-1'));
    const viewB = inContext(b.ctx, () => useSnapshot('cam-2'));
    await flush();
    second.controller.snapshotWithMeta.mockClear();

    b.emit('reconnected');
    await vi.advanceTimersByTimeAsync(500);

    expect(second.controller.snapshotWithMeta).toHaveBeenCalled();
    viewA.stop();
    viewB.stop();
  });

  it('keeps the image without its bytes when the server has nothing newer', async () => {
    const rpc = fakeClient();
    conditionalServer(rpc);
    const { ctx, emit } = eventContext(rpc.client);
    const { result, stop } = inContext(ctx, () => useSnapshot('cam-1'));
    await vi.advanceTimersByTimeAsync(100);
    const shown = result.snapshot.value;
    expect(rpc.controller.snapshotWithMeta).toHaveBeenLastCalledWith('src-1', undefined);

    emit('reconnected');
    await vi.advanceTimersByTimeAsync(500);

    expect(rpc.controller.snapshotWithMeta).toHaveBeenCalledTimes(2);
    expect(rpc.controller.snapshotWithMeta).toHaveBeenLastCalledWith('src-1', undefined, 1_000);
    expect(result.snapshot.value).toBe(shown);
    stop();
  });

  it('asks against the fetch time of the last push', async () => {
    const rpc = fakeClient();
    const stored = conditionalServer(rpc);
    const { ctx, emit } = eventContext(rpc.client);
    const { result, stop } = inContext(ctx, () => useSnapshot('cam-1'));
    await vi.advanceTimersByTimeAsync(100);
    const pushed = jpeg(2);
    Object.assign(stored, { data: pushed, fetchedAt: 5_000 });
    rpc.push(pushed, 5_000);

    emit('reconnected');
    await vi.advanceTimersByTimeAsync(500);

    expect(rpc.controller.snapshotWithMeta).toHaveBeenLastCalledWith('src-1', undefined, 5_000);
    expect(result.snapshot.value).toBe(pushed);
    stop();
  });

  it('takes a newer image the server took while the link was down', async () => {
    const rpc = fakeClient();
    const stored = conditionalServer(rpc);
    const { ctx, emit } = eventContext(rpc.client);
    const { result, stop } = inContext(ctx, () => useSnapshot('cam-1'));
    await vi.advanceTimersByTimeAsync(100);
    const missed = jpeg(3);
    Object.assign(stored, { data: missed, fetchedAt: 7_000 });

    emit('reconnected');
    await vi.advanceTimersByTimeAsync(500);

    expect(result.snapshot.value).toBe(missed);
    stop();
  });

  it('takes a refreshed image after the server clock stepped back', async () => {
    const rpc = fakeClient();
    rpc.controller.snapshotWithMeta.mockResolvedValueOnce({ data: jpeg(1), ageMs: 0, fetchedAt: 60 * 60_000 });
    const { ctx } = eventContext(rpc.client);
    const { result, stop } = inContext(ctx, () => useSnapshot('cam-1'));
    await vi.advanceTimersByTimeAsync(100);
    const refreshed = jpeg(9);
    rpc.controller.snapshotWithMeta.mockResolvedValueOnce({ data: refreshed, ageMs: 0, fetchedAt: 50_000 });

    await result.refresh();

    expect(result.snapshot.value).toBe(refreshed);
    stop();
  });

  it('never sends the fetch time with a forced fetch', async () => {
    const rpc = fakeClient();
    conditionalServer(rpc);
    const { ctx } = eventContext(rpc.client);
    const { result, stop } = inContext(ctx, () => useSnapshot('cam-1'));
    await vi.advanceTimersByTimeAsync(100);

    await result.refresh();

    expect(rpc.controller.snapshotWithMeta).toHaveBeenLastCalledWith('src-1', true);
    stop();
  });

  it('asks without a fetch time after a reply from a server that sent none', async () => {
    const rpc = fakeClient();
    const { ctx, emit } = eventContext(rpc.client);
    const { stop } = inContext(ctx, () => useSnapshot('cam-1'));
    await flush();

    emit('reconnected');
    await vi.advanceTimersByTimeAsync(500);

    expect(rpc.controller.snapshotWithMeta).toHaveBeenCalledTimes(2);
    expect(rpc.controller.snapshotWithMeta).toHaveBeenLastCalledWith('src-1', undefined);
    stop();
  });

  it('asks without a fetch time once a reply without one replaced a pushed image', async () => {
    const rpc = fakeClient();
    const { ctx, emit } = eventContext(rpc.client);
    const { stop } = inContext(ctx, () => useSnapshot('cam-1'));
    await vi.advanceTimersByTimeAsync(100);
    rpc.push(jpeg(2), 5_000);
    emit('reconnected');
    await vi.advanceTimersByTimeAsync(500);
    expect(rpc.controller.snapshotWithMeta).toHaveBeenLastCalledWith('src-1', undefined, 5_000);

    emit('reconnected');
    await vi.advanceTimersByTimeAsync(500);

    expect(rpc.controller.snapshotWithMeta).toHaveBeenCalledTimes(3);
    expect(rpc.controller.snapshotWithMeta).toHaveBeenLastCalledWith('src-1', undefined);
    stop();
  });
});

describe('useSnapshot when the app comes back', () => {
  function storedOnServer(rpc: ReturnType<typeof fakeClient>, snapshotSettings: Camera['snapshotSettings']) {
    const camera = { ...CAMERA, snapshotSettings };
    rpc.controller.getCamera.mockResolvedValue(camera);
    rpc.controller.refreshStates.mockResolvedValue({ camera, cameraState: true, frameWorkerState: false, sensorStates: {} });
    const stored = { data: jpeg(1), fetchedAt: Date.now() };
    rpc.controller.snapshotWithMeta.mockImplementation(async (...args: unknown[]) => {
      const ageMs = Date.now() - stored.fetchedAt;
      if (args[2] === stored.fetchedAt) return { notModified: true, fetchedAt: stored.fetchedAt, ageMs };
      return { data: stored.data, ageMs, fetchedAt: stored.fetchedAt };
    });
    return stored;
  }

  async function comeBackAfter(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
    for (const cb of [...tabVisible]) cb();
    await vi.advanceTimersByTimeAsync(100);
  }

  it('shows the picture the server took while the app was in the background', async () => {
    const rpc = fakeClient();
    const stored = storedOnServer(rpc, { mode: 'interval', interval: 60, maxAge: 10 });
    const { result, stop } = inContext({ rpc: shallowRef(rpc.client) }, () => useSnapshot('cam-1'));
    await vi.advanceTimersByTimeAsync(100);
    const missed = jpeg(5);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    Object.assign(stored, { data: missed, fetchedAt: Date.now() - 20_000 });
    await comeBackAfter(0);

    expect(rpc.controller.snapshotWithMeta).toHaveBeenLastCalledWith('src-1', undefined, expect.any(Number));
    expect(result.snapshot.value).toBe(missed);
    stop();
  });

  it('waits for the next push while the picture is younger than one interval', async () => {
    const rpc = fakeClient();
    storedOnServer(rpc, { mode: 'interval', interval: 60, maxAge: 10 });
    const { stop } = inContext({ rpc: shallowRef(rpc.client) }, () => useSnapshot('cam-1'));
    await vi.advanceTimersByTimeAsync(100);

    await comeBackAfter(55_000);

    expect(rpc.controller.snapshotWithMeta).toHaveBeenCalledTimes(1);
    stop();
  });

  it('asks past the max age when pictures are taken on view', async () => {
    const rpc = fakeClient();
    storedOnServer(rpc, { mode: 'onView', interval: 60, maxAge: 10 });
    const { stop } = inContext({ rpc: shallowRef(rpc.client) }, () => useSnapshot('cam-1'));
    await vi.advanceTimersByTimeAsync(100);

    await comeBackAfter(15_000);

    expect(rpc.controller.snapshotWithMeta).toHaveBeenCalledTimes(2);
    stop();
  });

  it('never asks for a camera that takes pictures only on request', async () => {
    const rpc = fakeClient();
    storedOnServer(rpc, { mode: 'onDemand', interval: 60, maxAge: 10 });
    const { stop } = inContext({ rpc: shallowRef(rpc.client) }, () => useSnapshot('cam-1'));
    await vi.advanceTimersByTimeAsync(100);

    await comeBackAfter(60 * 60_000);

    expect(rpc.controller.snapshotWithMeta).toHaveBeenCalledTimes(1);
    stop();
  });
});
