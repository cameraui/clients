import { tryOnScopeDispose } from '@vueuse/core';
import { computed, ref, shallowRef, toValue, watch } from 'vue';

import { createRetryTimer } from '../utils/createRetryTimer.js';
import { acquireCameraDevice, releaseCameraDevice, rememberCameraName } from './useCameraById.js';
import { useCameraUi } from './useCameraUi.js';
import { useDeviceManager } from './useDeviceManager.js';

import type { ComputedRef, MaybeRefOrGetter, ShallowRef } from 'vue';
import type { DBCamera } from '../server/index.js';
import type { ReactiveCameraDevice } from '../types.js';

export interface SnapshotStamp {
  sourceId: string;
  fetchedAt: number;
}

export interface UseSnapshotReturn {
  snapshot: ShallowRef<ArrayBuffer | undefined>;
  snapshotSrc: ComputedRef<string | undefined>;
  snapshotTimestamp: ComputedRef<number | undefined>;
  isLoading: ComputedRef<boolean>;
  refresh: () => Promise<void>;
}

const REVOKE_DELAY_MS = 5000;
const SERVER_CLOCK_STEP_MS = 60_000;

const snapshotCache = new Map<string, ArrayBuffer>();
const timestampCache = new Map<string, number>();
const takenAtCache = new Map<string, number>();
const stampCache = new Map<string, SnapshotStamp>();
const urlCache = new Map<string, string>();
const subscribers = new Map<string, Set<() => void>>();
const pendingLoads = new Map<string, Promise<ArrayBuffer | undefined>>();

function notify(cameraId: string): void {
  subscribers.get(cameraId)?.forEach((cb) => cb());
}

function fetchSnapshotShared(deviceManager: ReturnType<typeof useDeviceManager>, id: string, forceFresh = false): Promise<ArrayBuffer | undefined> {
  const pending = pendingLoads.get(id);
  if (pending) return pending;

  const promise = (async (): Promise<ArrayBuffer | undefined> => {
    const device = await acquireCameraDevice(deviceManager, id);
    try {
      if (!device) return undefined;
      // the device stores the result itself
      const result = await device.fetchSnapshot(undefined, forceFresh ? true : undefined);
      return result ?? undefined;
    } finally {
      if (device) releaseCameraDevice(device);
    }
  })().finally(() => pendingLoads.delete(id));

  pendingLoads.set(id, promise);
  return promise;
}

const hookedContexts = new WeakSet<object>();

function hookReconnectRefresh(cameraUi: ReturnType<typeof useCameraUi>, deviceManager: ReturnType<typeof useDeviceManager>): void {
  if (hookedContexts.has(cameraUi)) return;
  hookedContexts.add(cameraUi);
  cameraUi.on('reconnected', () => {
    // the isConnected watchers re-subscribe in the next flush, a synchronous sweep finds every set empty
    setTimeout(() => {
      let delay = 0;
      for (const id of subscribers.keys()) {
        if ((subscribers.get(id)?.size ?? 0) === 0) continue;
        const cameraId = id;
        setTimeout(() => {
          if ((subscribers.get(cameraId)?.size ?? 0) === 0) return;
          void fetchSnapshotShared(deviceManager, cameraId).catch(() => undefined);
        }, delay);
        delay += 150;
      }
    }, 0);
  });
}

function deferRevoke(url: string): void {
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}

function isOlderThanHeld(cameraId: string, takenAt: number | undefined, stamp: SnapshotStamp | undefined): boolean {
  const held = stampCache.get(cameraId);
  if (stamp && held) {
    const behind = held.fetchedAt - stamp.fetchedAt;
    // further behind follows a step back of the server clock, nothing newer would ever replace the held image
    return behind > 0 && behind <= SERVER_CLOCK_STEP_MS;
  }
  // without stamps on both sides a push is the newest image
  return takenAt !== undefined && takenAt < (takenAtCache.get(cameraId) ?? -Infinity);
}

export function setSnapshot(cameraId: string, data: ArrayBuffer, fetchedAt?: number, takenAt?: number, stamp?: SnapshotStamp): void {
  if (isOlderThanHeld(cameraId, takenAt, stamp)) return;
  takenAtCache.set(cameraId, takenAt ?? Date.now());
  if (stamp) stampCache.set(cameraId, stamp);
  else stampCache.delete(cameraId);

  // Buffer is being replaced — schedule revocation of the old blob URL so the
  // next read produces a fresh URL bound to the new bytes, but keep the old
  // URL valid long enough for any pending img fetches to complete. The same
  // buffer keeps its URL: cards that render it never see a new value, so a
  // revoked URL would stay their src and break once the WebView re-reads it.
  if (snapshotCache.get(cameraId) !== data) {
    const oldUrl = urlCache.get(cameraId);
    if (oldUrl) {
      deferRevoke(oldUrl);
      urlCache.delete(cameraId);
    }
    snapshotCache.set(cameraId, data);
  }
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

export function getSnapshotStamp(cameraId: string, sourceId: string): number | undefined {
  const stamp = stampCache.get(cameraId);
  return stamp?.sourceId === sourceId ? stamp.fetchedAt : undefined;
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
  takenAtCache.clear();
  stampCache.clear();
}

export function useSnapshot(cameraIdOrName: MaybeRefOrGetter<string | DBCamera>): UseSnapshotReturn {
  const cameraUi = useCameraUi();
  const { isConnected } = cameraUi;
  const deviceManager = useDeviceManager();

  const snapshot = shallowRef<ArrayBuffer | undefined>();
  const _isLoading = ref(false);
  const initialLoadDone = ref(false);

  hookReconnectRefresh(cameraUi, deviceManager);

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
  let heldDevice: ReactiveCameraDevice | undefined;
  let pendingHoldId: string | undefined;
  const holdRetry = createRetryTimer();
  let disposed = false;

  function currentId(): string {
    const idOrName = toValue(cameraIdOrName);
    return typeof idOrName === 'string' ? idOrName : idOrName._id;
  }

  // Hold the device for the composable's lifetime — closing it (refcount 0)
  // kills its `snapshot:updated` subscription, so server auto-refresh pushes
  // would never reach views that only render snapshots (e.g. the dashboard).
  async function holdDevice(id: string): Promise<void> {
    if (heldDeviceId === id || pendingHoldId === id) return;
    pendingHoldId = id;
    try {
      const device = await acquireCameraDevice(deviceManager, id);
      if (!device) return;

      if (disposed || currentId() !== id || heldDeviceId === id) {
        releaseCameraDevice(device);
        return;
      }

      releaseHeldDevice();
      heldDeviceId = id;
      heldDevice = device;
      cancelHoldRetry();
    } catch {
      if (currentId() === id) scheduleHoldRetry(id);
    } finally {
      pendingHoldId = undefined;
    }
  }

  function scheduleHoldRetry(id: string): void {
    if (disposed) return;
    holdRetry.schedule(() => {
      if (!isConnected.value || currentId() !== id || isCameraDisabled(toValue(cameraIdOrName))) return;
      void holdDevice(id).then(() => {
        // the load after the failed hold found no device either
        if (heldDeviceId === id) return loadSnapshot(id);
      });
    });
  }

  function cancelHoldRetry(): void {
    holdRetry.cancel();
    holdRetry.reset();
  }

  function releaseHeldDevice(): void {
    if (heldDeviceId) {
      if (heldDevice) releaseCameraDevice(heldDevice);
      heldDeviceId = undefined;
      heldDevice = undefined;
    }
  }

  function showCached(id: string): boolean {
    const cached = snapshotCache.get(id);
    if (!cached) return false;
    snapshot.value = cached;
    initialLoadDone.value = true;
    return true;
  }

  async function loadSnapshot(id: string, skipCache = false): Promise<void> {
    if (!isConnected.value || !id) return;
    if (!skipCache && showCached(id)) return;

    _isLoading.value = true;
    try {
      const result = await fetchSnapshotShared(deviceManager, id);
      // the cache keeps a newer push over a late reply
      if (result) snapshot.value = snapshotCache.get(id) ?? result;
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
      const result = await fetchSnapshotShared(deviceManager, id, true);
      if (result) snapshot.value = snapshotCache.get(id) ?? result;
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
      cancelHoldRetry();
      unsubscribe?.();
      unsubscribe = undefined;

      const id = typeof cameraIdName === 'string' ? cameraIdName : cameraIdName._id;

      if (connected && id && !disabled) {
        // a card that loads its device by name then shares this one
        if (typeof cameraIdName === 'object') rememberCameraName(cameraIdName.name, id);
        unsubscribe = subscribe(id);
        // holding the device is a round trip, a remounted card shows its cached snapshot right away
        showCached(id);
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
    disposed = true;
    cancelHoldRetry();
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
