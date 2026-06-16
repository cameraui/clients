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

export function clearCameraCache(): void {
  cameraCache.clear();
  pendingLoads.clear();
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

  async function loadCamera(id: string): Promise<void> {
    if (!isConnected.value || !id) return;

    if (currentCameraId && currentCameraId !== id) {
      cameraCache.release(currentCameraId);
      camera.value = undefined;
      currentCameraId = undefined;
    }

    if (cameraCache.has(id)) {
      const cached = cameraCache.acquire(id, () => {
        throw new Error('Should not create - already cached');
      });
      currentCameraId = id;
      camera.value = cached;
      initialLoadDone.value = true;
      return;
    }

    const pending = pendingLoads.get(id);
    if (pending) {
      _isLoading.value = true;
      try {
        const device = await pending;
        if (device && cameraCache.has(id)) {
          const cached = cameraCache.acquire(id, () => device);
          currentCameraId = id;
          camera.value = cached;
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

    const loadPromise = deviceManager.getCamera(id);
    pendingLoads.set(id, loadPromise);

    try {
      const device = await loadPromise;
      if (device) {
        cameraCache.acquire(id, () => device);
        currentCameraId = id;
        camera.value = device;
      }
    } catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err));
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
