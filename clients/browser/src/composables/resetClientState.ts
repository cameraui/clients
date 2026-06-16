import { clearCameraCache, reconnectAllCameraDevices } from './useCameraById.js';
import { clearPluginCache } from './usePlugin.js';
import { clearSensorCache, reconnectAllSensorManagers } from './useSensor.js';
import { clearSnapshotCache } from './useSnapshot.js';
import { clearStorageCache } from './useStorage.js';

export function resetClientState(): void {
  clearPluginCache();
  clearCameraCache();
  clearStorageCache();
  clearSensorCache();
  clearSnapshotCache();
}

export function refreshClientSubscriptions(): void {
  clearPluginCache();
  reconnectAllCameraDevices();
  reconnectAllSensorManagers();
}
