import { tryOnScopeDispose } from '@vueuse/core';
import { computed, ref, shallowRef, toValue, watch } from 'vue';

import { createDebouncedCache } from '../utils/createDebouncedCache.js';
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

const LOAD_RETRY_MIN_MS = 1_000;
const LOAD_RETRY_MAX_MS = 30_000;

export function clearCameraCache(): void {
  cameraCache.clear();
  pendingLoads.clear();
}

export async function acquireCameraDevice(
  deviceManager: { getCamera: (id: string) => Promise<ReactiveCameraDevice | undefined> },
  id: string,
): Promise<ReactiveCameraDevice | undefined> {
  if (cameraCache.has(id)) {
    return cameraCache.acquire(id, () => {
      throw new Error('Should not create - already cached');
    });
  }
  const pending = pendingLoads.get(id);
  if (pending) {
    const device = await pending;
    return device ? cameraCache.acquire(id, () => device) : undefined;
  }
  const loadPromise = deviceManager.getCamera(id);
  pendingLoads.set(id, loadPromise);
  try {
    const device = await loadPromise;
    return device ? cameraCache.acquire(id, () => device) : undefined;
  } finally {
    pendingLoads.delete(id);
  }
}

export function releaseCameraDevice(id: string): void {
  cameraCache.release(id);
}

export function reconnectAllCameraDevices(): void {
  cameraCache.forEachValue((device) => {
    device.reconnect().catch(() => {});
  });
}

export function useCameraById(cameraIdOrName: MaybeRefOrGetter<string>): UseCameraByIdReturn {
  const { isConnected } = useCameraUi();
  const deviceManager = useDeviceManager();

  const camera = shallowRef<ReactiveCameraDevice | undefined>();
  const _isLoading = ref(false);
  const initialLoadDone = ref(false);
  const error = ref<Error | undefined>();

  let currentCameraId: string | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryDelay = LOAD_RETRY_MIN_MS;
  let disposed = false;

  function bindCamera(id: string, device: ReactiveCameraDevice): void {
    currentCameraId = id;
    camera.value = device;
    error.value = undefined;
    cancelRetry();
  }

  function failLoad(id: string, err: unknown): void {
    error.value = err instanceof Error ? err : new Error(String(err));
    scheduleRetry(id);
  }

  function scheduleRetry(id: string): void {
    if (retryTimer || disposed) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      if (isConnected.value && toValue(cameraIdOrName) === id && currentCameraId !== id) loadCamera(id, true).catch(() => {});
    }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, LOAD_RETRY_MAX_MS);
  }

  function cancelRetry(): void {
    clearTimeout(retryTimer);
    retryTimer = undefined;
    retryDelay = LOAD_RETRY_MIN_MS;
  }

  // a retry runs quietly, the error of the failed attempt stays until one succeeds
  async function loadCamera(id: string, retry = false): Promise<void> {
    if (disposed || !isConnected.value || !id) return;

    if (currentCameraId && currentCameraId !== id) {
      cameraCache.release(currentCameraId);
      camera.value = undefined;
      currentCameraId = undefined;
    }

    if (cameraCache.has(id)) {
      const cached = cameraCache.acquire(id, () => {
        throw new Error('Should not create - already cached');
      });
      bindCamera(id, cached);
      initialLoadDone.value = true;
      return;
    }

    const pending = pendingLoads.get(id);
    if (pending) {
      if (!retry) _isLoading.value = true;
      try {
        const device = await pending;
        if (device && !disposed && cameraCache.has(id) && toValue(cameraIdOrName) === id) {
          const cached = cameraCache.acquire(id, () => device);
          bindCamera(id, cached);
        }
      } catch (err) {
        failLoad(id, err);
      } finally {
        _isLoading.value = false;
        initialLoadDone.value = true;
      }
      return;
    }

    if (!retry) {
      _isLoading.value = true;
      error.value = undefined;
    }

    const loadPromise = deviceManager.getCamera(id);
    pendingLoads.set(id, loadPromise);

    try {
      const device = await loadPromise;
      if (device) {
        cameraCache.acquire(id, () => device);
        if (disposed || toValue(cameraIdOrName) !== id) {
          cameraCache.release(id);
          return;
        }
        bindCamera(id, device);
      }
    } catch (err) {
      failLoad(id, err);
    } finally {
      pendingLoads.delete(id);
      _isLoading.value = false;
      initialLoadDone.value = true;
    }
  }

  async function refresh(): Promise<void> {
    const id = toValue(cameraIdOrName);
    if (!id) return;

    if (currentCameraId) {
      if (cameraCache.getRefCount(currentCameraId) <= 1) {
        cameraCache.forceRelease(currentCameraId);
      } else {
        cameraCache.release(currentCameraId);
      }
      camera.value = undefined;
      currentCameraId = undefined;
    }

    await loadCamera(id);
  }

  watch(
    [isConnected, () => toValue(cameraIdOrName)],
    async ([connected, id]) => {
      cancelRetry();
      if (connected && id) {
        await loadCamera(id);
      } else if (!connected && currentCameraId) {
        cameraCache.release(currentCameraId);
        camera.value = undefined;
        currentCameraId = undefined;
      }
    },
    { immediate: true },
  );

  tryOnScopeDispose(() => {
    disposed = true;
    cancelRetry();
    if (currentCameraId) {
      cameraCache.release(currentCameraId);
      camera.value = undefined;
      currentCameraId = undefined;
    }
  });

  return {
    camera,
    isLoading: computed(() => _isLoading.value || !initialLoadDone.value),
    error,
    refresh,
  };
}
