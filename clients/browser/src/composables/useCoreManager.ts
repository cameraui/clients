import { NamespaceManager } from '../server/index.js';
import { useCameraUi } from './useCameraUi.js';
import { rpcCall } from './useRpc.js';

import type { RPCClient } from '@camera.ui/rpc';
import type { CoreManagerInterface, CoreManagerNamespaces } from '../server/index.js';
import type { PluginInterface, ReactiveCoreManager } from '../types.js';

export function useCoreManager(): ReactiveCoreManager {
  const ctx = useCameraUi();
  const namespaces: CoreManagerNamespaces = NamespaceManager.coreManagerNamespaces();
  const proxy = (rpc: RPCClient) => rpc.createProxy<CoreManagerInterface>(namespaces.coreManagerRpc);

  return {
    getFFmpegPath: () => rpcCall(ctx.rpc, (rpc) => proxy(rpc).getFFmpegPath()),
    getServerAddresses: () => rpcCall(ctx.rpc, (rpc) => proxy(rpc).getServerAddresses()),
    getPluginsByInterface: (interfaceName: PluginInterface) => rpcCall(ctx.rpc, (rpc) => proxy(rpc).getPluginsByInterface(interfaceName)),
    getCloudServerId: () => rpcCall(ctx.rpc, (rpc) => proxy(rpc).getCloudServerId()),
  };
}
