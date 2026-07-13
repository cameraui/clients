import { tryOnScopeDispose } from '@vueuse/core';
import { computed, ref, shallowRef, toValue, watch } from 'vue';

import { acquireCameraDevice, releaseCameraDevice } from './useCameraById.js';
import { useCameraUi } from './useCameraUi.js';
import { useDeviceManager } from './useDeviceManager.js';

import type { ComputedRef, MaybeRefOrGetter, ShallowRef } from 'vue';
import type { DBCamera } from '../server/index.js';

export interface UseSnapshotReturn {
  snapshot: ShallowRef<ArrayBuffer | undefined>;
  snapshotSrc: ComputedRef<string | undefined>;
  snapshotTimestamp: ComputedRef<number | undefined>;
  isLoading: ComputedRef<boolean>;
  refresh: () => Promise<void>;
}

const REVOKE_DELAY_MS = 5000;

const snapshotCache = new Map<string, ArrayBuffer>();
const timestampCache = new Map<string, number>();
const urlCache = new Map<string, string>();
const subscribers = new Map<string, Set<() => void>>();

function notify(cameraId: string): void {
  subscribers.get(cameraId)?.forEach((cb) => cb());
}

function deferRevoke(url: string): void {
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}

export function setSnapshot(cameraId: string, data: ArrayBuffer, fetchedAt?: number): void {
  // Buffer is being replaced — schedule revocation of the old blob URL so the
  // next read produces a fresh URL bound to the new bytes, but keep the old
  // URL valid long enough for any pending img fetches to complete.
  const oldUrl = urlCache.get(cameraId);
  if (oldUrl) {
    deferRevoke(oldUrl);
    urlCache.delete(cameraId);
  }
  snapshotCache.set(cameraId, data);
  // Without a known fetch time (e.g. legacy servers serving their TTL cache)
  // the previous stamp is left untouched — never guess Date.now().
  if (fetchedAt !== undefined) {
    timestampCache.set(cameraId, fetchedAt);
  }
  notify(cameraId);
}

export function getSnapshot(cameraId: string): ArrayBuffer | undefined {
  return snapshotCache.get(cameraId);
}

export function getSnapshotTimestamp(cameraId: string): number | undefined {
  return timestampCache.get(cameraId);
}

export function subscribeSnapshot(cameraId: string, cb: () => void): () => void {
  if (!subscribers.has(cameraId)) {
    subscribers.set(cameraId, new Set());
  }
  subscribers.get(cameraId)!.add(cb);
  return () => {
    subscribers.get(cameraId)?.delete(cb);
  };
}

export function getSnapshotUrl(cameraId: string): string | undefined {
  const buffer = snapshotCache.get(cameraId);
  if (!buffer) return undefined;
  let url = urlCache.get(cameraId);
  if (!url) {
    url = URL.createObjectURL(new Blob([buffer], { type: 'image/jpeg' }));
    urlCache.set(cameraId, url);
  }
  return url;
}

export function clearSnapshotCache(): void {
  for (const url of urlCache.values()) URL.revokeObjectURL(url);
  urlCache.clear();
  snapshotCache.clear();
  timestampCache.clear();
}

export function useSnapshot(cameraIdOrName: MaybeRefOrGetter<string | DBCamera>): UseSnapshotReturn {
  const { isConnected } = useCameraUi();
  const deviceManager = useDeviceManager();

  const snapshot = shallowRef<ArrayBuffer | undefined>();
  const _isLoading = ref(false);
  const initialLoadDone = ref(false);

  const snapshotSrc = computed(() => {
    // Touch `snapshot.value` for reactivity, then resolve via the cameraId
    // so consumers across the app share one blob URL per camera.
    if (!snapshot.value) return undefined;
    const idOrName = toValue(cameraIdOrName);
    const id = typeof idOrName === 'string' ? idOrName : idOrName._id;
    return getSnapshotUrl(id);
  });

  const snapshotTimestamp = computed(() => {
    if (!snapshot.value) return undefined;
    const idOrName = toValue(cameraIdOrName);
    const id = typeof idOrName === 'string' ? idOrName : idOrName._id;
    return timestampCache.get(id);
  });

  function subscribe(cameraId: string): () => void {
    if (!subscribers.has(cameraId)) {
      subscribers.set(cameraId, new Set());
    }
    const updateFn = (): void => {
      snapshot.value = snapshotCache.get(cameraId);
    };
    subscribers.get(cameraId)!.add(updateFn);
    return () => {
      subscribers.get(cameraId)?.delete(updateFn);
    };
  }

  let unsubscribe: (() => void) | undefined;
  let heldDeviceId: string | undefined;
  let pendingHoldId: string | undefined;

  // Hold the device for the composable's lifetime — closing it (refcount 0)
  // kills its `snapshot:updated` subscription, so server auto-refresh pushes
  // would never reach views that only render snapshots (e.g. the dashboard).
  async function holdDevice(id: string): Promise<void> {
    if (heldDeviceId === id || pendingHoldId === id) return;
    pendingHoldId = id;
    try {
      const device = await acquireCameraDevice(deviceManager, id);
      if (!device) return;

      const idOrName = toValue(cameraIdOrName);
      const currentId = typeof idOrName === 'string' ? idOrName : idOrName._id;
      if (currentId !== id || heldDeviceId === id) {
        releaseCameraDevice(id);
        return;
      }

      releaseHeldDevice();
      heldDeviceId = id;
    } catch {
      // Camera may be offline / RPC timeout — silently ignore
    } finally {
      pendingHoldId = undefined;
    }
  }

  function releaseHeldDevice(): void {
    if (heldDeviceId) {
      releaseCameraDevice(heldDeviceId);
      heldDeviceId = undefined;
    }
  }

  async function loadSnapshot(id: string): Promise<void> {
    if (!isConnected.value || !id) return;

    const cached = snapshotCache.get(id);
    if (cached) {
      snapshot.value = cached;
      initialLoadDone.value = true;
      return;
    }

    _isLoading.value = true;
    try {
      const device = await acquireCameraDevice(deviceManager, id);
      try {
        if (device) {
          const result = await device.fetchSnapshot();
          if (result) {
            // The fetch path already stamped the timestamp — don't touch it here.
            setSnapshot(id, result);
            snapshot.value = result;
          }
        }
      } finally {
        if (device) releaseCameraDevice(id);
      }
    } catch {
      // Camera may be offline / RPC timeout — silently ignore
    } finally {
      _isLoading.value = false;
      initialLoadDone.value = true;
    }
  }

  // Disabled cameras have no live stream — skip fetch entirely. Only works when
  // the caller passes a full DBCamera object; a bare id can't expose disabled
  // without a lookup, so it falls through to the normal fetch path.
  function isCameraDisabled(camOrId: string | DBCamera | undefined): boolean {
    return typeof camOrId === 'object' && camOrId?.disabled === true;
  }

  async function refresh(): Promise<void> {
    const cameraIdName = toValue(cameraIdOrName);
    const id = typeof cameraIdName === 'string' ? cameraIdName : cameraIdName._id;
    if (!id || !isConnected.value) return;
    if (isCameraDisabled(cameraIdName)) return;

    _isLoading.value = true;
    try {
      const device = await acquireCameraDevice(deviceManager, id);
      try {
        if (device) {
          const result = await device.fetchSnapshot(undefined, true);
          if (result) {
            setSnapshot(id, result);
            snapshot.value = result;
          }
        }
      } finally {
        if (device) releaseCameraDevice(id);
      }
    } catch {
      // Camera may be offline / RPC timeout — silently ignore
    } finally {
      _isLoading.value = false;
      initialLoadDone.value = true;
    }
  }

  watch(
    [isConnected, () => toValue(cameraIdOrName), () => isCameraDisabled(toValue(cameraIdOrName))],
    async ([connected, cameraIdName, disabled]) => {
      unsubscribe?.();
      unsubscribe = undefined;

      const id = typeof cameraIdName === 'string' ? cameraIdName : cameraIdName._id;

      if (connected && id && !disabled) {
        unsubscribe = subscribe(id);
        await holdDevice(id);
        await loadSnapshot(id);
      } else if (id) {
        // Disconnected OR disabled — keep cached snapshot visible (if any) but
        // don't trigger new fetches. The card's disabled overlay renders on top.
        releaseHeldDevice();
        snapshot.value = snapshotCache.get(id);
        initialLoadDone.value = true;
      } else {
        releaseHeldDevice();
        snapshot.value = undefined;
      }
    },
    { immediate: true },
  );

  tryOnScopeDispose(() => {
    unsubscribe?.();
    releaseHeldDevice();
  });

  return {
    snapshot,
    snapshotSrc,
    snapshotTimestamp,
    isLoading: computed(() => _isLoading.value || !initialLoadDone.value),
    refresh,
  };
}
