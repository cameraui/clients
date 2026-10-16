import { clearCameraCache, reconnectAllCameraDevices, refreshAllCameraDevices } from './useCameraById.js';
import { clearOAuthCache } from './useOAuth.js';
import { clearPluginCache, forgetPluginStatus } from './usePlugin.js';
import { clearSensorCache, reconnectAllSensorManagers } from './useSensor.js';
import { clearSnapshotCache } from './useSnapshot.js';
import { clearStorageCache } from './useStorage.js';

export function resetClientState(): void {
  clearPluginCache();
  clearCameraCache();
  clearStorageCache();
  clearSensorCache();
  clearSnapshotCache();
  clearOAuthCache();
}

export function refreshClientSubscriptions(): void {
  clearPluginCache();
  reconnectAllCameraDevices();
  reconnectAllSensorManagers();
}

export function refreshClientStates(): void {
  forgetPluginStatus();
  refreshAllCameraDevices();
}
