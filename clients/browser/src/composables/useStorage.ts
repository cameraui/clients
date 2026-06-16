import { tryOnScopeDispose } from '@vueuse/core';
import { computed, ref, shallowRef, toValue, watch } from 'vue';

import { NamespaceManager } from '../server/index.js';
import { createDebouncedCache } from '../utils/createDebouncedCache.js';
import { clearPluginIdCache, resolvePluginId } from './resolvePluginId.js';
import { useCameraUi } from './useCameraUi.js';
import { extractCameraId } from './utils.js';

import type { Promisify } from '@camera.ui/rpc';
import type { FormSubmitResponse, SchemaConfig } from '@camera.ui/sdk';
import type { ComputedRef, MaybeRefOrGetter, Ref, ShallowRef } from 'vue';
import type { CameraIdentifier } from './utils.js';

export interface StorageRPC {
  getValue<T = string>(key: string, defaultValue?: T): Promise<T | undefined>;
  setValue<T = string>(key: string, newValue: T): Promise<void>;
  submitValue(key: string, newValue: unknown): Promise<FormSubmitResponse | void>;
  hasValue(key: string): boolean;
  getConfig(): Promise<SchemaConfig>;
  setConfig(newConfig: Record<string, unknown>): Promise<void>;
  getSchema<T>(key: string): T | undefined;
  hasSchema(key: string): boolean;
}

export interface ReactiveStorage {
  readonly proxy: Promisify<StorageRPC>;
  readonly config: ShallowRef<SchemaConfig | undefined>;
  readonly isLoading: Ref<boolean>;
  readonly error: Ref<Error | undefined>;
  getConfig(): Promise<SchemaConfig | undefined>;
  setValue<T = unknown>(key: string, value: T): Promise<void>;
  setConfig(newConfig: Record<string, unknown>): Promise<void>;
  submitValue(key: string, value: unknown): Promise<FormSubmitResponse | void>;
}

export interface UseStorageReturn {
  config: ShallowRef<SchemaConfig | undefined>;
  isLoading: ComputedRef<boolean>;
  error: Ref<Error | undefined>;
  getConfig(): Promise<SchemaConfig | undefined>;
  setValue<T = unknown>(key: string, value: T): Promise<void>;
  setConfig(newConfig: Record<string, unknown>): Promise<void>;
  submitValue(key: string, value: unknown): Promise<FormSubmitResponse | void>;
  isConnected: Ref<boolean>;
}

function createReactiveStorage(proxy: Promisify<StorageRPC>): ReactiveStorage {
  const config = shallowRef<SchemaConfig | undefined>();
  const isLoading = ref(false);
  const error = ref<Error | undefined>();

  async function getConfig(): Promise<SchemaConfig | undefined> {
    isLoading.value = true;
    error.value = undefined;

    try {
      config.value = await proxy.getConfig();
      return config.value;
    } catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err));
      return undefined;
    } finally {
      isLoading.value = false;
    }
  }

  async function setValue<T = unknown>(key: string, value: T): Promise<void> {
    isLoading.value = true;
    error.value = undefined;

    try {
      await proxy.setValue(key, value);
      await getConfig();
    } catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err));
      throw err;
    } finally {
      isLoading.value = false;
    }
  }

  async function setConfig(newConfig: Record<string, unknown>): Promise<void> {
    isLoading.value = true;
    error.value = undefined;

    try {
      await proxy.setConfig(newConfig);
      await getConfig();
    } catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err));
      throw err;
    } finally {
      isLoading.value = false;
    }
  }

  async function submitValue(key: string, value: unknown): Promise<FormSubmitResponse | void> {
    isLoading.value = true;
    error.value = undefined;

    try {
      const response = await proxy.submitValue(key, value);

      if (!response?.toast || response.toast.type !== 'error') {
        await getConfig();
      }

      return response;
    } catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err));
      throw err;
    } finally {
      isLoading.value = false;
    }
  }

  return {
    proxy,
    config,
    isLoading,
    error,
    getConfig,
    setValue,
    setConfig,
    submitValue,
  };
}

const storageCache = createDebouncedCache<ReactiveStorage>({
  releaseDelay: 1000,
});

function getPluginStorageKey(pluginId: string): string {
  return `plugin:${pluginId}`;
}

function getCameraStorageKey(pluginId: string, cameraId: string): string {
  return `plugin:${pluginId}:camera:${cameraId}`;
}

function getSensorStorageKey(pluginId: string, cameraId: string, sensorId: string): string {
  return `plugin:${pluginId}:camera:${cameraId}:sensor:${sensorId}`;
}

function acquireStorage(key: string, createProxy: () => Promisify<StorageRPC>): ReactiveStorage {
  return storageCache.acquire(key, () => {
    const proxy = createProxy();
    return createReactiveStorage(proxy);
  });
}

function releaseStorage(key: string): void {
  storageCache.release(key);
}

export function clearStorageCache(): void {
  storageCache.clear();
  clearPluginIdCache();
}

interface StorageComposableState {
  currentStorageKey: string | undefined;
  cachedStorage: ReactiveStorage | undefined;
}

function createStorageState(): StorageComposableState {
  return {
    currentStorageKey: undefined,
    cachedStorage: undefined,
  };
}

function cleanupStorage(state: StorageComposableState, isConnected: Ref<boolean>, config: ShallowRef<SchemaConfig | undefined>): void {
  if (state.currentStorageKey) {
    releaseStorage(state.currentStorageKey);
    state.currentStorageKey = undefined;
  }
  isConnected.value = false;
  state.cachedStorage = undefined;
  config.value = undefined;
}

function createStorageOperations(state: StorageComposableState, config: ShallowRef<SchemaConfig | undefined>, isLoading: Ref<boolean>, error: Ref<Error | undefined>) {
  async function getConfig(): Promise<SchemaConfig | undefined> {
    const cached = state.cachedStorage;
    if (!cached) return undefined;

    const result = await cached.getConfig();
    if (state.cachedStorage !== cached) return result;

    config.value = cached.config.value;
    isLoading.value = cached.isLoading.value;
    error.value = cached.error.value;
    return result;
  }

  async function setValue<T = unknown>(key: string, value: T): Promise<void> {
    const cached = state.cachedStorage;
    if (!cached) {
      throw new Error('Storage not connected');
    }

    isLoading.value = true;
    error.value = undefined;

    try {
      await cached.setValue(key, value);
      if (state.cachedStorage === cached) {
        config.value = cached.config.value;
      }
    } catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err));
      throw err;
    } finally {
      isLoading.value = false;
    }
  }

  async function setConfig(newConfig: Record<string, unknown>): Promise<void> {
    const cached = state.cachedStorage;
    if (!cached) {
      throw new Error('Storage not connected');
    }

    isLoading.value = true;
    error.value = undefined;

    try {
      await cached.setConfig(newConfig);
      if (state.cachedStorage === cached) {
        config.value = cached.config.value;
      }
    } catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err));
      throw err;
    } finally {
      isLoading.value = false;
    }
  }

  async function submitValue(key: string, value: unknown): Promise<FormSubmitResponse | void> {
    const cached = state.cachedStorage;
    if (!cached) {
      throw new Error('Storage not connected');
    }

    isLoading.value = true;
    error.value = undefined;

    try {
      const result = await cached.submitValue(key, value);
      if (state.cachedStorage === cached) {
        config.value = cached.config.value;
      }
      return result;
    } catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err));
      throw err;
    } finally {
      isLoading.value = false;
    }
  }

  return { getConfig, setValue, setConfig, submitValue };
}

export function usePluginStorage(pluginName: MaybeRefOrGetter<string>): UseStorageReturn {
  const { rpc, isConnected: clientConnected } = useCameraUi();

  const config = shallowRef<SchemaConfig | undefined>();
  const _isLoading = ref(false);
  const initialSetupDone = ref(false);
  const error = ref<Error | undefined>();
  const isConnected = ref(false);
  const state = createStorageState();

  const operations = createStorageOperations(state, config, _isLoading, error);

  async function connect(name: string): Promise<boolean> {
    if (!rpc.value || !clientConnected.value) return false;

    try {
      const pluginId = await resolvePluginId(rpc, name);
      if (!pluginId) {
        throw new Error(`Plugin "${name}" not found`);
      }

      const storageKey = getPluginStorageKey(pluginId);

      if (state.currentStorageKey && state.currentStorageKey !== storageKey) {
        releaseStorage(state.currentStorageKey);
      }

      state.currentStorageKey = storageKey;
      state.cachedStorage = acquireStorage(storageKey, () => {
        const namespaces = NamespaceManager.pluginNamespaces(pluginId);
        return rpc.value!.createProxy<StorageRPC>(namespaces.pluginStorageRpc);
      });

      isConnected.value = true;
      return true;
    } catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err));
      isConnected.value = false;
      return false;
    }
  }

  async function getConfig(): Promise<SchemaConfig | undefined> {
    if (!state.cachedStorage) {
      const name = toValue(pluginName);
      if (!name) return undefined;
      const connected = await connect(name);
      if (!connected) return undefined;
    }
    return operations.getConfig();
  }

  watch(
    [clientConnected, () => toValue(pluginName)],
    async ([connected, name]) => {
      if (connected && name) {
        await connect(name);
        // Auto-fetch config when storage connects with new params
        operations.getConfig();
      } else {
        cleanupStorage(state, isConnected, config);
      }
      initialSetupDone.value = true;
    },
    { immediate: true },
  );

  tryOnScopeDispose(() => cleanupStorage(state, isConnected, config));

  return {
    config,
    isLoading: computed(() => _isLoading.value || !initialSetupDone.value),
    error,
    isConnected,
    getConfig,
    setValue: operations.setValue,
    setConfig: operations.setConfig,
    submitValue: operations.submitValue,
  };
}

export function useCameraStorage(camera: CameraIdentifier, pluginName: MaybeRefOrGetter<string>): UseStorageReturn {
  const { rpc, isConnected: clientConnected } = useCameraUi();

  const config = shallowRef<SchemaConfig | undefined>();
  const _isLoading = ref(false);
  const initialSetupDone = ref(false);
  const error = ref<Error | undefined>();
  const isConnected = ref(false);
  const state = createStorageState();

  const operations = createStorageOperations(state, config, _isLoading, error);

  async function connect(cameraId: string, name: string): Promise<boolean> {
    if (!rpc.value || !clientConnected.value) return false;

    try {
      const pluginId = await resolvePluginId(rpc, name);
      if (!pluginId) {
        throw new Error(`Plugin "${name}" not found`);
      }

      const storageKey = getCameraStorageKey(pluginId, cameraId);

      if (state.currentStorageKey && state.currentStorageKey !== storageKey) {
        releaseStorage(state.currentStorageKey);
      }

      state.currentStorageKey = storageKey;
      state.cachedStorage = acquireStorage(storageKey, () => {
        const namespaces = NamespaceManager.pluginCameraNamespaces(pluginId, cameraId);
        return rpc.value!.createProxy<StorageRPC>(namespaces.cameraStorageRpc);
      });

      isConnected.value = true;
      return true;
    } catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err));
      isConnected.value = false;
      return false;
    }
  }

  async function getConfig(): Promise<SchemaConfig | undefined> {
    const cameraId = extractCameraId(toValue(camera));
    const name = toValue(pluginName);

    if (!cameraId || !name) return undefined;

    if (!state.cachedStorage) {
      const connected = await connect(cameraId, name);
      if (!connected) return undefined;
    }

    return operations.getConfig();
  }

  watch(
    [clientConnected, () => extractCameraId(toValue(camera)), () => toValue(pluginName)],
    async ([connected, cameraId, name]) => {
      if (connected && cameraId && name) {
        await connect(cameraId, name);
        // Auto-fetch config when storage connects with new params
        operations.getConfig();
      } else {
        cleanupStorage(state, isConnected, config);
      }
      initialSetupDone.value = true;
    },
    { immediate: true },
  );

  tryOnScopeDispose(() => cleanupStorage(state, isConnected, config));

  return {
    config,
    isLoading: computed(() => _isLoading.value || !initialSetupDone.value),
    error,
    isConnected,
    getConfig,
    setValue: operations.setValue,
    setConfig: operations.setConfig,
    submitValue: operations.submitValue,
  };
}

export function useSensorStorage(
  camera: CameraIdentifier,
  sensorId: MaybeRefOrGetter<string | undefined>,
  pluginId: MaybeRefOrGetter<string | undefined>,
): UseStorageReturn {
  const { rpc, isConnected: clientConnected } = useCameraUi();

  const config = shallowRef<SchemaConfig | undefined>();
  const _isLoading = ref(false);
  const initialSetupDone = ref(false);
  const error = ref<Error | undefined>();
  const isConnected = ref(false);
  const state = createStorageState();

  const operations = createStorageOperations(state, config, _isLoading, error);

  function connect(cameraId: string, senId: string, plugId: string): boolean {
    if (!rpc.value || !clientConnected.value) return false;

    try {
      const storageKey = getSensorStorageKey(plugId, cameraId, senId);

      if (state.currentStorageKey && state.currentStorageKey !== storageKey) {
        releaseStorage(state.currentStorageKey);
      }

      state.currentStorageKey = storageKey;
      state.cachedStorage = acquireStorage(storageKey, () => {
        const namespaces = NamespaceManager.pluginSensorNamespaces(plugId, cameraId, senId);
        return rpc.value!.createProxy<StorageRPC>(namespaces.sensorStorageRpc);
      });

      isConnected.value = true;
      return true;
    } catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err));
      isConnected.value = false;
      return false;
    }
  }

  async function getConfig(): Promise<SchemaConfig | undefined> {
    const cameraId = extractCameraId(toValue(camera));
    const senId = toValue(sensorId);
    const plugId = toValue(pluginId);

    if (!cameraId || !senId || !plugId) return undefined;

    if (!state.cachedStorage) {
      const connected = connect(cameraId, senId, plugId);
      if (!connected) return undefined;
    }

    return operations.getConfig();
  }

  watch(
    [clientConnected, () => extractCameraId(toValue(camera)), () => toValue(sensorId), () => toValue(pluginId)],
    ([connected, cameraId, senId, plugId]) => {
      if (connected && cameraId && senId && plugId) {
        connect(cameraId, senId, plugId);
        // Auto-fetch config when storage connects with new params
        operations.getConfig();
      } else {
        cleanupStorage(state, isConnected, config);
      }
      initialSetupDone.value = true;
    },
    { immediate: true },
  );

  tryOnScopeDispose(() => cleanupStorage(state, isConnected, config));

  return {
    config,
    isLoading: computed(() => _isLoading.value || !initialSetupDone.value),
    error,
    isConnected,
    getConfig,
    setValue: operations.setValue,
    setConfig: operations.setConfig,
    submitValue: operations.submitValue,
  };
}
