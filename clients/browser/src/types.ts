import type { RPCClient } from '@camera.ui/rpc';
import type { Camera, CameraSource, CoreManager as ICoreManager, ProbeConfig, ProbeStream, SensorType } from '@camera.ui/sdk';
import type { ConnectionTarget } from '@camera.ui/transport';
import type { WsTransport } from '@camera.ui/transport/transports/ws';
import type { ComputedRef, Ref, ShallowRef } from 'vue';

export * from '@camera.ui/sdk';
export * from '@camera.ui/sdk/internal';

export interface BaseLogger {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  success: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  trace: (...args: unknown[]) => void;
  attention: (...args: unknown[]) => void;
}

export type CameraUiEventType = 'reconnected' | 'disconnected' | 'visibility-resumed';

export type CameraUiEventCallback = () => void;

export interface CameraUiContext {
  rpc: ShallowRef<RPCClient | undefined>;
  target: Readonly<Ref<ConnectionTarget | null>>;
  isConnected: Readonly<Ref<boolean>>;
  endpoint: Readonly<Ref<string | undefined>>;
  token: Readonly<Ref<string | undefined>>;
  extraProxyQuery: Readonly<Ref<Record<string, string> | undefined>>;
  error: Readonly<Ref<Error | undefined>>;
  wsTransport?: WsTransport;
  on: (event: CameraUiEventType, cb: CameraUiEventCallback) => void;
  off: (event: CameraUiEventType, cb: CameraUiEventCallback) => void;
}

export interface ReactiveCoreManager extends Omit<ICoreManager, 'connectToPlugin' | 'signRequest' | 'onEvent'> {}

export interface ReactiveDeviceManager {
  getCamera: (cameraIdOrName: string) => Promise<ReactiveCameraDevice | undefined>;
}

export interface ReactiveCameraDevice {
  readonly id: string;
  readonly name: Ref<string>;
  readonly room: Ref<string>;
  readonly nativeId: Ref<string | undefined>;
  readonly disabled: Ref<boolean>;
  readonly snooze: Ref<boolean>;
  readonly isCloud: Ref<boolean>;

  readonly connected: Ref<boolean>;
  readonly frameWorkerConnected: Ref<boolean>;

  readonly sources: Ref<CameraSource[]>;
  readonly streamSource: Ref<CameraSource | undefined>;
  readonly snapshotSource: Ref<CameraSource | undefined>;
  readonly highResolutionSource: Ref<CameraSource | undefined>;
  readonly midResolutionSource: Ref<CameraSource | undefined>;
  readonly lowResolutionSource: Ref<CameraSource | undefined>;

  readonly capabilities: Ref<SensorType[]>;
  readonly hasLight: ComputedRef<boolean>;
  readonly hasSiren: ComputedRef<boolean>;
  readonly hasDoorbell: ComputedRef<boolean>;
  readonly hasBattery: ComputedRef<boolean>;
  readonly hasAudioSensor: ComputedRef<boolean>;
  readonly hasMotionSensor: ComputedRef<boolean>;
  readonly hasObjectSensor: ComputedRef<boolean>;
  readonly hasPtz: ComputedRef<boolean>;

  readonly camera: Ref<Camera>;

  readonly snapshot: ShallowRef<ArrayBuffer | undefined>;
  readonly snapshotLoading: Ref<boolean>;

  fetchSnapshot: (sourceId?: string, forceNew?: boolean) => Promise<ArrayBuffer | undefined>;
  probeStream: (sourceId?: string, probeConfig?: ProbeConfig, refresh?: boolean) => Promise<ProbeStream | undefined>;
  streamUrl: (sourceId: string) => Promise<string | undefined>;
  refreshStates: () => Promise<void>;
  reconnect: () => Promise<void>;
  close: () => Promise<void>;
}
