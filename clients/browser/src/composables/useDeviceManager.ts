import { NamespaceManager } from '../server/index.js';
import { useCameraUi } from './useCameraUi.js';
import { createReactiveCameraDevice } from './useCamera.js';
import { rpcCall } from './useRpc.js';

import type { DeviceManagerInterface, DeviceManagerNamespaces } from '../server/index.js';
import type { ReactiveCameraDevice, ReactiveDeviceManager } from '../types.js';

export function useDeviceManager(): ReactiveDeviceManager {
  const ctx = useCameraUi();
  const namespaces: DeviceManagerNamespaces = NamespaceManager.deviceManagerNamespaces();

  async function getCamera(cameraIdOrName: string): Promise<ReactiveCameraDevice | undefined> {
    const camera = await rpcCall(ctx.rpc, (rpc) => rpc.createProxy<DeviceManagerInterface>(namespaces.deviceManagerRpc).getCamera(cameraIdOrName, '@camera.ui/browser'));
    if (camera) {
      return createReactiveCameraDevice(ctx, camera);
    }
  }

  return { getCamera };
}
