import { tryOnScopeDispose } from '@vueuse/core';
import { computed, ref, shallowRef, toValue, watch } from 'vue';

import { NamespaceManager } from '../server/index.js';
import { createDebouncedCache } from '../utils/createDebouncedCache.js';
import { useCameraUi } from './useCameraUi.js';
import { rpcCall } from './useRpc.js';

import type { Promisify, RPCClient } from '@camera.ui/rpc';
import type { BasePlugin, PluginContract, PluginInterfaces } from '@camera.ui/sdk';
import type { ComputedRef, MaybeRefOrGetter, Ref, ShallowRef } from 'vue';
import type { CoreManagerInterface } from '../server/index.js';

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

const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 30_000;

const pluginCache = createDebouncedCache<CachedPlugin>({
  releaseDelay: 1000,
});

const pendingLoads = new Map<string, Promise<CachedPlugin | undefined>>();
const instances = new Set<() => void>();

const reloaders = new Map<string, Set<() => void>>();
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const retryAttempts = new Map<string, number>();

let statusClient: RPCClient | undefined;
let statusUnsubscribe: (() => void) | undefined;

export function clearPluginCache(): void {
  pluginCache.clear();
  pendingLoads.clear();
  for (const reset of instances) {
    try {
      reset();
    } catch {
      // Each instance handles its own cleanup; one throwing must not stop
      // the rest from resetting.
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

function handleStatusMessage(message: PluginStatusMessage): void {
  if (message?.type !== 'pluginStatusChanged') return;

  const { pluginName, running } = message.data;
  if (!running) pluginCache.forceRelease(pluginName);

  stopRetry(pluginName);
  notifyReloaders(pluginName);
}

async function ensureStatusSubscription(rpc: Readonly<ShallowRef<RPCClient | undefined>>): Promise<void> {
  const client = rpc.value;
  if (!client || client === statusClient) return;

  statusUnsubscribe?.();
  statusUnsubscribe = undefined;
  statusClient = client;

  try {
    statusUnsubscribe = await client.subscribe<PluginStatusMessage>(NamespaceManager.coreManagerNamespaces().coreManagerSubject, handleStatusMessage);
  } catch {
    // the next load re-arms the subscription; the backoff carries the state
    // change in the meantime
    statusClient = undefined;
  }
}

export function usePlugin(pluginName: MaybeRefOrGetter<string>): UsePluginReturn {
  const { rpc, isConnected } = useCameraUi();

  const plugin = shallowRef<Promisify<BasePlugin & PluginInterfaces> | undefined>();
  const contract = ref<PluginContract | undefined>();
  const _isLoading = ref(false);
  const initialLoadDone = ref(false);
  const error = ref<Error | undefined>();

  let currentPluginName: string | undefined;
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
    pluginCache.release(name);
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
    if (name) void loadPlugin(name, true);
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
    plugin.value = cached.proxy;
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
    void ensureStatusSubscription(rpc);

    // the plugin went down: the cache entry is dropped while this instance
    // still holds its ref, so re-resolve instead of handing out the dead proxy
    if (currentPluginName === name && !pluginCache.has(name)) {
      currentPluginName = undefined;
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

      // a stopped, restarting or updating plugin answers nothing, so hand out
      // no proxy at all instead of one that fails every call
      if (pluginInfo.running === false) {
        return undefined;
      }

      const pluginNamespaces = NamespaceManager.pluginNamespaces(pluginInfo.id);
      const proxy = client.createProxy<BasePlugin & PluginInterfaces>(pluginNamespaces.pluginChildRpc);

      return {
        proxy,
        contract: pluginInfo.contract,
      };
    });

    pendingLoads.set(name, loadPromise);

    try {
      const result = await loadPromise;
      if (result) {
        pluginCache.acquire(name, () => result);
        if (toValue(pluginName) !== name) {
          pluginCache.release(name);
          return;
        }
        adopt(name, result);
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
      if (pluginCache.getRefCount(currentPluginName) <= 1) {
        pluginCache.forceRelease(currentPluginName);
      } else {
        pluginCache.release(currentPluginName);
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
  };
  instances.add(resetInstance);

  watch(
    [isConnected, () => toValue(pluginName), rpc],
    async ([connected, name, currentClient], oldValues) => {
      const prevClient = oldValues?.[2];
      // Identity-change on the underlying RPCClient (transport rebuild after
      // an endpoint swap) — release any cached proxy bound to the previous
      // client before re-acquiring against the new one. Without this, the
      // watch sees no change in [isConnected, pluginName] and the stale
      // proxy lingers.
      if (currentPluginName && prevClient && prevClient !== currentClient) {
        releasePlugin(currentPluginName);
        plugin.value = undefined;
        contract.value = undefined;
        currentPluginName = undefined;
      }
      if (connected && name && currentClient) {
        await loadPlugin(name);
      } else if ((!connected || !currentClient) && currentPluginName) {
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
