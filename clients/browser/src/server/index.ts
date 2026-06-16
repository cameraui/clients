export { createSourceName } from '../../../../externals/camera.ui/server/src/utils/camera.js';

export { type DBCamera } from '../../../../externals/camera.ui/server/src/api/database/types.js';

export {
  NamespaceManager,
  type CameraNamespaces,
  type CoreManagerNamespaces,
  type DeviceManagerNamespaces,
  type FrameWorkerNamespaces,
  type PluginCameraNamespaces,
  type PluginNamespaces,
  type PluginSensorNamespaces,
  type SensorControllerNamespaces,
  type SensorEventNamespaces,
  type SensorProviderNamespaces,
  type TerminalManagerNamespaces,
} from '../../../../externals/camera.ui/server/src/rpc/namespaces.js';

export type { CoreManagerInterface } from '../../../../externals/camera.ui/server/src/rpc/interfaces/core.js';
export type {
  CameraDeviceInterface,
  CameraDeviceListenerMessagePayload,
  DeviceManagerInterface,
  RefreshedStates,
  SnapshotUpdatedEvent,
} from '../../../../externals/camera.ui/server/src/rpc/interfaces/device.js';
export type {
  SensorAddedEvent,
  SensorCapabilitiesChangedEvent,
  SensorRefreshedState,
  SensorRemovedEvent,
  StoredSensorData,
} from '../../../../externals/camera.ui/server/src/rpc/interfaces/sensor.js';
export type { TerminalManagerInterface, TerminalOptions, TerminalSessionInfo } from '../../../../externals/camera.ui/server/src/rpc/interfaces/terminal.js';
