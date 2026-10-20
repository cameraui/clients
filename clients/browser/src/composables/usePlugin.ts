import { tryOnScopeDispose } from '@vueuse/core';
import { computed, ref, shallowRef, toValue, watch } from 'vue';

import { NamespaceManager } from '../server/index.js';
import { createDebouncedCache } from '../utils/createDebouncedCache.js';
import { liveBulkClient, noticeBulkTimeout } from './bulkLane.js';
import { forgetPluginId } from './resolvePluginId.js';
import { useCameraUi } from './useCameraUi.js';
import { rpcCall } from './useRpc.js';

import type { Promisify, RPCClient } from '@camera.ui/rpc';
import type { BasePlugin, PluginContract, PluginInterfaces } from '@camera.ui/sdk';
import type { ComputedRef, MaybeRefOrGetter, Ref, ShallowRef } from 'vue';
import type { CoreManagerInterface } from '../server/index.js';

export interface UsePluginOptions {
  lane?: 'main' | 'bulk';
}

export interface UsePluginReturn {
  plugin: ShallowRef<Promisify<BasePlugin & PluginInterfaces> | undefined>;
  contract: Ref<PluginContract | undefined>;
  isLoading: ComputedRef<boolean>;
  error: Ref<Error | undefined>;
  refresh: () => Promise<void>;
}

interface CachedPlugin {
  proxy: Promisify<BasePlugin & PluginInterfaces>;
  contract: PluginContract | undefined;
  namespace: string;
  client: RPCClient;
  bulkProxy?: Promisify<BasePlugin & PluginInterfaces>;
}

interface HostPluginInfo {
  id: string;
  contract?: PluginContract;
  running?: boolean;
}

interface PluginStatusMessage {
  type: string;
  data: { pluginName: string; running: boolean };
}

type PluginStatusListener = (pluginName: string, running: boolean) => void;

const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 30_000;

const pluginCache = createDebouncedCache<CachedPlugin>({
  releaseDelay: 1000,
});

const pendingLoads = new Map<string, Promise<CachedPlugin | undefined>>();
const pendingChecks = new Map<string, Promise<void>>();
const instances = new Set<() => void>();
const statusListeners = new Set<PluginStatusListener>();
const pluginRunning = new Map<string, boolean>();

const reloaders = new Map<string, Set<() => void>>();
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const retryAttempts = new Map<string, number>();

let statusClient: RPCClient | undefined;
let statusUnsubscribe: (() => void) | undefined;

export function clearPluginCache(): void {
  pluginCache.clear();
  pendingLoads.clear();
  pendingChecks.clear();
  forgetPluginStatus();
  for (const reset of instances) {
    try {
      reset();
    } catch {
      // one instance throwing must not stop the rest from resetting
    }
  }
}

function notifyReloaders(name: string): void {
  for (const reload of [...(reloaders.get(name) ?? [])]) {
    reload();
  }
}

function stopRetry(name: string): void {
  const timer = retryTimers.get(name);
  if (timer) clearTimeout(timer);
  retryTimers.delete(name);
  retryAttempts.delete(name);
}

function scheduleRetry(name: string): void {
  if (retryTimers.has(name)) return;

  const attempt = retryAttempts.get(name) ?? 0;
  retryAttempts.set(name, attempt + 1);

  const timer = setTimeout(
    () => {
      retryTimers.delete(name);
      notifyReloaders(name);
    },
    Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS),
  );

  retryTimers.set(name, timer);
}

export function onPluginStatus(listener: PluginStatusListener): () => void {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}

export function isPluginStopped(pluginName: string): boolean {
  return pluginRunning.get(pluginName) === false;
}

export function forgetPluginStatus(): void {
  pluginRunning.clear();
}

function applyStatus(pluginName: string, running: boolean, stale = !running): void {
  pluginRunning.set(pluginName, running);
  if (stale) {
    pluginCache.forceRelease(pluginName);
    // a reinstalled plugin comes back under a new id
    forgetPluginId(pluginName);
  }

  stopRetry(pluginName);
  notifyReloaders(pluginName);
  for (const listener of [...statusListeners]) {
    try {
      listener(pluginName, running);
    } catch {
      // one listener must not keep the others from the status
    }
  }
}

function handleStatusMessage(message: PluginStatusMessage): void {
  if (message?.type !== 'pluginStatusChanged') return;
  applyStatus(message.data.pluginName, message.data.running);
}

function checkPlugin(name: string, rpc: Readonly<ShallowRef<RPCClient | undefined>>): void {
  const cached = pluginCache.get(name);
  if (!cached || pendingChecks.has(name)) return;

  const check = rpcCall(rpc, (client) => client.createProxy<CoreManagerInterface>(NamespaceManager.coreManagerNamespaces().coreManagerRpc).getPlugin(name))
    .then((info) => {
      const pluginInfo = info as HostPluginInfo | undefined;
      if (pluginCache.get(name) !== cached) return;
      const running = !!pluginInfo && pluginInfo.running !== false;
      const moved = running && NamespaceManager.pluginNamespaces(pluginInfo.id).pluginChildRpc !== cached.namespace;
      if (running && !moved) return;
      applyStatus(name, running, true);
    })
    .catch(() => {})
    .finally(() => {
      if (pendingChecks.get(name) === check) pendingChecks.delete(name);
    });
  pendingChecks.set(name, check);
}

function createLaneProxy(
  namespace: string,
  main: Promisify<BasePlugin & PluginInterfaces>,
  lane: Readonly<ShallowRef<RPCClient | undefined>>,
): Promisify<BasePlugin & PluginInterfaces> {
  const proxies = new WeakMap<RPCClient, Promisify<BasePlugin & PluginInterfaces>>();
  return new Proxy(main, {
    get(_target, prop) {
      const client = liveBulkClient(lane);
      if (!client) return Reflect.get(main, prop);
      let proxy = proxies.get(client);
      if (!proxy) {
        proxy = client.createProxy<BasePlugin & PluginInterfaces>(namespace);
        proxies.set(client, proxy);
      }
      const member: unknown = Reflect.get(proxy, prop);
      return typeof member === 'function' ? watchTimeouts(member, lane, client) : member;
    },
  });
}

function watchTimeouts<T extends object>(member: T, lane: Readonly<ShallowRef<RPCClient | undefined>>, client: RPCClient): T {
  return new Proxy(member, {
    apply(target, thisArg, args) {
      const result: unknown = Reflect.apply(target as (...args: unknown[]) => unknown, thisArg, args);
      if (!(result instanceof Promise)) return result;
      return result.catch((err: unknown) => {
        if ((err as { code?: unknown } | null)?.code === 'TIMEOUT') noticeBulkTimeout(lane, client);
        throw err;
      });
    },
  });
}

export async function ensureStatusSubscription(rpc: Readonly<ShallowRef<RPCClient | undefined>>): Promise<void> {
  const client = rpc.value;
  if (!client || client === statusClient) return;

  statusUnsubscribe?.();
  statusUnsubscribe = undefined;
  statusClient = client;

  try {
    statusUnsubscribe = await client.subscribe<PluginStatusMessage>(NamespaceManager.coreManagerNamespaces().coreManagerSubject, handleStatusMessage);
  } catch {
    // the next load re-arms the subscription, the backoff carries the state change meanwhile
    statusClient = undefined;
  }
}

export function usePlugin(pluginName: MaybeRefOrGetter<string>, options: UsePluginOptions = {}): UsePluginReturn {
  const ctx = useCameraUi();
  const { rpc, bulkRpc, isConnected } = ctx;
  const lane = options.lane === 'bulk' ? bulkRpc : undefined;

  const plugin = shallowRef<Promisify<BasePlugin & PluginInterfaces> | undefined>();
  const contract = ref<PluginContract | undefined>();
  const _isLoading = ref(false);
  const initialLoadDone = ref(false);
  const error = ref<Error | undefined>();

  let currentPluginName: string | undefined;
  let heldPlugin: CachedPlugin | undefined;
  let watchedName: string | undefined;

  function acquirePlugin(name: string): CachedPlugin | undefined {
    if (pluginCache.has(name)) {
      return pluginCache.acquire(name, () => {
        throw new Error('Should not create - already cached');
      });
    }
    return undefined;
  }

  function releasePlugin(name: string): void {
    pluginCache.release(name, heldPlugin);
    heldPlugin = undefined;
  }

  function watchPlugin(name: string): void {
    if (watchedName === name) return;
    if (watchedName) unwatchPlugin(watchedName);

    const set = reloaders.get(name) ?? new Set();
    set.add(reload);
    reloaders.set(name, set);
    watchedName = name;
  }

  function unwatchPlugin(name: string): void {
    const set = reloaders.get(name);
    if (set) {
      set.delete(reload);
      if (set.size === 0) {
        reloaders.delete(name);
        stopRetry(name);
      }
    }
    if (watchedName === name) watchedName = undefined;
  }

  function reload(): void {
    const name = toValue(pluginName);
    if (name) loadPlugin(name, true);
  }

  function markUnavailable(name: string): void {
    if (currentPluginName) {
      releasePlugin(currentPluginName);
      currentPluginName = undefined;
    }
    plugin.value = undefined;
    contract.value = undefined;
    scheduleRetry(name);
  }

  function adopt(name: string, cached: CachedPlugin): void {
    currentPluginName = name;
    heldPlugin = cached;
    if (lane) cached.bulkProxy ??= createLaneProxy(cached.namespace, cached.proxy, lane);
    plugin.value = lane ? cached.bulkProxy : cached.proxy;
    contract.value = cached.contract;
    error.value = undefined;
    stopRetry(name);
  }

  async function loadPlugin(name: string, silent = false): Promise<void> {
    if (!isConnected.value || !name) return;

    if (currentPluginName && currentPluginName !== name) {
      unwatchPlugin(currentPluginName);
      releasePlugin(currentPluginName);
      plugin.value = undefined;
      contract.value = undefined;
      currentPluginName = undefined;
    }

    watchPlugin(name);
    ensureStatusSubscription(rpc);

    // the plugin went down and its cache entry is gone, re-resolve instead of handing out the dead proxy
    if (currentPluginName === name && pluginCache.get(name) !== heldPlugin) {
      currentPluginName = undefined;
      heldPlugin = undefined;
      plugin.value = undefined;
      contract.value = undefined;
    } else if (currentPluginName === name && plugin.value) {
      return;
    }

    const cached = acquirePlugin(name);
    if (cached) {
      adopt(name, cached);
      initialLoadDone.value = true;
      return;
    }

    const pending = pendingLoads.get(name);
    if (pending) {
      if (!silent) _isLoading.value = true;
      try {
        const result = await pending;
        if (toValue(pluginName) !== name) return;
        if (result) {
          const cachedAfterPending = acquirePlugin(name);
          if (cachedAfterPending) adopt(name, cachedAfterPending);
        } else {
          markUnavailable(name);
        }
      } catch (err) {
        if (!silent) error.value = err instanceof Error ? err : new Error(String(err));
        markUnavailable(name);
      } finally {
        if (!silent) _isLoading.value = false;
        initialLoadDone.value = true;
      }
      return;
    }

    if (!silent) {
      _isLoading.value = true;
      error.value = undefined;
    }

    const loadPromise = rpcCall(rpc, async (client): Promise<CachedPlugin | undefined> => {
      const coreNamespaces = NamespaceManager.coreManagerNamespaces();
      const pluginInfo = (await client.createProxy<CoreManagerInterface>(coreNamespaces.coreManagerRpc).getPlugin(name)) as HostPluginInfo | undefined;

      if (!pluginInfo) {
        throw new Error(`Plugin "${name}" not found`);
      }

      // a stopped, restarting or updating plugin answers nothing, a proxy would fail every call
      if (pluginInfo.running === false) {
        return undefined;
      }

      const namespace = NamespaceManager.pluginNamespaces(pluginInfo.id).pluginChildRpc;
      const proxy = client.createProxy<BasePlugin & PluginInterfaces>(namespace);

      return {
        proxy,
        contract: pluginInfo.contract,
        namespace,
        client,
      };
    });

    pendingLoads.set(name, loadPromise);

    try {
      const result = await loadPromise;
      pluginRunning.set(name, !!result);
      if (result) {
        const held = pluginCache.acquire(name, () => result);
        if (toValue(pluginName) !== name) {
          pluginCache.release(name, held);
          return;
        }
        adopt(name, held);
      } else if (toValue(pluginName) === name) {
        markUnavailable(name);
      }
    } catch (err) {
      if (!silent) error.value = err instanceof Error ? err : new Error(String(err));
      markUnavailable(name);
    } finally {
      pendingLoads.delete(name);
      if (!silent) _isLoading.value = false;
      initialLoadDone.value = true;
    }
  }

  async function refresh(): Promise<void> {
    const name = toValue(pluginName);
    if (!name) return;

    if (currentPluginName) {
      if (pluginCache.get(currentPluginName) === heldPlugin && pluginCache.getRefCount(currentPluginName) <= 1) {
        pluginCache.forceRelease(currentPluginName);
        heldPlugin = undefined;
      } else {
        releasePlugin(currentPluginName);
      }
      plugin.value = undefined;
      contract.value = undefined;
      currentPluginName = undefined;
    }

    await loadPlugin(name);
  }

  const resetInstance = (): void => {
    if (!currentPluginName) return;
    plugin.value = undefined;
    contract.value = undefined;
    currentPluginName = undefined;
    heldPlugin = undefined;
  };
  instances.add(resetInstance);

  function onReconnected(): void {
    if (currentPluginName) checkPlugin(currentPluginName, rpc);
  }
  ctx.on('reconnected', onReconnected);

  watch(
    [isConnected, () => toValue(pluginName), rpc],
    async ([connected, name, currentClient]) => {
      // a short drop brings the same client back and its proxies keep working, a proxy from another client answers nothing
      const renamed = !!currentPluginName && name !== currentPluginName;
      if (currentPluginName && (renamed || (currentClient && heldPlugin && heldPlugin.client !== currentClient))) {
        if (renamed) unwatchPlugin(currentPluginName);
        releasePlugin(currentPluginName);
        plugin.value = undefined;
        contract.value = undefined;
        currentPluginName = undefined;
      }
      if (connected && name && currentClient) {
        await loadPlugin(name);
      } else if (!connected && currentPluginName) {
        unwatchPlugin(currentPluginName);
        releasePlugin(currentPluginName);
        plugin.value = undefined;
        contract.value = undefined;
        currentPluginName = undefined;
      }
    },
    { immediate: true },
  );

  tryOnScopeDispose(() => {
    instances.delete(resetInstance);
    ctx.off('reconnected', onReconnected);
    unwatchPlugin(toValue(pluginName));
    if (currentPluginName) {
      unwatchPlugin(currentPluginName);
      releasePlugin(currentPluginName);
      plugin.value = undefined;
      contract.value = undefined;
      currentPluginName = undefined;
    }
  });

  return {
    plugin,
    contract,
    isLoading: computed(() => _isLoading.value || !initialLoadDone.value),
    error,
    refresh,
  };
}
