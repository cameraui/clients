import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, effectScope, ref, shallowRef } from 'vue';

import { CAMERA_UI_INJECTION_KEY } from '../../plugin.js';
import { refreshClientStates } from '../resetClientState.js';
import { resolvePluginId } from '../resolvePluginId.js';
import { clearPluginCache } from '../usePlugin.js';
import { clearStorageCache, usePluginStorage, useSensorStorage } from '../useStorage.js';

import type { RPCClient } from '@camera.ui/rpc';
import type { SchemaConfig } from '@camera.ui/sdk';
import type { CameraUiContext, CameraUiEventType } from '../../types.js';
import type * as UsePluginModule from '../usePlugin.js';

const statusListeners = vi.hoisted(() => ({ count: 0 }));

vi.mock('../usePlugin.js', async (importOriginal) => {
  const actual = await importOriginal<typeof UsePluginModule>();
  return {
    ...actual,
    onPluginStatus: (listener: Parameters<typeof actual.onPluginStatus>[0]) => {
      statusListeners.count++;
      const off = actual.onPluginStatus(listener);
      return () => {
        statusListeners.count--;
        off();
      };
    },
  };
});

const CONFIG = { schema: [], config: {} } as unknown as SchemaConfig;

function noResponders(ns: string): Error {
  return new Error(`no responders: '${ns}'`);
}

function fakeRpc() {
  const pluginIds = ['id-1'];
  const getConfig = vi.fn(async (ns: string): Promise<SchemaConfig> => {
    throw noResponders(ns);
  });
  const getPlugin = vi.fn(async (name: string): Promise<{ id: string; name: string } | undefined> => ({ id: pluginIds[0]!, name }));

  const statusListeners = new Set<(msg: unknown) => void>();

  const client = {
    createProxy: (ns: string) => (ns === 'coreManager.rpc' ? { getPlugin } : { getConfig: () => getConfig(ns) }),
    async subscribe(_subject: string, cb: (msg: unknown) => void) {
      statusListeners.add(cb);
      return () => statusListeners.delete(cb);
    },
  } as unknown as RPCClient;

  function status(pluginName: string, running: boolean): void {
    for (const cb of statusListeners) cb({ type: 'pluginStatusChanged', data: { pluginName, running } });
  }

  return { client, getConfig, getPlugin, pluginIds, status };
}

function fakeContext(client: RPCClient) {
  const listeners = new Map<CameraUiEventType, Set<() => void>>();
  const context = {
    rpc: shallowRef(client),
    isConnected: ref(true),
    on: (event: CameraUiEventType, cb: () => void) => {
      const set = listeners.get(event) ?? new Set();
      set.add(cb);
      listeners.set(event, set);
    },
    off: (event: CameraUiEventType, cb: () => void) => listeners.get(event)?.delete(cb),
  } as unknown as CameraUiContext;
  const emit = (event: CameraUiEventType): void => listeners.get(event)?.forEach((cb) => cb());
  return { context, emit };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

function inContext<T>(context: CameraUiContext, fn: () => T): { result: T; stop: () => void } {
  const app = createApp({});
  app.provide(CAMERA_UI_INJECTION_KEY, context);
  const scope = effectScope();
  const result = app.runWithContext(() => scope.run(fn)!);
  return { result, stop: () => scope.stop() };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  clearStorageCache();
  clearPluginCache();
  vi.useRealTimers();
});

describe('useStorage', () => {
  it('shows the error after the first failed load and stops loading', async () => {
    const rpc = fakeRpc();
    const { context } = fakeContext(rpc.client);
    const { result, stop } = inContext(context, () => useSensorStorage('sensor-1', 'plugin-1'));
    await flush();

    expect(rpc.getConfig).toHaveBeenCalledTimes(1);
    expect(result.error.value?.message).toContain('no responders');
    expect(result.isLoading.value).toBe(false);
    stop();
  });

  it('keeps retrying quietly and fills the form once the plugin answers', async () => {
    const rpc = fakeRpc();
    const { context } = fakeContext(rpc.client);
    const { result, stop } = inContext(context, () => useSensorStorage('sensor-1', 'plugin-1'));
    await flush();

    let answer!: (config: SchemaConfig) => void;
    rpc.getConfig.mockImplementationOnce(() => new Promise<SchemaConfig>((resolve) => (answer = resolve)));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(rpc.getConfig).toHaveBeenCalledTimes(2);
    expect(result.isLoading.value).toBe(false);

    answer(CONFIG);
    await flush();

    expect(result.config.value).toBe(CONFIG);
    expect(result.error.value).toBeUndefined();
    stop();
  });

  it('gives up after a bounded number of quiet retries', async () => {
    const rpc = fakeRpc();
    const { context } = fakeContext(rpc.client);
    const { stop } = inContext(context, () => useSensorStorage('sensor-1', 'plugin-1'));

    await vi.advanceTimersByTimeAsync(30 * 60_000);

    expect(rpc.getConfig).toHaveBeenCalledTimes(9);
    stop();
  });

  it('leaves no retry timer behind once the scope ends', async () => {
    const rpc = fakeRpc();
    const { context } = fakeContext(rpc.client);
    const { stop } = inContext(context, () => useSensorStorage('sensor-1', 'plugin-1'));
    await flush();

    stop();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(vi.getTimerCount()).toBe(0);
    expect(rpc.getConfig).toHaveBeenCalledTimes(1);
  });

  it('retries at once on reconnect', async () => {
    const rpc = fakeRpc();
    const { context, emit } = fakeContext(rpc.client);
    const { result, stop } = inContext(context, () => useSensorStorage('sensor-1', 'plugin-1'));
    await flush();

    rpc.getConfig.mockResolvedValueOnce(CONFIG);
    emit('reconnected');
    await flush();

    expect(rpc.getConfig).toHaveBeenCalledTimes(2);
    expect(result.config.value).toBe(CONFIG);
    expect(result.error.value).toBeUndefined();
    stop();
  });

  it('returns the config to an awaited load once a slow plugin answers', async () => {
    const rpc = fakeRpc();
    const { context } = fakeContext(rpc.client);
    rpc.getConfig.mockRejectedValueOnce(noResponders('a')).mockRejectedValueOnce(noResponders('a')).mockResolvedValueOnce(CONFIG);
    const { result, stop } = inContext(context, () => useSensorStorage('sensor-1', 'plugin-1'));

    const pending = result.getConfig();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(await pending).toBe(CONFIG);
    expect(result.config.value).toBe(CONFIG);
    stop();
  });

  it('hands an earlier caller the result of a load restarted by a reconnect', async () => {
    const rpc = fakeRpc();
    const { context, emit } = fakeContext(rpc.client);
    const { result, stop } = inContext(context, () => useSensorStorage('sensor-1', 'plugin-1'));
    const pending = result.getConfig();
    await flush();

    rpc.getConfig.mockResolvedValueOnce(CONFIG);
    emit('reconnected');

    expect(await pending).toBe(CONFIG);
    stop();
  });

  it('settles an awaited load once the scope ends', async () => {
    const rpc = fakeRpc();
    const { context } = fakeContext(rpc.client);
    const { result, stop } = inContext(context, () => useSensorStorage('sensor-1', 'plugin-1'));
    const pending = result.getConfig();
    await flush();

    stop();

    expect(await pending).toBeUndefined();
  });

  it('binds no storage when the scope ends while the plugin id is looked up', async () => {
    const rpc = fakeRpc();
    const { context } = fakeContext(rpc.client);
    let answer!: (plugin: { id: string; name: string }) => void;
    rpc.getPlugin.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const { result, stop } = inContext(context, () => usePluginStorage('late'));
    await flush();

    stop();
    answer({ id: 'id-1', name: 'late' });
    await flush();

    expect(rpc.getConfig).not.toHaveBeenCalled();
    expect(result.isConnected.value).toBe(false);
  });

  it('keeps the binding and its error when the plugin cannot be found again', async () => {
    const rpc = fakeRpc();
    const { context } = fakeContext(rpc.client);
    rpc.getPlugin.mockResolvedValueOnce({ id: 'id-1', name: 'gone' }).mockResolvedValueOnce(undefined);
    const { result, stop } = inContext(context, () => usePluginStorage('gone'));
    await flush();

    expect(rpc.getPlugin).toHaveBeenCalledTimes(2);
    expect(result.isConnected.value).toBe(true);
    expect(result.error.value?.message).toContain('no responders');
    stop();
  });

  it('finds a reinstalled plugin under its new id', async () => {
    const rpc = fakeRpc();
    const { context } = fakeContext(rpc.client);
    await resolvePluginId(shallowRef(rpc.client), 'tuya');
    rpc.pluginIds[0] = 'id-2';
    rpc.getConfig.mockImplementation(async (ns: string) => {
      if (ns.includes('id-1')) throw noResponders(ns);
      return CONFIG;
    });

    const { result, stop } = inContext(context, () => usePluginStorage('tuya'));
    await flush();

    expect(rpc.getPlugin).toHaveBeenCalledTimes(2);
    expect(rpc.getConfig).toHaveBeenLastCalledWith('plugin.id-2.storage.rpc');
    expect(result.config.value).toBe(CONFIG);
    expect(result.error.value).toBeUndefined();
    stop();
  });

  it('pauses the quiet retries while its plugin is stopped and loads once it runs again', async () => {
    const rpc = fakeRpc();
    const { context } = fakeContext(rpc.client);
    const { result, stop } = inContext(context, () => usePluginStorage('tuya'));
    await flush();
    expect(rpc.getConfig).toHaveBeenCalledTimes(1);

    rpc.status('tuya', false);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(rpc.getConfig).toHaveBeenCalledTimes(1);
    expect(result.error.value?.message).toContain('no responders');

    rpc.getConfig.mockResolvedValueOnce(CONFIG);
    rpc.status('tuya', true);
    await flush();

    expect(rpc.getConfig).toHaveBeenCalledTimes(2);
    expect(result.config.value).toBe(CONFIG);
    expect(result.error.value).toBeUndefined();
    stop();
  });

  it('settles a waiting caller once its plugin stops and loads again once it runs', async () => {
    const rpc = fakeRpc();
    const { context } = fakeContext(rpc.client);
    const { result, stop } = inContext(context, () => usePluginStorage('tuya'));
    await flush();
    let settled = false;
    const pending = result.getConfig().finally(() => (settled = true));
    await flush();
    expect(settled).toBe(false);

    rpc.status('tuya', false);
    await flush();
    expect(settled).toBe(true);
    expect(await pending).toBeUndefined();

    rpc.getConfig.mockResolvedValueOnce(CONFIG);
    rpc.status('tuya', true);
    await flush();
    expect(result.config.value).toBe(CONFIG);
    stop();
  });

  it('answers a caller at once while its plugin is stopped', async () => {
    const rpc = fakeRpc();
    const { context } = fakeContext(rpc.client);
    const { result, stop } = inContext(context, () => usePluginStorage('tuya'));
    await flush();
    rpc.status('tuya', false);

    let settled = false;
    result.getConfig().finally(() => (settled = true));
    await flush();

    expect(settled).toBe(true);
    expect(rpc.getConfig).toHaveBeenCalledTimes(2);
    expect(result.error.value?.message).toContain('no responders');
    stop();
  });

  it.each([
    ['a short drop', refreshClientStates],
    ['a new client', clearPluginCache],
  ])('retries quietly again after %s that followed a stop', async (_name, reset) => {
    const rpc = fakeRpc();
    const { context, emit } = fakeContext(rpc.client);
    const { stop } = inContext(context, () => usePluginStorage('tuya'));
    await flush();
    rpc.status('tuya', false);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(rpc.getConfig).toHaveBeenCalledTimes(1);

    reset();
    emit('reconnected');
    await flush();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(rpc.getConfig).toHaveBeenCalledTimes(3);
    stop();
  });

  it('ignores the status of other plugins', async () => {
    const rpc = fakeRpc();
    const { context } = fakeContext(rpc.client);
    const { stop } = inContext(context, () => usePluginStorage('tuya'));
    await flush();

    rpc.status('other', false);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(rpc.getConfig).toHaveBeenCalledTimes(2);
    stop();
  });

  it('pauses a sensor storage whose plugin id was resolved before', async () => {
    const rpc = fakeRpc();
    const { context } = fakeContext(rpc.client);
    await resolvePluginId(shallowRef(rpc.client), 'tuya');
    const { result, stop } = inContext(context, () => useSensorStorage('sensor-1', 'id-1'));
    await flush();

    rpc.status('tuya', false);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(rpc.getConfig).toHaveBeenCalledTimes(1);

    rpc.getConfig.mockResolvedValueOnce(CONFIG);
    rpc.status('tuya', true);
    await flush();

    expect(result.config.value).toBe(CONFIG);
    stop();
  });

  it('leaves no status listener behind once the scope ends', async () => {
    const rpc = fakeRpc();
    const { context } = fakeContext(rpc.client);
    const before = statusListeners.count;
    const { stop } = inContext(context, () => usePluginStorage('tuya'));
    await flush();
    expect(statusListeners.count).toBe(before + 1);
    stop();
    expect(statusListeners.count).toBe(before);

    rpc.status('tuya', true);
    await flush();

    expect(rpc.getConfig).toHaveBeenCalledTimes(1);
  });
});
