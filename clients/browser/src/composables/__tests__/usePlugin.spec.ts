import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, effectScope, ref, shallowRef, watch } from 'vue';

import { CAMERA_UI_INJECTION_KEY, createCameraUiPlugin } from '../../plugin.js';
import { clearPluginIdCache, resolvePluginId } from '../resolvePluginId.js';
import { createReactiveCameraDevice } from '../useCamera.js';
import { clearPluginCache, usePlugin } from '../usePlugin.js';
import { clearSnapshotCache } from '../useSnapshot.js';

import type { RPCClient } from '@camera.ui/rpc';
import type { Camera } from '@camera.ui/sdk';
import type { NatsTransport } from '@camera.ui/transport/transports/nats';
import type { MaybeRefOrGetter, ShallowRef } from 'vue';
import type { CameraUiContext } from '../../types.js';
import type { UsePluginOptions } from '../usePlugin.js';

type Listener = (msg: unknown) => void;

const CAMERA = { _id: 'cam-1', name: 'Front', sources: [{ _id: 'src-1', role: 'high-resolution' }] } as unknown as Camera;

function fakeClient(lane: string) {
  const previewFrames = vi.fn(async (): Promise<string> => lane);
  const flush = vi.fn(async (_timeoutMs?: number): Promise<void> => {});
  const camera = {
    refreshStates: async () => ({ camera: CAMERA, cameraState: true, frameWorkerState: false, sensorStates: {} }),
    snapshotWithMeta: vi.fn(async (): Promise<unknown> => ({ data: new Uint8Array([0xff, 0xd8, 1]).buffer, ageMs: 0 })),
  };
  const createProxy = vi.fn((namespace: string) => {
    if (namespace.includes('core')) {
      return { getPlugin: async () => ({ id: 'nvr-id', running: true }) };
    }
    if (namespace.startsWith('camera.')) return camera;
    return { nvrPreviewFrames: previewFrames };
  });
  const client = {
    createProxy,
    subscribe: async () => () => {},
    flush,
  } as unknown as RPCClient;
  return { client, createProxy, previewFrames, flush, camera };
}

function timeOut(ms = 10_000): Promise<never> {
  return new Promise((_resolve, reject) => setTimeout(() => reject(Object.assign(new Error('timed out'), { code: 'TIMEOUT' })), ms));
}

function goDead(lane: ReturnType<typeof fakeClient>): void {
  lane.previewFrames.mockImplementation(() => timeOut());
  lane.camera.snapshotWithMeta.mockImplementation(() => timeOut());
  lane.flush.mockImplementation((timeoutMs) => timeOut(timeoutMs));
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function inContext(main: RPCClient, bulkRpc: ShallowRef<RPCClient | undefined> | undefined, options?: UsePluginOptions) {
  const app = createApp({});
  app.provide(CAMERA_UI_INJECTION_KEY, { rpc: shallowRef(main), bulkRpc, isConnected: ref(true), on: () => {}, off: () => {} } as unknown as CameraUiContext);
  const scope = effectScope();
  const result = app.runWithContext(() => scope.run(() => usePlugin('@camera.ui/camera-ui-nvr', options))!);
  return { result, stop: () => scope.stop() };
}

type PreviewPlugin = { nvrPreviewFrames(): Promise<string> };

afterEach(() => {
  clearPluginCache();
  clearPluginIdCache();
});

describe('usePlugin lanes', () => {
  it('sends bulk-lane calls over the bulk client and loads the plugin over main', async () => {
    const main = fakeClient('main');
    const bulk = fakeClient('bulk');
    const { result, stop } = inContext(main.client, shallowRef(bulk.client), { lane: 'bulk' });
    await flush();

    expect(await (result.plugin.value as unknown as PreviewPlugin).nvrPreviewFrames()).toBe('bulk');
    expect(bulk.createProxy).not.toHaveBeenCalledWith(expect.stringContaining('core'));
    expect(main.previewFrames).not.toHaveBeenCalled();
    stop();
  });

  it('falls back to the main client while the bulk lane is down and follows it when it comes up', async () => {
    const main = fakeClient('main');
    const bulk = fakeClient('bulk');
    const bulkRpc = shallowRef<RPCClient | undefined>();
    const { result, stop } = inContext(main.client, bulkRpc, { lane: 'bulk' });
    await flush();
    const plugin = result.plugin.value as unknown as PreviewPlugin;

    expect(await plugin.nvrPreviewFrames()).toBe('main');
    bulkRpc.value = bulk.client;
    expect(await plugin.nvrPreviewFrames()).toBe('bulk');
    expect(await plugin.nvrPreviewFrames()).toBe('bulk');
    expect(bulk.createProxy).toHaveBeenCalledTimes(1);
    expect(result.plugin.value).toBe(plugin);
    stop();
  });

  it('keeps the main lane by default and without a bulk transport', async () => {
    const main = fakeClient('main');
    const bulk = fakeClient('bulk');
    const plain = inContext(main.client, shallowRef(bulk.client));
    await flush();
    expect(await (plain.result.plugin.value as unknown as PreviewPlugin).nvrPreviewFrames()).toBe('main');
    plain.stop();
    clearPluginCache();

    const noBulk = inContext(main.client, undefined, { lane: 'bulk' });
    await flush();
    expect(await (noBulk.result.plugin.value as unknown as PreviewPlugin).nvrPreviewFrames()).toBe('main');
    noBulk.stop();
  });
});

describe('usePlugin on a dead bulk lane', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    clearSnapshotCache();
    vi.useRealTimers();
  });

  async function mountOnLane(main: RPCClient, bulkRpc: ShallowRef<RPCClient | undefined>) {
    const mounted = inContext(main, bulkRpc, { lane: 'bulk' });
    await flush();
    return { ...mounted, plugin: mounted.result.plugin.value as unknown as PreviewPlugin };
  }

  async function timeOutOnce(plugin: PreviewPlugin): Promise<{ err: unknown; ms: number } | undefined> {
    const start = Date.now();
    const failed = plugin.nvrPreviewFrames().then(
      () => undefined,
      (err: unknown) => ({ err, ms: Date.now() - start }),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    return failed;
  }

  it('sends calls over main while a snapshot fetch has the bulk client marked dead', async () => {
    const main = fakeClient('main');
    const bulk = fakeClient('bulk');
    const bulkRpc = shallowRef<RPCClient | undefined>(bulk.client);
    const { plugin, stop } = await mountOnLane(main.client, bulkRpc);
    const device = await createReactiveCameraDevice({ rpc: shallowRef(main.client), bulkRpc }, CAMERA);
    bulk.camera.snapshotWithMeta.mockImplementation(() => timeOut());
    bulk.flush.mockImplementation((timeoutMs) => timeOut(timeoutMs));
    const fetching = device.fetchSnapshot('src-1');
    await vi.runAllTimersAsync();
    await fetching;

    expect(await plugin.nvrPreviewFrames()).toBe('main');
    expect(bulk.previewFrames).not.toHaveBeenCalled();
    await device.close();
    stop();
  });

  it('moves later calls to main once a call timed out and the bulk lane missed the probe', async () => {
    const main = fakeClient('main');
    const bulk = fakeClient('bulk');
    const { plugin, stop } = await mountOnLane(main.client, shallowRef(bulk.client));
    goDead(bulk);

    expect(await timeOutOnce(plugin)).toMatchObject({ err: { code: 'TIMEOUT' }, ms: 10_000 });
    expect(bulk.flush).toHaveBeenCalledTimes(1);
    expect(bulk.flush).toHaveBeenCalledWith(2_000);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(await plugin.nvrPreviewFrames()).toBe('main');
    expect(bulk.previewFrames).toHaveBeenCalledTimes(1);
    stop();
  });

  it('keeps the bulk lane when a timed out call finds it answering the probe', async () => {
    const main = fakeClient('main');
    const bulk = fakeClient('bulk');
    const { plugin, stop } = await mountOnLane(main.client, shallowRef(bulk.client));
    bulk.previewFrames.mockImplementationOnce(() => timeOut());

    expect(await timeOutOnce(plugin)).toMatchObject({ err: { code: 'TIMEOUT' }, ms: 10_000 });
    await flush();

    expect(bulk.flush).toHaveBeenCalledTimes(1);
    expect(await plugin.nvrPreviewFrames()).toBe('bulk');
    stop();
  });

  it('probes once for calls that time out together', async () => {
    const main = fakeClient('main');
    const bulk = fakeClient('bulk');
    const { plugin, stop } = await mountOnLane(main.client, shallowRef(bulk.client));
    goDead(bulk);

    const calls = Array.from({ length: 3 }, () => plugin.nvrPreviewFrames().catch((err: unknown) => err));
    await vi.advanceTimersByTimeAsync(12_000);

    expect(await Promise.all(calls)).toMatchObject([{ code: 'TIMEOUT' }, { code: 'TIMEOUT' }, { code: 'TIMEOUT' }]);
    expect(bulk.flush).toHaveBeenCalledTimes(1);
    expect(await plugin.nvrPreviewFrames()).toBe('main');
    stop();
  });

  it('lets snapshot fetches skip a bulk lane a timed out call found dead', async () => {
    const main = fakeClient('main');
    const bulk = fakeClient('bulk');
    const bulkRpc = shallowRef<RPCClient | undefined>(bulk.client);
    const { plugin, stop } = await mountOnLane(main.client, bulkRpc);
    const device = await createReactiveCameraDevice({ rpc: shallowRef(main.client), bulkRpc }, CAMERA);
    goDead(bulk);
    await timeOutOnce(plugin);
    await vi.advanceTimersByTimeAsync(2_000);

    const start = Date.now();
    const fetching = device.fetchSnapshot('src-1').then(() => Date.now() - start);
    await vi.runAllTimersAsync();

    expect(await fetching).toBe(0);
    expect(bulk.camera.snapshotWithMeta).not.toHaveBeenCalled();
    expect(main.camera.snapshotWithMeta).toHaveBeenCalledTimes(1);
    await device.close();
    stop();
  });

  it('goes back to the bulk lane once a background probe a minute later gets an answer', async () => {
    const main = fakeClient('main');
    const bulk = fakeClient('bulk');
    const { plugin, stop } = await mountOnLane(main.client, shallowRef(bulk.client));
    goDead(bulk);
    await timeOutOnce(plugin);
    await vi.advanceTimersByTimeAsync(2_000);
    bulk.previewFrames.mockImplementation(async () => 'bulk');
    bulk.flush.mockImplementation(async () => {});

    await vi.advanceTimersByTimeAsync(60_000);
    expect(await plugin.nvrPreviewFrames()).toBe('main');
    expect(bulk.flush).toHaveBeenCalledTimes(2);
    await flush();

    expect(await plugin.nvrPreviewFrames()).toBe('bulk');
    stop();
  });
});

const NVR = '@camera.ui/camera-ui-nvr';

function statusRpc() {
  const info = { id: 'nvr-id', running: true };
  const listeners = new Set<Listener>();
  const getPlugin = vi.fn(async (name: string) => (name === NVR ? { ...info } : { id: `${name}-id`, running: true, contract: { name } }));
  const client = {
    isConnected: true,
    createProxy: (namespace: string) => (namespace.includes('core') ? { getPlugin } : { namespace, nvrPreviewFrames: async () => 'main' }),
    async subscribe(_subject: string, cb: Listener) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  } as unknown as RPCClient;
  const status = (running: boolean): void => {
    for (const cb of listeners) cb({ type: 'pluginStatusChanged', data: { pluginName: NVR, running } });
  };
  return { client, getPlugin, info, status };
}

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
  function mount(name: MaybeRefOrGetter<string> = NVR) {
    const app = createApp({});
    app.provide(CAMERA_UI_INJECTION_KEY, context);
    const scope = effectScope();
    const result = app.runWithContext(() => scope.run(() => usePlugin(name))!);
    return { result, stop: () => scope.stop() };
  }
  return { context, link, mount };
}

describe('usePlugin across connection drops', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the plugin proxy through a short drop of the same client', async () => {
    const backend = statusRpc();
    const app = transportContext(backend.client);
    const { result, stop } = app.mount();
    await flush();
    const proxy = result.plugin.value;
    const seen: unknown[] = [];
    watch(result.plugin, (next) => seen.push(next), { flush: 'sync' });

    app.link(null);
    await vi.advanceTimersByTimeAsync(1_500);
    app.link(backend.client);
    await vi.advanceTimersByTimeAsync(0);

    expect(proxy).toBeDefined();
    expect(result.plugin.value).toBe(proxy);
    expect(seen).toEqual([]);
    stop();
  });

  it('drops the proxy once the connection counts as lost', async () => {
    const backend = statusRpc();
    const app = transportContext(backend.client);
    const { result, stop } = app.mount();
    await flush();

    app.link(null);
    await vi.advanceTimersByTimeAsync(4_000);

    expect(app.context.isConnected.value).toBe(false);
    expect(result.plugin.value).toBeUndefined();
    stop();
  });

  it('loads the plugin again on a new client', async () => {
    const backend = statusRpc();
    const next = statusRpc();
    const app = transportContext(backend.client);
    const { result, stop } = app.mount();
    await flush();
    const proxy = result.plugin.value;

    app.link(null);
    await vi.advanceTimersByTimeAsync(0);
    app.link(next.client);
    await vi.advanceTimersByTimeAsync(0);

    expect(next.getPlugin).toHaveBeenCalledTimes(1);
    expect(result.plugin.value).toBeDefined();
    expect(result.plugin.value).not.toBe(proxy);
    stop();
  });

  it('checks the plugin once after a drop and lets go of one that stopped meanwhile', async () => {
    const backend = statusRpc();
    const app = transportContext(backend.client);
    const views = [app.mount(), app.mount()];
    await flush();
    expect(backend.getPlugin).toHaveBeenCalledTimes(1);

    app.link(null);
    await vi.advanceTimersByTimeAsync(0);
    backend.info.running = false;
    app.link(backend.client);
    await vi.advanceTimersByTimeAsync(0);

    expect(views.map((view) => view.result.plugin.value)).toEqual([undefined, undefined]);
    expect(backend.getPlugin.mock.calls.length).toBeLessThanOrEqual(3);
    views.forEach((view) => view.stop());
  });

  it('keeps a running plugin after the check that follows a drop', async () => {
    const backend = statusRpc();
    const app = transportContext(backend.client);
    const views = [app.mount(), app.mount()];
    await flush();
    const proxy = views[0]!.result.plugin.value;

    app.link(null);
    await vi.advanceTimersByTimeAsync(0);
    app.link(backend.client);
    await vi.advanceTimersByTimeAsync(0);

    expect(backend.getPlugin).toHaveBeenCalledTimes(2);
    expect(views.map((view) => view.result.plugin.value)).toEqual([proxy, proxy]);
    views.forEach((view) => view.stop());
  });

  it('loads the plugin again when it came back under a new id during a drop', async () => {
    const backend = statusRpc();
    const app = transportContext(backend.client);
    const { result, stop } = app.mount();
    await flush();

    app.link(null);
    await vi.advanceTimersByTimeAsync(0);
    backend.info.id = 'nvr-id-2';
    app.link(backend.client);
    await vi.advanceTimersByTimeAsync(0);

    expect((result.plugin.value as unknown as { namespace: string }).namespace).toContain('nvr-id-2');
    stop();
  });

  it('lets go of the previous plugin when the name changes during a short drop', async () => {
    const backend = statusRpc();
    const app = transportContext(backend.client);
    const name = ref(NVR);
    const { result, stop } = app.mount(name);
    await flush();
    expect(result.plugin.value).toBeDefined();

    app.link(null);
    await vi.advanceTimersByTimeAsync(0);
    name.value = 'other-plugin';
    await vi.advanceTimersByTimeAsync(1_000);

    expect(result.plugin.value).toBeUndefined();
    expect(result.contract.value).toBeUndefined();

    app.link(backend.client);
    await vi.advanceTimersByTimeAsync(0);

    expect((result.plugin.value as unknown as { namespace: string }).namespace).toContain('other-plugin-id');
    expect(result.contract.value).toEqual({ name: 'other-plugin' });
    stop();
  });

  it('asks for the id again after the plugin stopped', async () => {
    const backend = statusRpc();
    const app = transportContext(backend.client);
    const { stop } = app.mount();
    await flush();
    expect(await resolvePluginId(app.context.rpc, '@camera.ui/camera-ui-nvr')).toBe('nvr-id');

    backend.status(false);
    backend.info.id = 'nvr-id-2';

    expect(await resolvePluginId(app.context.rpc, '@camera.ui/camera-ui-nvr')).toBe('nvr-id-2');
    stop();
  });
});
