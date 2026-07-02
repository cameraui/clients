import { tryOnScopeDispose } from '@vueuse/core';
import { computed, ref, shallowRef, toValue, watch } from 'vue';

import { NamespaceManager } from '../server/index.js';
import { createDebouncedCache } from '../utils/createDebouncedCache.js';
import { useCameraUi } from './useCameraUi.js';
import { rpcCall } from './useRpc.js';

import type { Promisify } from '@camera.ui/rpc';
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

const pluginCache = createDebouncedCache<CachedPlugin>({
  releaseDelay: 1000,
});

const pendingLoads = new Map<string, Promise<CachedPlugin | undefined>>();
const instances = new Set<() => void>();

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

export function usePlugin(pluginName: MaybeRefOrGetter<string>): UsePluginReturn {
  const { rpc, isConnected } = useCameraUi();

  const plugin = shallowRef<Promisify<BasePlugin & PluginInterfaces> | undefined>();
  const contract = ref<PluginContract | undefined>();
  const _isLoading = ref(false);
  const initialLoadDone = ref(false);
  const error = ref<Error | undefined>();

  let currentPluginName: string | undefined;

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

  async function loadPlugin(name: string): Promise<void> {
    if (!isConnected.value || !name) return;

    if (currentPluginName && currentPluginName !== name) {
      releasePlugin(currentPluginName);
      plugin.value = undefined;
      contract.value = undefined;
      currentPluginName = undefined;
    }

    const cached = acquirePlugin(name);
    if (cached) {
      currentPluginName = name;
      plugin.value = cached.proxy;
      contract.value = cached.contract;
      initialLoadDone.value = true;
      return;
    }

    const pending = pendingLoads.get(name);
    if (pending) {
      _isLoading.value = true;
      try {
        const result = await pending;
        if (result && toValue(pluginName) === name) {
          const cachedAfterPending = acquirePlugin(name);
          if (cachedAfterPending) {
            currentPluginName = name;
            plugin.value = cachedAfterPending.proxy;
            contract.value = cachedAfterPending.contract;
          }
        }
      } catch (err) {
        error.value = err instanceof Error ? err : new Error(String(err));
      } finally {
        _isLoading.value = false;
        initialLoadDone.value = true;
      }
      return;
    }

    _isLoading.value = true;
    error.value = undefined;

    const loadPromise = rpcCall(rpc, async (client): Promise<CachedPlugin | undefined> => {
      const coreNamespaces = NamespaceManager.coreManagerNamespaces();
      const pluginInfo = await client.createProxy<CoreManagerInterface>(coreNamespaces.coreManagerRpc).getPlugin(name);

      if (!pluginInfo) {
        throw new Error(`Plugin "${name}" not found`);
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
        currentPluginName = name;
        plugin.value = result.proxy;
        contract.value = result.contract;
      }
    } catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err));
      plugin.value = undefined;
      contract.value = undefined;
    } finally {
      pendingLoads.delete(name);
      _isLoading.value = false;
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
    if (currentPluginName) {
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
