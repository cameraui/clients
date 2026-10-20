import {
  AudioProperty,
  BatteryProperty,
  CarbonDioxideProperty,
  CarbonMonoxideProperty,
  ChargingState,
  ClassifierProperty,
  ColdProperty,
  ContactProperty,
  DoorbellProperty,
  FaceProperty,
  GarageProperty,
  GarageState,
  GasProperty,
  HeatProperty,
  HumidityProperty,
  IlluminanceProperty,
  LeakProperty,
  LicensePlateProperty,
  LightProperty,
  LockProperty,
  LockState,
  MotionProperty,
  ObjectProperty,
  OccupancyProperty,
  PowerProperty,
  ProblemProperty,
  PTZProperty,
  SecuritySystemProperty,
  SecuritySystemState,
  SensorType,
  SirenProperty,
  SmokeProperty,
  SwitchProperty,
  TamperProperty,
  TemperatureProperty,
  VibrationProperty,
} from '@camera.ui/sdk';
import { tryOnScopeDispose } from '@vueuse/core';
import { computed, ref, shallowReactive, shallowRef, toValue, watch } from 'vue';

import { NamespaceManager } from '../server/index.js';
import { createDebouncedCache } from '../utils/createDebouncedCache.js';
import { createRetryTimer } from '../utils/createRetryTimer.js';
import { useCameraUi } from './useCameraUi.js';
import { rpcCall } from './useRpc.js';
import { extractCameraId } from './utils.js';

import type { RPCClient } from '@camera.ui/rpc';
import type {
  AudioSensorProperties,
  BatteryInfoProperties,
  CarbonDioxideInfoProperties,
  CarbonMonoxideSensorProperties,
  ClassifierSensorProperties,
  ColdSensorProperties,
  ContactSensorProperties,
  Detection,
  DoorbellTriggerProperties,
  FaceDetection,
  FaceSensorProperties,
  GarageControlProperties,
  GasSensorProperties,
  HeatSensorProperties,
  HumidityInfoProperties,
  IlluminanceInfoProperties,
  LeakSensorProperties,
  LicensePlateDetection,
  LicensePlateSensorProperties,
  LightControlProperties,
  LockControlProperties,
  MotionSensorProperties,
  ObjectSensorProperties,
  OccupancySensorProperties,
  PowerSensorProperties,
  ProblemSensorProperties,
  PTZControlProperties,
  PTZDirection,
  PTZPosition,
  SecuritySystemProperties,
  SirenControlProperties,
  SmokeSensorProperties,
  SwitchControlProperties,
  TamperSensorProperties,
  TemperatureInfoProperties,
  VibrationSensorProperties,
} from '@camera.ui/sdk';
import type { PropertyChangedEvent } from '@camera.ui/sdk/internal';
import type { ComputedRef, MaybeRefOrGetter, Ref, ShallowRef } from 'vue';
import type {
  SensorAddedEvent,
  SensorAssignmentChangedEvent,
  SensorCapabilitiesChangedEvent,
  SensorConnectedChangedEvent,
  SensorDeletedEvent,
  SensorDisplayNameChangedEvent,
  SensorExposedChangedEvent,
  SensorRefreshedState,
  StoredSensorData,
} from '../server/index.js';
import type { ReactiveCameraDeviceContext } from './useCamera.js';
import type { CameraIdentifier } from './utils.js';

export type { SensorRefreshedState, StoredSensorData } from '../server/index.js';
export type { CameraIdentifier } from './utils.js';

export interface SensorRegistryRPC {
  getSensors(): StoredSensorData[];
  getSensorRpc(sensorId: string): StoredSensorData | undefined;
  getSensorState(sensorId: string): SensorRefreshedState;
  getSensorStates(): Record<string, SensorRefreshedState>;
  getPropertyValue(sensorId: string, property: string): unknown;
  getAllPropertyValues(sensorId: string): Record<string, unknown>;
  setDisplayName(sensorId: string, displayName: string): void;
}

export interface SensorEventMessage {
  type:
    | 'property:changed'
    | 'sensor:added'
    | 'sensor:deleted'
    | 'sensor:connected:changed'
    | 'sensor:displayName:changed'
    | 'sensor:capabilities:changed'
    | 'sensor:assignment:changed'
    | 'sensor:exposed:changed';
  data:
    | PropertyChangedEvent
    | SensorAddedEvent
    | SensorDeletedEvent
    | SensorConnectedChangedEvent
    | SensorDisplayNameChangedEvent
    | SensorCapabilitiesChangedEvent
    | SensorAssignmentChangedEvent
    | SensorExposedChangedEvent;
}

export interface ReactiveSensor<TProperties extends object = Record<string, unknown>> {
  readonly id: string;
  readonly type: SensorType;
  readonly name: string;
  readonly displayName: Ref<string>;
  readonly nativeId?: string;
  readonly pluginId: string;
  readonly boundCameraId?: string;
  readonly assignedCameraIds: Ref<string[]>;
  readonly exposed: Ref<boolean>;
  readonly connected: Ref<boolean>;
  readonly capabilities: Ref<string[]>;
  readonly properties: TProperties;
  getProperty<T = unknown>(property: string): T | undefined;
  setProperty(property: string, value: unknown): Promise<void>;
  setDisplayName(displayName: string): Promise<void>;
  hasCapability(capability: string): boolean;
  onCapabilitiesChanged(callback: (capabilities: string[]) => void): () => void;
}

export interface ReactiveLightControl extends ReactiveSensor<LightControlProperties> {
  readonly type: typeof SensorType.Light;
  getProperty(property: typeof LightProperty.On): boolean | undefined;
  getProperty(property: typeof LightProperty.Brightness): number | undefined;
  getProperty(property: string): unknown;
  setProperty(property: typeof LightProperty.On, value: boolean): Promise<void>;
  setProperty(property: typeof LightProperty.Brightness, value: number): Promise<void>;
  setProperty(property: string, value: unknown): Promise<void>;
}

export interface ReactiveSirenControl extends ReactiveSensor<SirenControlProperties> {
  readonly type: typeof SensorType.Siren;
  getProperty(property: typeof SirenProperty.Active): boolean | undefined;
  getProperty(property: typeof SirenProperty.Volume): number | undefined;
  getProperty(property: string): unknown;
  setProperty(property: typeof SirenProperty.Active, value: boolean): Promise<void>;
  setProperty(property: typeof SirenProperty.Volume, value: number): Promise<void>;
  setProperty(property: string, value: unknown): Promise<void>;
}

export interface ReactiveBatteryInfo extends ReactiveSensor<BatteryInfoProperties> {
  readonly type: typeof SensorType.Battery;
  getProperty(property: typeof BatteryProperty.Level): number | undefined;
  getProperty(property: typeof BatteryProperty.Low): boolean | undefined;
  getProperty(property: typeof BatteryProperty.Charging): ChargingState | undefined;
  getProperty(property: string): unknown;
}

export interface ReactiveDoorbellTrigger extends ReactiveSensor<DoorbellTriggerProperties> {
  readonly type: typeof SensorType.Doorbell;
  getProperty(property: typeof DoorbellProperty.Ring): boolean | undefined;
  getProperty(property: string): unknown;
}

export interface ReactiveContactSensor extends ReactiveSensor<ContactSensorProperties> {
  readonly type: typeof SensorType.Contact;
  getProperty(property: typeof ContactProperty.Detected): boolean | undefined;
  getProperty(property: string): unknown;
}

export interface ReactiveMotionSensor extends ReactiveSensor<MotionSensorProperties> {
  readonly type: typeof SensorType.Motion;
  getProperty(property: typeof MotionProperty.Detected): boolean | undefined;
  getProperty(property: typeof MotionProperty.Detections): Detection[] | undefined;
  getProperty(property: string): unknown;
}

export interface ReactiveObjectSensor extends ReactiveSensor<ObjectSensorProperties> {
  readonly type: typeof SensorType.Object;
  getProperty(property: typeof ObjectProperty.Detected): boolean | undefined;
  getProperty(property: typeof ObjectProperty.Detections): Detection[] | undefined;
  getProperty(property: typeof ObjectProperty.Labels): string[] | undefined;
  getProperty(property: string): unknown;
}

export interface ReactiveAudioSensor extends ReactiveSensor<AudioSensorProperties> {
  readonly type: typeof SensorType.Audio;
  getProperty(property: typeof AudioProperty.Detected): boolean | undefined;
  getProperty(property: typeof AudioProperty.Detections): Detection[] | undefined;
  getProperty(property: typeof AudioProperty.Decibels): number | undefined;
  getProperty(property: string): unknown;
}

export interface ReactiveFaceSensor extends ReactiveSensor<FaceSensorProperties> {
  readonly type: typeof SensorType.Face;
  getProperty(property: typeof FaceProperty.Detected): boolean | undefined;
  getProperty(property: typeof FaceProperty.Detections): FaceDetection[] | undefined;
  getProperty(property: string): unknown;
}

export interface ReactiveLicensePlateSensor extends ReactiveSensor<LicensePlateSensorProperties> {
  readonly type: typeof SensorType.LicensePlate;
  getProperty(property: typeof LicensePlateProperty.Detected): boolean | undefined;
  getProperty(property: typeof LicensePlateProperty.Detections): LicensePlateDetection[] | undefined;
  getProperty(property: string): unknown;
}

export interface ReactiveClassifierSensor extends ReactiveSensor<ClassifierSensorProperties> {
  readonly type: typeof SensorType.Classifier;
  getProperty(property: typeof ClassifierProperty.Detected): boolean | undefined;
  getProperty(property: typeof ClassifierProperty.Detections): Detection[] | undefined;
  getProperty(property: typeof ClassifierProperty.Labels): string[] | undefined;
  getProperty(property: string): unknown;
}

export interface ReactivePTZControl extends ReactiveSensor<PTZControlProperties> {
  readonly type: typeof SensorType.PTZ;
  getProperty(property: typeof PTZProperty.Position): PTZPosition | undefined;
  getProperty(property: typeof PTZProperty.Moving): boolean | undefined;
  getProperty(property: typeof PTZProperty.Presets): string[] | undefined;
  getProperty(property: typeof PTZProperty.Velocity): PTZDirection | undefined;
  getProperty(property: typeof PTZProperty.TargetPreset): string | undefined;
  getProperty(property: string): unknown;
  setProperty(property: typeof PTZProperty.Position, value: PTZPosition): Promise<void>;
  setProperty(property: typeof PTZProperty.Moving, value: boolean): Promise<void>;
  setProperty(property: typeof PTZProperty.Velocity, value: PTZDirection): Promise<void>;
  setProperty(property: typeof PTZProperty.TargetPreset, value: string): Promise<void>;
  setProperty(property: string, value: unknown): Promise<void>;
}

export interface ReactiveSwitchControl extends ReactiveSensor<SwitchControlProperties> {
  readonly type: typeof SensorType.Switch;
  getProperty(property: typeof SwitchProperty.On): boolean | undefined;
  getProperty(property: string): unknown;
  setProperty(property: typeof SwitchProperty.On, value: boolean): Promise<void>;
  setProperty(property: string, value: unknown): Promise<void>;
}

export interface ReactiveLockControl extends ReactiveSensor<LockControlProperties> {
  readonly type: typeof SensorType.Lock;
  getProperty(property: typeof LockProperty.CurrentState): LockState | undefined;
  getProperty(property: typeof LockProperty.TargetState): LockState | undefined;
  getProperty(property: string): unknown;
  setProperty(property: typeof LockProperty.CurrentState, value: LockState): Promise<void>;
  setProperty(property: typeof LockProperty.TargetState, value: LockState): Promise<void>;
  setProperty(property: string, value: unknown): Promise<void>;
}

export interface ReactiveSecuritySystem extends ReactiveSensor<SecuritySystemProperties> {
  readonly type: typeof SensorType.SecuritySystem;
  getProperty(property: typeof SecuritySystemProperty.CurrentState): SecuritySystemState | undefined;
  getProperty(property: typeof SecuritySystemProperty.TargetState): SecuritySystemState | undefined;
  getProperty(property: string): unknown;
  setProperty(property: typeof SecuritySystemProperty.CurrentState, value: SecuritySystemState): Promise<void>;
  setProperty(property: typeof SecuritySystemProperty.TargetState, value: SecuritySystemState): Promise<void>;
  setProperty(property: string, value: unknown): Promise<void>;
}

export interface ReactiveTemperatureInfo extends ReactiveSensor<TemperatureInfoProperties> {
  readonly type: typeof SensorType.Temperature;
  getProperty(property: typeof TemperatureProperty.Current): number | undefined;
  getProperty(property: string): unknown;
}

export interface ReactiveHumidityInfo extends ReactiveSensor<HumidityInfoProperties> {
  readonly type: typeof SensorType.Humidity;
  getProperty(property: typeof HumidityProperty.Current): number | undefined;
  getProperty(property: string): unknown;
}
export interface ReactiveIlluminanceInfo extends ReactiveSensor<IlluminanceInfoProperties> {
  readonly type: typeof SensorType.Illuminance;
  getProperty(property: typeof IlluminanceProperty.Current): number | undefined;
  getProperty(property: string): unknown;
}

export interface ReactiveCarbonDioxideInfo extends ReactiveSensor<CarbonDioxideInfoProperties> {
  readonly type: typeof SensorType.CarbonDioxide;
  getProperty(property: typeof CarbonDioxideProperty.Current): number | undefined;
  getProperty(property: string): unknown;
}

export interface ReactiveOccupancySensor extends ReactiveSensor<OccupancySensorProperties> {
  readonly type: typeof SensorType.Occupancy;
  getProperty(property: typeof OccupancyProperty.Detected): boolean | undefined;
  getProperty(property: string): unknown;
}

export interface ReactiveSmokeSensor extends ReactiveSensor<SmokeSensorProperties> {
  readonly type: typeof SensorType.Smoke;
  getProperty(property: typeof SmokeProperty.Detected): boolean | undefined;
  getProperty(property: string): unknown;
}

export interface ReactiveLeakSensor extends ReactiveSensor<LeakSensorProperties> {
  readonly type: typeof SensorType.Leak;
  getProperty(property: typeof LeakProperty.Detected): boolean | undefined;
  getProperty(property: string): unknown;
}
export interface ReactiveGasSensor extends ReactiveSensor<GasSensorProperties> {
  readonly type: typeof SensorType.Gas;
  getProperty(property: typeof GasProperty.Detected): boolean | undefined;
  getProperty(property: string): unknown;
}

export interface ReactiveCarbonMonoxideSensor extends ReactiveSensor<CarbonMonoxideSensorProperties> {
  readonly type: typeof SensorType.CarbonMonoxide;
  getProperty(property: typeof CarbonMonoxideProperty.Detected): boolean | undefined;
  getProperty(property: string): unknown;
}

export interface ReactiveHeatSensor extends ReactiveSensor<HeatSensorProperties> {
  readonly type: typeof SensorType.Heat;
  getProperty(property: typeof HeatProperty.Detected): boolean | undefined;
  getProperty(property: string): unknown;
}

export interface ReactiveColdSensor extends ReactiveSensor<ColdSensorProperties> {
  readonly type: typeof SensorType.Cold;
  getProperty(property: typeof ColdProperty.Detected): boolean | undefined;
  getProperty(property: string): unknown;
}

export interface ReactiveVibrationSensor extends ReactiveSensor<VibrationSensorProperties> {
  readonly type: typeof SensorType.Vibration;
  getProperty(property: typeof VibrationProperty.Detected): boolean | undefined;
  getProperty(property: string): unknown;
}

export interface ReactiveTamperSensor extends ReactiveSensor<TamperSensorProperties> {
  readonly type: typeof SensorType.Tamper;
  getProperty(property: typeof TamperProperty.Detected): boolean | undefined;
  getProperty(property: string): unknown;
}

export interface ReactiveProblemSensor extends ReactiveSensor<ProblemSensorProperties> {
  readonly type: typeof SensorType.Problem;
  getProperty(property: typeof ProblemProperty.Detected): boolean | undefined;
  getProperty(property: string): unknown;
}

export interface ReactivePowerSensor extends ReactiveSensor<PowerSensorProperties> {
  readonly type: typeof SensorType.Power;
  getProperty(property: typeof PowerProperty.Detected): boolean | undefined;
  getProperty(property: string): unknown;
}

export interface ReactiveGarageControl extends ReactiveSensor<GarageControlProperties> {
  readonly type: typeof SensorType.Garage;
  getProperty(property: typeof GarageProperty.CurrentState): GarageState | undefined;
  getProperty(property: typeof GarageProperty.TargetState): GarageState | undefined;
  getProperty(property: typeof GarageProperty.ObstructionDetected): boolean | undefined;
  getProperty(property: string): unknown;
  setProperty(property: typeof GarageProperty.TargetState, value: GarageState): Promise<void>;
  setProperty(property: string, value: unknown): Promise<void>;
}

function createSensorTypeGuard<T extends ReactiveSensor<any>>(sensorType: SensorType) {
  return (sensor: ReactiveSensor<any>): sensor is T => sensor.type === sensorType;
}

export const isReactiveLightControl = createSensorTypeGuard<ReactiveLightControl>(SensorType.Light);
export const isReactiveSirenControl = createSensorTypeGuard<ReactiveSirenControl>(SensorType.Siren);
export const isReactiveBatteryInfo = createSensorTypeGuard<ReactiveBatteryInfo>(SensorType.Battery);
export const isReactiveDoorbellTrigger = createSensorTypeGuard<ReactiveDoorbellTrigger>(SensorType.Doorbell);
export const isReactiveContactSensor = createSensorTypeGuard<ReactiveContactSensor>(SensorType.Contact);
export const isReactiveMotionSensor = createSensorTypeGuard<ReactiveMotionSensor>(SensorType.Motion);
export const isReactiveObjectSensor = createSensorTypeGuard<ReactiveObjectSensor>(SensorType.Object);
export const isReactiveAudioSensor = createSensorTypeGuard<ReactiveAudioSensor>(SensorType.Audio);
export const isReactiveFaceSensor = createSensorTypeGuard<ReactiveFaceSensor>(SensorType.Face);
export const isReactiveLicensePlateSensor = createSensorTypeGuard<ReactiveLicensePlateSensor>(SensorType.LicensePlate);
export const isReactiveClassifierSensor = createSensorTypeGuard<ReactiveClassifierSensor>(SensorType.Classifier);
export const isReactivePTZControl = createSensorTypeGuard<ReactivePTZControl>(SensorType.PTZ);
export const isReactiveSwitchControl = createSensorTypeGuard<ReactiveSwitchControl>(SensorType.Switch);
export const isReactiveLockControl = createSensorTypeGuard<ReactiveLockControl>(SensorType.Lock);
export const isReactiveSecuritySystem = createSensorTypeGuard<ReactiveSecuritySystem>(SensorType.SecuritySystem);
export const isReactiveTemperatureInfo = createSensorTypeGuard<ReactiveTemperatureInfo>(SensorType.Temperature);
export const isReactiveHumidityInfo = createSensorTypeGuard<ReactiveHumidityInfo>(SensorType.Humidity);
export const isReactiveOccupancySensor = createSensorTypeGuard<ReactiveOccupancySensor>(SensorType.Occupancy);
export const isReactiveSmokeSensor = createSensorTypeGuard<ReactiveSmokeSensor>(SensorType.Smoke);
export const isReactiveLeakSensor = createSensorTypeGuard<ReactiveLeakSensor>(SensorType.Leak);
export const isReactiveGasSensor = createSensorTypeGuard<ReactiveGasSensor>(SensorType.Gas);
export const isReactiveCarbonMonoxideSensor = createSensorTypeGuard<ReactiveCarbonMonoxideSensor>(SensorType.CarbonMonoxide);
export const isReactiveHeatSensor = createSensorTypeGuard<ReactiveHeatSensor>(SensorType.Heat);
export const isReactiveColdSensor = createSensorTypeGuard<ReactiveColdSensor>(SensorType.Cold);
export const isReactiveVibrationSensor = createSensorTypeGuard<ReactiveVibrationSensor>(SensorType.Vibration);
export const isReactiveTamperSensor = createSensorTypeGuard<ReactiveTamperSensor>(SensorType.Tamper);
export const isReactiveProblemSensor = createSensorTypeGuard<ReactiveProblemSensor>(SensorType.Problem);
export const isReactivePowerSensor = createSensorTypeGuard<ReactivePowerSensor>(SensorType.Power);
export const isReactiveIlluminanceInfo = createSensorTypeGuard<ReactiveIlluminanceInfo>(SensorType.Illuminance);
export const isReactiveCarbonDioxideInfo = createSensorTypeGuard<ReactiveCarbonDioxideInfo>(SensorType.CarbonDioxide);
export const isReactiveGarageControl = createSensorTypeGuard<ReactiveGarageControl>(SensorType.Garage);

export interface ReactiveSensorManager {
  readonly sensors: ComputedRef<ReactiveSensor[]>;
  readonly isInitialized: ComputedRef<boolean>;
  ensureInitialized(): Promise<void>;
  reconnect(): Promise<void>;
  getSensor(sensorId: string): ReactiveSensor | undefined;
  getSensorsByType(type: SensorType): ReactiveSensor[];
  hasSensorType(type: SensorType): boolean;
  setDisplayName(sensorId: string, displayName: string): Promise<void>;
  close(): void;
}

interface InternalReactiveSensor extends ReactiveSensor {
  _notifyCapabilitiesChanged(): void;
  _update(data: StoredSensorData, state: SensorRefreshedState): void;
}

interface InternalSensorManager extends ReactiveSensorManager {
  retainLive(scope: string): void;
  releaseLive(scope: string): void;
  whenRefreshed(): Promise<void>;
}

interface StateRefresh {
  sensorId: string;
  changed: Set<string>;
  subscribed: Promise<(() => void) | undefined>;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function sameIdentity(sensor: ReactiveSensor, data: StoredSensorData): boolean {
  return (
    sensor.type === data.type &&
    sensor.name === data.name &&
    sensor.pluginId === data.pluginId &&
    sensor.nativeId === data.nativeId &&
    sensor.boundCameraId === data.boundCameraId
  );
}

function createReactiveSensor(data: StoredSensorData, state: SensorRefreshedState, rpcRef: ShallowRef<RPCClient | undefined>): InternalReactiveSensor {
  const displayName = ref(state.displayName ?? data.displayName ?? data.name);
  const capabilities = ref<string[]>(state.capabilities ?? data.capabilities ?? []);
  const assignedCameraIds = ref<string[]>([...data.assignedCameraIds]);
  const exposed = ref(data.exposed);
  const connected = ref(data.connected);
  const properties = shallowReactive<Record<string, unknown>>({ ...state.properties });
  const capabilityCallbacks: ((capabilities: string[]) => void)[] = [];

  function notifyCapabilitiesChanged(): void {
    for (const callback of capabilityCallbacks) {
      callback(capabilities.value);
    }
  }

  return {
    id: data.id,
    type: data.type,
    name: data.name,
    displayName,
    nativeId: data.nativeId,
    pluginId: data.pluginId,
    boundCameraId: data.boundCameraId,
    assignedCameraIds,
    exposed,
    connected,
    capabilities,
    properties,

    getProperty<T = unknown>(property: string): T | undefined {
      return properties[property] as T | undefined;
    },

    async setProperty(property: string, value: unknown): Promise<void> {
      // updateValue is the sdk sensor's external write entry, control sensors route it to their setters
      const sensorNamespace = `plugin.${data.pluginId}.sensor.${data.id}.rpc`;
      await rpcCall(rpcRef, (client) =>
        client.createProxy<{ updateValue(property: string, value: unknown): Promise<void> }>(sensorNamespace).updateValue(property, value),
      );
    },

    async setDisplayName(newDisplayName: string): Promise<void> {
      const namespace = NamespaceManager.sensorRegistryNamespaces();
      await rpcCall(rpcRef, (client) => client.createProxy<SensorRegistryRPC>(namespace.sensorsRpc).setDisplayName(data.id, newDisplayName));
    },

    hasCapability(capability: string): boolean {
      return capabilities.value.includes(capability);
    },

    onCapabilitiesChanged(callback: (capabilities: string[]) => void): () => void {
      capabilityCallbacks.push(callback);
      return () => {
        const index = capabilityCallbacks.indexOf(callback);
        if (index !== -1) {
          capabilityCallbacks.splice(index, 1);
        }
      };
    },

    _notifyCapabilitiesChanged: notifyCapabilitiesChanged,

    _update(next: StoredSensorData, nextState: SensorRefreshedState): void {
      displayName.value = nextState.displayName ?? next.displayName ?? next.name;
      if (!sameList(assignedCameraIds.value, next.assignedCameraIds)) assignedCameraIds.value = [...next.assignedCameraIds];
      exposed.value = next.exposed;
      connected.value = next.connected;

      const nextProperties = nextState.properties ?? {};
      for (const property of Object.keys(properties)) {
        if (!(property in nextProperties)) delete properties[property];
      }
      Object.assign(properties, nextProperties);

      const nextCapabilities = nextState.capabilities ?? next.capabilities ?? [];
      if (!sameList(capabilities.value, nextCapabilities)) {
        capabilities.value = nextCapabilities;
        notifyCapabilitiesChanged();
      }
    },
  };
}

const LIVE_RELEASE_DELAY_MS = 1_000;
const ALL_LIVE_SCOPE = 'all';

function cameraLiveScope(cameraId: string): string {
  return `camera:${cameraId}`;
}

function sensorLiveScope(sensorId: string): string {
  return `sensor:${sensorId}`;
}

export function createSensorManager(rpcOrContext: RPCClient | ReactiveCameraDeviceContext): ReactiveSensorManager {
  const manager = createScopedSensorManager(rpcOrContext);
  manager.retainLive(ALL_LIVE_SCOPE);
  return manager;
}

function createScopedSensorManager(rpcOrContext: RPCClient | ReactiveCameraDeviceContext): InternalSensorManager {
  const { sensorsSubject, sensorsRpc } = NamespaceManager.sensorRegistryNamespaces();
  const ctx: ReactiveCameraDeviceContext | undefined =
    'rpc' in rpcOrContext && 'value' in (rpcOrContext as ReactiveCameraDeviceContext).rpc ? (rpcOrContext as ReactiveCameraDeviceContext) : undefined;
  // a bare RPCClient (nvr) gets a ref that never changes, so rpcCall sees one reactive surface
  const rpcRef: ShallowRef<RPCClient | undefined> = ctx ? (ctx.rpc as ShallowRef<RPCClient | undefined>) : shallowRef<RPCClient | undefined>(rpcOrContext as RPCClient);

  const sensorMap = shallowRef(new Map<string, InternalReactiveSensor>());
  let globalUnsubscribe: (() => void) | undefined;
  const sensorSubscriptions = new Map<string, () => void>();
  const pendingSubscriptions = new Set<string>();
  const refreshing = new Map<string, Set<string>>();
  const refreshRuns = new Set<Promise<void>>();
  let refreshBatch: StateRefresh[] | undefined;
  const refreshRetries = new Set<string>();
  const refreshRetry = createRetryTimer();
  const refreshOnConnect = new Set<string>();
  const liveHolds = new Map<string, number>();
  const liveReleaseTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let subscriptionEpoch = 0;
  const initialized = ref(false);
  let initPromise: Promise<void> | undefined;
  let generation = 0;
  const initRetry = createRetryTimer();

  function handlePerSensorEvent(sensorId: string, message: SensorEventMessage): void {
    const sensor = sensorMap.value.get(sensorId);
    if (!sensor) return;

    refreshing.get(sensorId)?.add(message.type === 'property:changed' ? (message.data as PropertyChangedEvent).property : message.type);

    if (message.type === 'property:changed') {
      const event = message.data as PropertyChangedEvent;
      sensor.properties[event.property] = event.value;
    } else if (message.type === 'sensor:displayName:changed') {
      const event = message.data as SensorDisplayNameChangedEvent;
      (sensor.displayName as Ref<string>).value = event.displayName;
    } else if (message.type === 'sensor:capabilities:changed') {
      const event = message.data as SensorCapabilitiesChangedEvent;
      (sensor.capabilities as Ref<string[]>).value = event.capabilities;
      sensor._notifyCapabilitiesChanged();
    }
  }

  function isLive(sensor: InternalReactiveSensor): boolean {
    if (liveHolds.has(ALL_LIVE_SCOPE) || liveHolds.has(sensorLiveScope(sensor.id))) return true;
    const cameraIds = sensor.assignedCameraIds.value;
    return cameraIds.length === 0 || cameraIds.some((cameraId) => liveHolds.has(cameraLiveScope(cameraId)));
  }

  function goLive(sensor: InternalReactiveSensor, staleValues: boolean): void {
    if (sensorSubscriptions.has(sensor.id) || pendingSubscriptions.has(sensor.id)) return;

    // nobody held the sensor, so its values are unknown until the snapshot arrives
    if (staleValues) {
      for (const property of Object.keys(sensor.properties)) delete sensor.properties[property];
    }
    queueRefresh(
      sensor.id,
      subscribeSensorSubject(sensor.id).catch(() => undefined),
    );
  }

  function queueRefresh(sensorId: string, subscribed: Promise<(() => void) | undefined>): void {
    // what changes before the snapshot arrives is newer than the snapshot
    const changed = new Set<string>();
    refreshing.set(sensorId, changed);

    if (!refreshBatch) {
      const batch: StateRefresh[] = [];
      refreshBatch = batch;
      // one call for every sensor that goes live in the same tick, viewers may not call getSensorState
      const run: Promise<void> = Promise.resolve()
        .then(() => {
          refreshBatch = undefined;
          return refreshStates(batch);
        })
        .catch(() => {})
        .finally(() => refreshRuns.delete(run));
      refreshRuns.add(run);
    }
    refreshBatch.push({ sensorId, changed, subscribed });
  }

  async function refreshStates(batch: StateRefresh[]): Promise<void> {
    const subscriptions = await Promise.all(batch.map((refresh) => refresh.subscribed));
    const current = batch.flatMap((refresh, i) => {
      const unsubscribe = subscriptions[i];
      return unsubscribe && sensorSubscriptions.get(refresh.sensorId) === unsubscribe ? [{ ...refresh, unsubscribe }] : [];
    });

    let states: Record<string, SensorRefreshedState> | undefined;
    if (current.length > 0) {
      try {
        states = await rpcCall(rpcRef, (c) => c.createProxy<SensorRegistryRPC>(sensorsRpc).getSensorStates());
        refreshRetry.reset();
      } catch {
        states = undefined;
      }
    }

    for (const { sensorId, unsubscribe, changed } of current) {
      applyRefreshedState(sensorId, unsubscribe, changed, states);
    }
    for (const { sensorId, changed } of batch) {
      if (refreshing.get(sensorId) === changed) refreshing.delete(sensorId);
    }
  }

  function applyRefreshedState(sensorId: string, unsubscribe: () => void, changed: Set<string>, states: Record<string, SensorRefreshedState> | undefined): void {
    const sensor = sensorMap.value.get(sensorId);
    // a later subscription brings its own snapshot
    if (!sensor || sensorSubscriptions.get(sensorId) !== unsubscribe) return;

    const state = states?.[sensorId];
    if (!state) {
      // offline sensors have no state, they get it once the plugin is back
      if (states && !sensor.connected.value) refreshOnConnect.add(sensorId);
      else retryRefresh(sensorId);
      return;
    }

    for (const [property, value] of Object.entries(state.properties ?? {})) {
      if (!changed.has(property)) sensor.properties[property] = value;
    }
    if (state.displayName !== undefined && !changed.has('sensor:displayName:changed')) {
      sensor.displayName.value = state.displayName;
    }
    const current = sensor.capabilities.value;
    const capabilities = state.capabilities ?? current;
    if (!changed.has('sensor:capabilities:changed') && !sameList(capabilities, current)) {
      sensor.capabilities.value = capabilities;
      sensor._notifyCapabilitiesChanged();
    }
  }

  function retryRefresh(sensorId: string): void {
    refreshRetries.add(sensorId);
    refreshRetry.schedule(() => {
      const sensorIds = [...refreshRetries];
      refreshRetries.clear();
      for (const id of sensorIds) refreshLiveSensor(id);
    });
  }

  function refreshLiveSensor(sensorId: string): void {
    const unsubscribe = sensorSubscriptions.get(sensorId);
    if (unsubscribe) queueRefresh(sensorId, Promise.resolve(unsubscribe));
  }

  function whenRefreshed(): Promise<void> {
    return Promise.all(refreshRuns).then(() => {});
  }

  async function subscribeSensorSubject(sensorId: string): Promise<(() => void) | undefined> {
    const epoch = subscriptionEpoch;
    const namespace = NamespaceManager.sensorEventNamespaces(sensorId);
    pendingSubscriptions.add(sensorId);
    let unsubscribe: () => void;
    try {
      unsubscribe = await rpcCall(rpcRef, (c) =>
        c.subscribe<SensorEventMessage>(namespace.sensorSubject, (msg: SensorEventMessage) => handlePerSensorEvent(sensorId, msg)),
      );
    } finally {
      if (epoch === subscriptionEpoch) pendingSubscriptions.delete(sensorId);
    }

    const sensor = sensorMap.value.get(sensorId);
    if (epoch !== subscriptionEpoch || !sensor || !isLive(sensor)) {
      unsubscribe();
      return undefined;
    }
    sensorSubscriptions.set(sensorId, unsubscribe);
    return unsubscribe;
  }

  function syncSensor(sensor: InternalReactiveSensor, staleValues: boolean): void {
    // init subscribes on its own and syncs once it is done
    if (!initialized.value) return;
    if (isLive(sensor)) goLive(sensor, staleValues);
    else unsubscribeFromSensorEvents(sensor.id);
  }

  function syncLive(): void {
    for (const sensor of sensorMap.value.values()) {
      syncSensor(sensor, true);
    }
  }

  function retainLive(scope: string): void {
    clearTimeout(liveReleaseTimers.get(scope));
    liveReleaseTimers.delete(scope);
    const held = liveHolds.has(scope);
    liveHolds.set(scope, (liveHolds.get(scope) ?? 0) + 1);
    if (!held) syncLive();
  }

  function releaseLive(scope: string): void {
    const count = liveHolds.get(scope);
    if (!count) return;
    liveHolds.set(scope, count - 1);
    if (count > 1) return;

    // debounced so switching between cameras does not churn subscriptions
    liveReleaseTimers.set(
      scope,
      setTimeout(() => {
        liveReleaseTimers.delete(scope);
        liveHolds.delete(scope);
        syncLive();
      }, LIVE_RELEASE_DELAY_MS),
    );
  }

  function unsubscribeFromSensorEvents(sensorId: string): void {
    const unsubscribe = sensorSubscriptions.get(sensorId);
    if (unsubscribe) {
      unsubscribe();
      sensorSubscriptions.delete(sensorId);
    }
    refreshRetries.delete(sensorId);
    refreshOnConnect.delete(sensorId);
  }

  function handleGlobalSensorEvent(message: SensorEventMessage): void {
    if (message.type === 'sensor:added') {
      const event = message.data as SensorAddedEvent;
      // doInit may have added it during a reconnect
      if (sensorMap.value.has(event.sensor.id)) return;
      const reactiveSensor = createReactiveSensor(event.sensor, event.state, rpcRef);
      const newMap = new Map(sensorMap.value);
      newMap.set(event.sensor.id, reactiveSensor);
      sensorMap.value = newMap;
      // the event carries the current values
      syncSensor(reactiveSensor, false);
    } else if (message.type === 'sensor:deleted') {
      const event = message.data as SensorDeletedEvent;
      unsubscribeFromSensorEvents(event.sensorId);
      const newMap = new Map(sensorMap.value);
      newMap.delete(event.sensorId);
      sensorMap.value = newMap;
    } else if (message.type === 'sensor:connected:changed') {
      const event = message.data as SensorConnectedChangedEvent;
      const sensor = sensorMap.value.get(event.sensorId);
      if (!sensor) return;
      sensor.connected.value = event.connected;
      if (event.connected && refreshOnConnect.delete(sensor.id)) refreshLiveSensor(sensor.id);
    } else if (message.type === 'sensor:assignment:changed') {
      const event = message.data as SensorAssignmentChangedEvent;
      const sensor = sensorMap.value.get(event.sensorId);
      if (!sensor) return;
      const cameras = new Set(sensor.assignedCameraIds.value);
      if (event.assigned) cameras.add(event.cameraId);
      else cameras.delete(event.cameraId);
      sensor.assignedCameraIds.value = [...cameras];
      syncSensor(sensor, true);
    } else if (message.type === 'sensor:exposed:changed') {
      const event = message.data as SensorExposedChangedEvent;
      const sensor = sensorMap.value.get(event.sensorId);
      if (sensor) sensor.exposed.value = event.exposed;
    }
  }

  function dropSubscriptions(): void {
    globalUnsubscribe?.();
    globalUnsubscribe = undefined;
    for (const unsubscribe of sensorSubscriptions.values()) {
      unsubscribe();
    }
    sensorSubscriptions.clear();
    // subscribes still in flight see the new epoch and undo themselves
    subscriptionEpoch++;
    pendingSubscriptions.clear();
    refreshing.clear();
    refreshRetries.clear();
    refreshOnConnect.clear();
    refreshRetry.cancel();
    refreshRetry.reset();
  }

  function assertCurrent(run: number): void {
    if (run !== generation) throw new Error('sensor manager closed');
  }

  function scheduleRetry(): void {
    initRetry.schedule(() => {
      if (!initialized.value && !initPromise) launchInit().catch(() => {});
    });
  }

  async function doInit(run: number): Promise<void> {
    assertCurrent(run);
    dropSubscriptions();
    // views keep their sensor objects and lists until the new snapshot replaces them
    const previous = sensorMap.value;

    // global events queue up until the initial load is done
    let pendingEvents: SensorEventMessage[] | undefined = [];
    try {
      globalUnsubscribe = await rpcCall(rpcRef, (c) =>
        c.subscribe<SensorEventMessage>(sensorsSubject, (msg: SensorEventMessage) => {
          if (pendingEvents) {
            pendingEvents.push(msg);
          } else {
            handleGlobalSensorEvent(msg);
          }
        }),
      );
      assertCurrent(run);

      const [sensors, states] = await rpcCall(rpcRef, async (c) => {
        const proxy = c.createProxy<SensorRegistryRPC>(sensorsRpc);
        return Promise.all([proxy.getSensors(), proxy.getSensorStates()]);
      });
      assertCurrent(run);

      const newMap = new Map<string, InternalReactiveSensor>();
      for (const sensor of sensors) {
        const state = states[sensor.id] ?? { properties: {}, capabilities: [], type: sensor.type };
        const kept = previous.get(sensor.id);
        if (kept && sameIdentity(kept, sensor)) {
          kept._update(sensor, state);
          newMap.set(sensor.id, kept);
        } else {
          newMap.set(sensor.id, createReactiveSensor(sensor, state, rpcRef));
        }
      }
      sensorMap.value = newMap;

      // a write between the snapshot above and these subscribes stays unseen until that key changes again
      for (const sensor of newMap.values()) {
        if (!isLive(sensor)) continue;
        await subscribeSensorSubject(sensor.id);
        assertCurrent(run);
      }
    } catch (err) {
      // nobody drains the queue of a failed run, and a run that outlived close() belongs to no cached manager
      dropSubscriptions();
      if (run === generation) {
        sensorMap.value = previous;
        scheduleRetry();
      }
      throw err;
    }

    // a replayed add of a sensor the snapshot already has is skipped
    const queued = pendingEvents;
    pendingEvents = undefined;
    for (const msg of queued) {
      handleGlobalSensorEvent(msg);
    }

    initRetry.reset();
    initialized.value = true;
    // scopes and sensors that changed while init ran
    syncLive();
  }

  function launchInit(): Promise<void> {
    const p = doInit(generation).finally(() => {
      if (initPromise === p) initPromise = undefined;
    });
    initPromise = p;
    return p;
  }

  async function ensureInitialized(): Promise<void> {
    if (initialized.value) return;

    if (!initPromise) {
      launchInit();
    }

    return initPromise;
  }

  async function reconnect(): Promise<void> {
    initialized.value = false;
    if (initPromise) {
      // the running init may sit on the old dead client, a fresh one behind it lands on the current client
      const current = initPromise;
      const run = generation;
      const p = current
        .catch(() => {})
        .then(() => doInit(run))
        .finally(() => {
          if (initPromise === p) initPromise = undefined;
        });
      initPromise = p;
      return p;
    }
    return launchInit();
  }

  function close(): void {
    generation++;
    initRetry.cancel();
    dropSubscriptions();
    sensorMap.value = new Map();
    initialized.value = false;
    initPromise = undefined;
  }

  const sensors = computed(() => Array.from(sensorMap.value.values()));
  const isInitialized = computed(() => initialized.value);

  return {
    sensors,
    isInitialized,

    getSensor(sensorId: string): ReactiveSensor | undefined {
      return sensorMap.value.get(sensorId);
    },

    getSensorsByType(type: SensorType): ReactiveSensor[] {
      return sensors.value.filter((s) => s.type === type);
    },

    hasSensorType(type: SensorType): boolean {
      return sensors.value.some((s) => s.type === type);
    },

    async setDisplayName(sensorId: string, displayName: string): Promise<void> {
      await rpcCall(rpcRef, (c) => c.createProxy<SensorRegistryRPC>(sensorsRpc).setDisplayName(sensorId, displayName));
    },

    ensureInitialized,
    reconnect,
    close,
    retainLive,
    releaseLive,
    whenRefreshed,
  };
}

interface CachedSensorManager {
  manager: ReactiveSensorManager;
}

interface SharedSensorManager {
  manager: InternalSensorManager;
}

const sensorManagerCache = createDebouncedCache<SharedSensorManager>({
  releaseDelay: 1000,
  onRelease: (_key, cached) => cached.manager.close(),
});

export function clearSensorCache(): void {
  sensorManagerCache.clear();
}

export function reconnectAllSensorManagers(): void {
  sensorManagerCache.forEachValue((cached) => {
    cached.manager.reconnect().catch(() => {});
  });
}

const GLOBAL_SENSOR_MANAGER_KEY = 'sensors';

export function acquireSensorManager(rpcOrContext: RPCClient | ReactiveCameraDeviceContext): CachedSensorManager {
  const cached = acquireSharedManager(rpcOrContext);
  cached.manager.retainLive(ALL_LIVE_SCOPE);
  return cached;
}

export function releaseSensorManager(): void {
  sensorManagerCache.get(GLOBAL_SENSOR_MANAGER_KEY)?.manager.releaseLive(ALL_LIVE_SCOPE);
  releaseSharedManager();
}

function acquireSharedManager(rpcOrContext: RPCClient | ReactiveCameraDeviceContext): SharedSensorManager {
  return sensorManagerCache.acquire(GLOBAL_SENSOR_MANAGER_KEY, () => ({ manager: createScopedSensorManager(rpcOrContext) }));
}

function releaseSharedManager(held?: InternalSensorManager): void {
  const cached = sensorManagerCache.get(GLOBAL_SENSOR_MANAGER_KEY);
  if (!cached || (held && cached.manager !== held)) return;
  sensorManagerCache.release(GLOBAL_SENSOR_MANAGER_KEY, cached);
}

export interface UseSensorReturn {
  sensor: ShallowRef<ReactiveSensor<any> | undefined>;
  isLoading: ComputedRef<boolean>;
  error: Ref<Error | undefined>;
}

export interface UseSensorsReturn {
  sensors: ComputedRef<ReactiveSensor<any>[]>;
  isLoading: ComputedRef<boolean>;
  error: Ref<Error | undefined>;
}

export interface UseSensorTypedReturn<T extends ReactiveSensor<any> = ReactiveSensor<any>> {
  sensor: ShallowRef<T | undefined>;
  isLoading: ComputedRef<boolean>;
  error: Ref<Error | undefined>;
}

export interface UseSensorsTypedReturn<T extends ReactiveSensor<any> = ReactiveSensor> {
  sensors: ComputedRef<T[]>;
  isLoading: ComputedRef<boolean>;
  error: Ref<Error | undefined>;
}

interface SensorComposableState {
  acquired: boolean;
  cachedManager: InternalSensorManager | undefined;
  liveScope: string | undefined;
}

function createSensorComposableState(): SensorComposableState {
  return {
    acquired: false,
    cachedManager: undefined,
    liveScope: undefined,
  };
}

function sensorsForCamera(manager: ReactiveSensorManager, cameraId: string): ReactiveSensor[] {
  return manager.sensors.value.filter((sensor) => sensor.assignedCameraIds.value.includes(cameraId));
}

async function ensureSensorManager(
  state: SensorComposableState,
  cameraUi: ReactiveCameraDeviceContext,
  isConnected: boolean,
  isLoading: Ref<boolean>,
  error: Ref<Error | undefined>,
  liveScope: string,
): Promise<ReactiveSensorManager | undefined> {
  // a short drop clears rpc but keeps isConnected, the manager's calls wait for the link
  if (!isConnected) return undefined;

  isLoading.value = true;
  error.value = undefined;

  try {
    // watch reruns reuse the reference, a cleared cache needs a new one
    if (!holdsCachedManager(state)) {
      // with the context the cached manager follows the current client across an endpoint swap
      state.cachedManager = acquireSharedManager(cameraUi).manager;
      state.acquired = true;
      state.liveScope = undefined;
    }
    // before init, so the first load subscribes the held scope right away
    holdLiveScope(state, liveScope);

    await state.cachedManager?.ensureInitialized();
    // sensors the hold just made live get their values with this snapshot
    await state.cachedManager?.whenRefreshed();
  } catch (err) {
    error.value = err instanceof Error ? err : new Error(String(err));
  } finally {
    isLoading.value = false;
  }

  // a failed init keeps the caller bound while the manager retries; a release during the await leaves it unbound
  return state.cachedManager;
}

function clearErrorOnRecovery(manager: Ref<ReactiveSensorManager | undefined>, error: Ref<Error | undefined>): void {
  watch(
    () => manager.value?.isInitialized.value,
    (ready) => {
      if (ready) error.value = undefined;
    },
  );
}

function holdsCachedManager(state: SensorComposableState): boolean {
  return state.acquired && sensorManagerCache.get(GLOBAL_SENSOR_MANAGER_KEY)?.manager === state.cachedManager;
}

function holdLiveScope(state: SensorComposableState, liveScope: string): void {
  if (state.liveScope === liveScope) return;
  state.cachedManager?.retainLive(liveScope);
  if (state.liveScope) state.cachedManager?.releaseLive(state.liveScope);
  state.liveScope = liveScope;
}

function cleanupSensorComposable(state: SensorComposableState): void {
  // after clearSensorCache the reference belongs to a closed manager, releasing it would drop a newer one
  if (holdsCachedManager(state)) {
    if (state.liveScope) state.cachedManager?.releaseLive(state.liveScope);
    releaseSharedManager(state.cachedManager);
  }
  state.acquired = false;
  state.cachedManager = undefined;
  state.liveScope = undefined;
}

export function useSensorById(camera: CameraIdentifier, sensorId: MaybeRefOrGetter<string | undefined>): UseSensorReturn {
  const cameraUi = useCameraUi();
  const { isConnected } = cameraUi;
  const sensor = shallowRef<ReactiveSensor | undefined>();
  const cachedManager = shallowRef<ReactiveSensorManager | undefined>();
  const _isLoading = ref(false);
  const initialLoadDone = ref(false);
  const error = ref<Error | undefined>();
  const state = createSensorComposableState();

  function resolveSensor(): ReactiveSensor | undefined {
    const senId = toValue(sensorId);
    return senId ? cachedManager.value?.getSensor(senId) : undefined;
  }

  watch(
    [isConnected, () => extractCameraId(toValue(camera)), () => toValue(sensorId)],
    async ([connected, camId, senId]) => {
      if (connected && camId && senId) {
        cachedManager.value = await ensureSensorManager(state, cameraUi, connected, _isLoading, error, sensorLiveScope(senId));
        sensor.value = resolveSensor();
        initialLoadDone.value = true;
      } else {
        cleanupSensorComposable(state);
        cachedManager.value = undefined;
        sensor.value = undefined;
      }
    },
    { immediate: true },
  );

  // a reconnect or a retried init builds new sensor objects
  watch(resolveSensor, (next) => {
    sensor.value = next;
  });

  clearErrorOnRecovery(cachedManager, error);

  tryOnScopeDispose(() => {
    cleanupSensorComposable(state);
    sensor.value = undefined;
  });

  return { sensor, isLoading: computed(() => _isLoading.value || !initialLoadDone.value), error };
}

export function useSensorByType(camera: CameraIdentifier, sensorType: MaybeRefOrGetter<SensorType>): UseSensorReturn {
  const cameraUi = useCameraUi();
  const { isConnected } = cameraUi;
  const sensor = shallowRef<ReactiveSensor | undefined>();
  const cachedManager = shallowRef<ReactiveSensorManager | undefined>();
  const _isLoading = ref(false);
  const initialLoadDone = ref(false);
  const error = ref<Error | undefined>();
  const state = createSensorComposableState();

  function resolveSensor(): ReactiveSensor | undefined {
    const camId = extractCameraId(toValue(camera));
    const type = toValue(sensorType);
    return cachedManager.value && camId ? sensorsForCamera(cachedManager.value, camId).find((s) => s.type === type) : undefined;
  }

  watch(
    [isConnected, () => extractCameraId(toValue(camera)), () => toValue(sensorType)],
    async ([connected, camId]) => {
      if (connected && camId) {
        cachedManager.value = await ensureSensorManager(state, cameraUi, connected, _isLoading, error, cameraLiveScope(camId));
        sensor.value = resolveSensor();
        initialLoadDone.value = true;
      } else {
        // a gated camera id drops the manager so its nats subscriptions stop
        cleanupSensorComposable(state);
        cachedManager.value = undefined;
        sensor.value = undefined;
      }
    },
    { immediate: true },
  );

  watch(resolveSensor, (next) => {
    sensor.value = next;
  });

  clearErrorOnRecovery(cachedManager, error);

  tryOnScopeDispose(() => {
    cleanupSensorComposable(state);
    sensor.value = undefined;
  });

  return { sensor, isLoading: computed(() => _isLoading.value || !initialLoadDone.value), error };
}

export function useSensorsByType(camera: CameraIdentifier, sensorType: MaybeRefOrGetter<SensorType>): UseSensorsReturn {
  const cameraUi = useCameraUi();
  const { isConnected } = cameraUi;
  const sensorsRef = shallowRef<ReactiveSensor[]>([]);
  const cachedManager = shallowRef<ReactiveSensorManager | undefined>();
  const _isLoading = ref(false);
  const initialLoadDone = ref(false);
  const error = ref<Error | undefined>();
  const state = createSensorComposableState();

  watch(
    [isConnected, () => extractCameraId(toValue(camera)), () => toValue(sensorType)],
    async ([connected, camId, type]) => {
      if (connected && camId) {
        const manager = await ensureSensorManager(state, cameraUi, connected, _isLoading, error, cameraLiveScope(camId));
        cachedManager.value = manager;
        sensorsRef.value = manager ? sensorsForCamera(manager, camId).filter((s) => s.type === type) : [];
        initialLoadDone.value = true;
      } else {
        cleanupSensorComposable(state);
        sensorsRef.value = [];
        cachedManager.value = undefined;
      }
    },
    { immediate: true },
  );

  const sensors = computed(() => {
    if (!cachedManager.value) return [];
    const camId = extractCameraId(toValue(camera));
    const type = toValue(sensorType);
    if (!camId) return [];
    return sensorsForCamera(cachedManager.value, camId).filter((s) => s.type === type);
  });

  clearErrorOnRecovery(cachedManager, error);

  tryOnScopeDispose(() => {
    cleanupSensorComposable(state);
    sensorsRef.value = [];
  });

  return { sensors, isLoading: computed(() => _isLoading.value || !initialLoadDone.value), error };
}

export function useSensors(camera: CameraIdentifier): UseSensorsReturn {
  const cameraUi = useCameraUi();
  const { isConnected } = cameraUi;
  const sensorsRef = shallowRef<ReactiveSensor[]>([]);
  const cachedManager = shallowRef<ReactiveSensorManager | undefined>();
  const _isLoading = ref(false);
  const initialLoadDone = ref(false);
  const error = ref<Error | undefined>();
  const state = createSensorComposableState();

  watch(
    [isConnected, () => extractCameraId(toValue(camera))],
    async ([connected, camId]) => {
      if (connected && camId) {
        const manager = await ensureSensorManager(state, cameraUi, connected, _isLoading, error, cameraLiveScope(camId));
        cachedManager.value = manager;
        sensorsRef.value = manager ? sensorsForCamera(manager, camId) : [];
        initialLoadDone.value = true;
      } else {
        cleanupSensorComposable(state);
        sensorsRef.value = [];
        cachedManager.value = undefined;
      }
    },
    { immediate: true },
  );

  const sensors = computed(() => {
    if (!cachedManager.value) return [];
    const camId = extractCameraId(toValue(camera));
    if (!camId) return [];
    return sensorsForCamera(cachedManager.value, camId);
  });

  clearErrorOnRecovery(cachedManager, error);

  tryOnScopeDispose(() => {
    cleanupSensorComposable(state);
    sensorsRef.value = [];
  });

  return { sensors, isLoading: computed(() => _isLoading.value || !initialLoadDone.value), error };
}

export function useAllSensors(): UseSensorsReturn {
  const cameraUi = useCameraUi();
  const { isConnected } = cameraUi;
  const cachedManager = shallowRef<ReactiveSensorManager | undefined>();
  const _isLoading = ref(false);
  const initialLoadDone = ref(false);
  const error = ref<Error | undefined>();
  const state = createSensorComposableState();

  watch(
    [isConnected],
    async ([connected]) => {
      if (connected) {
        cachedManager.value = await ensureSensorManager(state, cameraUi, connected, _isLoading, error, ALL_LIVE_SCOPE);
        initialLoadDone.value = true;
      } else {
        cleanupSensorComposable(state);
        cachedManager.value = undefined;
      }
    },
    { immediate: true },
  );

  const sensors = computed(() => cachedManager.value?.sensors.value ?? []);

  clearErrorOnRecovery(cachedManager, error);

  tryOnScopeDispose(() => {
    cleanupSensorComposable(state);
  });

  return { sensors, isLoading: computed(() => _isLoading.value || !initialLoadDone.value), error };
}

function pickSensorOfType(sensors: ReactiveSensor[], sensorType: SensorType, preferredPluginId?: string): ReactiveSensor | undefined {
  const typed = sensors.filter((sensor) => sensor.type === sensorType);
  if (preferredPluginId) {
    const preferred = typed.find((sensor) => sensor.pluginId === preferredPluginId);
    if (preferred) return preferred;
  }
  return typed[0];
}

function useTypedSensor<T extends ReactiveSensor<any>>(
  camera: CameraIdentifier,
  sensorType: SensorType,
  preferredPluginId?: MaybeRefOrGetter<string | undefined>,
): UseSensorTypedReturn<T> {
  const cameraUi = useCameraUi();
  const { isConnected } = cameraUi;
  const sensor = shallowRef<T | undefined>();
  const cachedManager = shallowRef<ReactiveSensorManager | undefined>();
  const _isLoading = ref(false);
  const initialLoadDone = ref(false);
  const error = ref<Error | undefined>();
  const state = createSensorComposableState();

  function resolveSensor(): T | undefined {
    const camId = extractCameraId(toValue(camera));
    if (!cachedManager.value || !camId) return undefined;
    return pickSensorOfType(sensorsForCamera(cachedManager.value, camId), sensorType, toValue(preferredPluginId)) as T | undefined;
  }

  watch(
    [isConnected, () => extractCameraId(toValue(camera)), () => toValue(preferredPluginId)],
    async ([connected, camId]) => {
      if (connected && camId) {
        cachedManager.value = await ensureSensorManager(state, cameraUi, connected, _isLoading, error, cameraLiveScope(camId));
        sensor.value = resolveSensor();
        initialLoadDone.value = true;
      } else {
        // a gated camera id drops the manager so its nats subscriptions stop
        cleanupSensorComposable(state);
        cachedManager.value = undefined;
        sensor.value = undefined;
      }
    },
    { immediate: true },
  );

  watch(resolveSensor, (next) => {
    sensor.value = next;
  });

  clearErrorOnRecovery(cachedManager, error);

  tryOnScopeDispose(() => {
    cleanupSensorComposable(state);
    sensor.value = undefined;
  });

  return { sensor: sensor as ShallowRef<T | undefined>, isLoading: computed(() => _isLoading.value || !initialLoadDone.value), error };
}

export function useMotionSensor(camera: CameraIdentifier, preferredPluginId?: MaybeRefOrGetter<string | undefined>): UseSensorTypedReturn<ReactiveMotionSensor> {
  return useTypedSensor<ReactiveMotionSensor>(camera, SensorType.Motion, preferredPluginId);
}

export function useObjectSensor(camera: CameraIdentifier, preferredPluginId?: MaybeRefOrGetter<string | undefined>): UseSensorTypedReturn<ReactiveObjectSensor> {
  return useTypedSensor<ReactiveObjectSensor>(camera, SensorType.Object, preferredPluginId);
}

export function useFaceSensor(camera: CameraIdentifier, preferredPluginId?: MaybeRefOrGetter<string | undefined>): UseSensorTypedReturn<ReactiveFaceSensor> {
  return useTypedSensor<ReactiveFaceSensor>(camera, SensorType.Face, preferredPluginId);
}

export function useLicensePlateSensor(
  camera: CameraIdentifier,
  preferredPluginId?: MaybeRefOrGetter<string | undefined>,
): UseSensorTypedReturn<ReactiveLicensePlateSensor> {
  return useTypedSensor<ReactiveLicensePlateSensor>(camera, SensorType.LicensePlate, preferredPluginId);
}

export function useAudioSensor(camera: CameraIdentifier, preferredPluginId?: MaybeRefOrGetter<string | undefined>): UseSensorTypedReturn<ReactiveAudioSensor> {
  return useTypedSensor<ReactiveAudioSensor>(camera, SensorType.Audio, preferredPluginId);
}

export function usePTZControl(camera: CameraIdentifier): UseSensorTypedReturn<ReactivePTZControl> {
  return useTypedSensor<ReactivePTZControl>(camera, SensorType.PTZ);
}

export function useClassifierSensors(camera: CameraIdentifier): UseSensorsTypedReturn<ReactiveClassifierSensor> {
  const cameraUi = useCameraUi();
  const { isConnected } = cameraUi;
  const sensorsRef = shallowRef<ReactiveClassifierSensor[]>([]);
  const cachedManager = shallowRef<ReactiveSensorManager | undefined>();
  const _isLoading = ref(false);
  const initialLoadDone = ref(false);
  const error = ref<Error | undefined>();
  const state = createSensorComposableState();

  watch(
    [isConnected, () => extractCameraId(toValue(camera))],
    async ([connected, camId]) => {
      if (connected && camId) {
        const manager = await ensureSensorManager(state, cameraUi, connected, _isLoading, error, cameraLiveScope(camId));
        cachedManager.value = manager;
        sensorsRef.value = (manager ? sensorsForCamera(manager, camId).filter((s) => s.type === SensorType.Classifier) : []) as unknown as ReactiveClassifierSensor[];
        initialLoadDone.value = true;
      } else {
        cleanupSensorComposable(state);
        sensorsRef.value = [];
        cachedManager.value = undefined;
      }
    },
    { immediate: true },
  );

  const sensors = computed(() => {
    if (!cachedManager.value) return [] as ReactiveClassifierSensor[];
    const camId = extractCameraId(toValue(camera));
    if (!camId) return [] as ReactiveClassifierSensor[];
    return sensorsForCamera(cachedManager.value, camId).filter((s) => s.type === SensorType.Classifier) as unknown as ReactiveClassifierSensor[];
  });

  clearErrorOnRecovery(cachedManager, error);

  tryOnScopeDispose(() => {
    cleanupSensorComposable(state);
    sensorsRef.value = [];
  });

  return { sensors, isLoading: computed(() => _isLoading.value || !initialLoadDone.value), error };
}
