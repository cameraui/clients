import { tryOnScopeDispose } from '@vueuse/core';
import { computed, ref, shallowRef, toValue, watch } from 'vue';

import { createDebouncedCache } from '../utils/createDebouncedCache.js';
import { createRetryTimer } from '../utils/createRetryTimer.js';
import { useCameraUi } from './useCameraUi.js';
import { useDeviceManager } from './useDeviceManager.js';

import type { ComputedRef, MaybeRefOrGetter, Ref, ShallowRef } from 'vue';
import type { ReactiveCameraDevice } from '../types.js';

export interface UseCameraByIdReturn {
  camera: ShallowRef<ReactiveCameraDevice | undefined>;
  isLoading: ComputedRef<boolean>;
  error: Ref<Error | undefined>;
  refresh: () => Promise<void>;
}

const cameraCache = createDebouncedCache<ReactiveCameraDevice>({
  releaseDelay: 1000,
  onRelease: (_key, device) => device.close(),
});

const pendingLoads = new Map<string, Promise<ReactiveCameraDevice | undefined>>();
const knownNames = new Map<string, string>();

export function clearCameraCache(): void {
  cameraCache.clear();
  pendingLoads.clear();
  knownNames.clear();
}

export function rememberCameraName(name: string, id: string): void {
  if (name && id && name !== id) knownNames.set(name, id);
}

function cachedIdFor(key: string): string | undefined {
  if (cameraCache.has(key)) return key;
  let found: string | undefined;
  cameraCache.forEachValue((device, id) => {
    if (found === undefined && device.name.value === key) found = id;
  });
  return found;
}

function pendingLoadFor(key: string): Promise<ReactiveCameraDevice | undefined> | undefined {
  const own = pendingLoads.get(key);
  if (own) return own;
  for (const [name, id] of knownNames) {
    const other = id === key ? pendingLoads.get(name) : name === key ? pendingLoads.get(id) : undefined;
    if (other) return other;
  }
  return undefined;
}

function acquireCached(key: string): ReactiveCameraDevice | undefined {
  const id = cachedIdFor(key);
  if (id === undefined) return undefined;
  return cameraCache.acquire(id, () => {
    throw new Error('Should not create - already cached');
  });
}

// the caller holds one reference to the returned device and releases it with releaseCameraDevice
export async function acquireCameraDevice(
  deviceManager: { getCamera: (id: string) => Promise<ReactiveCameraDevice | undefined> },
  key: string,
): Promise<ReactiveCameraDevice | undefined> {
  const cached = acquireCached(key);
  if (cached) return cached;

  const pending = pendingLoadFor(key);
  if (pending) {
    const device = await pending;
    // the loader cached it; a hint that pointed to another camera falls through to a load of our own
    const joined = acquireCached(key);
    if (joined || !device) return joined;
  }

  const loadPromise = deviceManager.getCamera(key);
  pendingLoads.set(key, loadPromise);
  try {
    const device = await loadPromise;
    return device ? cacheLoadedDevice(device) : undefined;
  } finally {
    if (pendingLoads.get(key) === loadPromise) pendingLoads.delete(key);
  }
}

function cacheLoadedDevice(device: ReactiveCameraDevice): ReactiveCameraDevice {
  const held = cameraCache.acquire(device.id, () => device);
  if (held !== device) device.close();
  return held;
}

export function releaseCameraDevice(device: ReactiveCameraDevice): void {
  cameraCache.release(device.id, device);
}

export function reconnectAllCameraDevices(): void {
  cameraCache.forEachValue((device) => {
    device.reconnect().catch(() => {});
  });
}

export function refreshAllCameraDevices(): void {
  cameraCache.forEachValue((device) => {
    device.refreshStates().catch(() => device.reconnect().catch(() => {}));
  });
}

export function useCameraById(cameraIdOrName: MaybeRefOrGetter<string>): UseCameraByIdReturn {
  const { isConnected } = useCameraUi();
  const deviceManager = useDeviceManager();

  const camera = shallowRef<ReactiveCameraDevice | undefined>();
  const _isLoading = ref(false);
  const initialLoadDone = ref(false);
  const error = ref<Error | undefined>();

  // the name or id the bound device was loaded for
  let boundKey: string | undefined;
  const loadRetry = createRetryTimer();
  let disposed = false;

  function bindCamera(key: string, device: ReactiveCameraDevice): void {
    boundKey = key;
    camera.value = device;
    error.value = undefined;
    cancelRetry();
  }

  function unbindCamera(): void {
    if (camera.value) releaseCameraDevice(camera.value);
    camera.value = undefined;
    boundKey = undefined;
  }

  function failLoad(key: string, err: unknown): void {
    error.value = err instanceof Error ? err : new Error(String(err));
    scheduleRetry(key);
  }

  function scheduleRetry(key: string): void {
    if (disposed) return;
    loadRetry.schedule(() => {
      if (isConnected.value && toValue(cameraIdOrName) === key && boundKey !== key) loadCamera(key, true).catch(() => {});
    });
  }

  function cancelRetry(): void {
    loadRetry.cancel();
    loadRetry.reset();
  }

  async function loadCamera(key: string, retry = false): Promise<void> {
    if (disposed || !isConnected.value || !key) return;

    if (boundKey !== undefined && boundKey !== key) {
      // a renamed camera keeps its device under the new name
      if (camera.value && (camera.value.id === key || camera.value.name.value === key)) {
        boundKey = key;
        return;
      }
      unbindCamera();
    }
    if (camera.value) return;

    const cached = acquireCached(key);
    if (cached) {
      bindCamera(key, cached);
      initialLoadDone.value = true;
      return;
    }

    if (!retry) {
      _isLoading.value = true;
      error.value = undefined;
    }

    try {
      const device = await acquireCameraDevice(deviceManager, key);
      if (!device) return;
      if (disposed || toValue(cameraIdOrName) !== key || camera.value) {
        releaseCameraDevice(device);
        return;
      }
      bindCamera(key, device);
    } catch (err) {
      failLoad(key, err);
    } finally {
      _isLoading.value = false;
      initialLoadDone.value = true;
    }
  }

  async function refresh(): Promise<void> {
    const key = toValue(cameraIdOrName);
    if (!key) return;

    const device = camera.value;
    if (device) {
      if (cameraCache.get(device.id) === device && cameraCache.getRefCount(device.id) <= 1) {
        cameraCache.forceRelease(device.id);
      } else {
        releaseCameraDevice(device);
      }
      camera.value = undefined;
      boundKey = undefined;
    }

    await loadCamera(key);
  }

  watch(
    [isConnected, () => toValue(cameraIdOrName)],
    async ([connected, key]) => {
      cancelRetry();
      if (connected && key) {
        await loadCamera(key);
      } else if (!connected && boundKey !== undefined) {
        unbindCamera();
      }
    },
    { immediate: true },
  );

  tryOnScopeDispose(() => {
    disposed = true;
    cancelRetry();
    unbindCamera();
  });

  return {
    camera,
    isLoading: computed(() => _isLoading.value || !initialLoadDone.value),
    error,
    refresh,
  };
}
