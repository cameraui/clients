import { SensorType } from '@camera.ui/sdk';
import { computed, ref, shallowRef } from 'vue';

import { NamespaceManager } from '../server/index.js';
import { rpcCall } from './useRpc.js';
import { getSnapshot, setSnapshot, subscribeSnapshot } from './useSnapshot.js';

import type { RPCClient } from '@camera.ui/rpc';
import type { Camera, CameraInput, CameraSource, ProbeConfig, ProbeStream } from '@camera.ui/sdk';
import type { ShallowRef } from 'vue';
import type {
  CameraDeviceInterface,
  CameraDeviceListenerMessagePayload,
  CameraNamespaces,
  RefreshedStates,
  SensorAddedEvent,
  SensorControllerNamespaces,
  SensorRefreshedState,
  SensorRemovedEvent,
} from '../server/index.js';
import type { ReactiveCameraDevice } from '../types.js';

export interface ReactiveCameraDeviceContext {
  rpc: ShallowRef<RPCClient | undefined>;
}

interface GlobalSensorEventMessage {
  type: 'sensor:added' | 'sensor:removed';
  data: SensorAddedEvent | SensorRemovedEvent;
}

export async function createReactiveCameraDevice(rpcOrContext: RPCClient | ReactiveCameraDeviceContext, initialCamera: Camera): Promise<ReactiveCameraDevice> {
  const cameraNamespaces: CameraNamespaces = NamespaceManager.cameraNamespaces(initialCamera._id);
  const sensorNamespaces: SensorControllerNamespaces = NamespaceManager.sensorControllerNamespaces(initialCamera._id);

  const ctx: ReactiveCameraDeviceContext | undefined =
    'rpc' in rpcOrContext && 'value' in (rpcOrContext as ReactiveCameraDeviceContext).rpc ? (rpcOrContext as ReactiveCameraDeviceContext) : undefined;
  const rpcRef: ShallowRef<RPCClient | undefined> = ctx ? (ctx.rpc as ShallowRef<RPCClient | undefined>) : shallowRef<RPCClient | undefined>(rpcOrContext as RPCClient);

  let closeSubscription: (() => void) | undefined;
  let closeSensorSubscription: (() => void) | undefined;

  const camera = shallowRef(initialCamera);
  const connected = ref(false);
  const frameWorkerConnected = ref(false);
  const snapshot = shallowRef<ArrayBuffer | undefined>(getSnapshot(initialCamera._id));

  const snapshotLoading = ref(false);
  const sensorStates = ref<Record<string, SensorRefreshedState>>({});

  const unsubscribeSnapshot = subscribeSnapshot(initialCamera._id, () => {
    snapshot.value = getSnapshot(initialCamera._id);
  });

  const name = computed(() => camera.value.name);
  const room = computed(() => camera.value.room);
  const nativeId = computed(() => camera.value.nativeId);
  const disabled = computed(() => camera.value.disabled);
  const snooze = computed(() => camera.value.detectionSettings?.snooze ?? false);
  const isCloud = computed(() => camera.value.isCloud);

  const sources = computed(() => {
    const rawSources: CameraInput[] = JSON.parse(JSON.stringify(camera.value.sources));
    return rawSources.map((source) => ({
      ...source,
      snapshot: async (forceNew?: boolean) => fetchSnapshot(source._id, forceNew),
      probeStream: async (probeConfig?: ProbeConfig, refresh = false) => probeStream(source._id, probeConfig, refresh),
    })) as CameraSource[];
  });

  const highResolutionSource = computed(() => sources.value.find((s) => s.role === 'high-resolution'));
  const midResolutionSource = computed(() => sources.value.find((s) => s.role === 'mid-resolution'));
  const lowResolutionSource = computed(() => sources.value.find((s) => s.role === 'low-resolution'));
  const streamSource = computed(() => highResolutionSource.value ?? midResolutionSource.value ?? lowResolutionSource.value);
  const snapshotSource = computed(() => sources.value.find((s) => s.role === 'snapshot') ?? sources.value.find((s) => s.useForSnapshot));

  const existingSensorTypes = computed(() => {
    const types = new Set<SensorType>();
    for (const state of Object.values(sensorStates.value)) {
      types.add(state.type);
    }
    return types;
  });

  const capabilities = computed(() => Array.from(existingSensorTypes.value));
  const hasLight = computed(() => existingSensorTypes.value.has(SensorType.Light));
  const hasSiren = computed(() => existingSensorTypes.value.has(SensorType.Siren));
  const hasDoorbell = computed(() => existingSensorTypes.value.has(SensorType.Doorbell));
  const hasBattery = computed(() => existingSensorTypes.value.has(SensorType.Battery));
  const hasAudioSensor = computed(() => existingSensorTypes.value.has(SensorType.Audio));
  const hasMotionSensor = computed(() => existingSensorTypes.value.has(SensorType.Motion));
  const hasObjectSensor = computed(() => existingSensorTypes.value.has(SensorType.Object));
  const hasPtz = computed(() => existingSensorTypes.value.has(SensorType.PTZ));

  async function fetchSnapshot(sourceId: string, forceNew?: boolean): Promise<ArrayBuffer | undefined> {
    snapshotLoading.value = true;
    try {
      try {
        const result = await rpcCall(rpcRef, (client) =>
          client.createProxy<CameraDeviceInterface>(cameraNamespaces.cameraControllerRpc).snapshotWithMeta(sourceId, forceNew),
        );
        if (result && result.data.byteLength > 0) {
          setSnapshot(initialCamera._id, result.data, Date.now() - result.ageMs);
          return result.data;
        }
        return undefined;
      } catch {
        // Older servers don't expose snapshotWithMeta — fall back to the legacy
        // call, where only forced fetches have a known fetch time.
        const result = await rpcCall(rpcRef, (client) => client.createProxy<CameraDeviceInterface>(cameraNamespaces.cameraControllerRpc).snapshot(sourceId, forceNew));
        if (result && result.byteLength > 0) {
          setSnapshot(initialCamera._id, result, forceNew ? Date.now() : undefined);
          return result;
        }
      }
    } finally {
      snapshotLoading.value = false;
    }
  }

  async function probeStream(sourceId: string, probeConfig?: ProbeConfig, refresh = false): Promise<ProbeStream | undefined> {
    return rpcCall(rpcRef, (client) => client.createProxy<CameraDeviceInterface>(cameraNamespaces.cameraControllerRpc).probeStream(sourceId, probeConfig, refresh));
  }

  async function streamUrl(sourceId: string): Promise<string | undefined> {
    return rpcCall(rpcRef, (client) => client.createProxy<CameraDeviceInterface>(cameraNamespaces.cameraControllerRpc).streamUrl(sourceId));
  }

  async function refreshStates(): Promise<void> {
    const response: RefreshedStates = await rpcCall(rpcRef, (client) => client.createProxy<CameraDeviceInterface>(cameraNamespaces.cameraControllerRpc).refreshStates());
    camera.value = response.camera;
    connected.value = response.cameraState;
    frameWorkerConnected.value = response.frameWorkerState;
    sensorStates.value = response.sensorStates;
  }

  async function handleCameraEvent(event: CameraDeviceListenerMessagePayload): Promise<void> {
    switch (event.type) {
      case 'removed':
        await close();
        break;
      case 'updated':
        camera.value = event.data;
        break;
      case 'cameraState':
        connected.value = event.data;
        break;
      case 'frameWorkerState':
        frameWorkerConnected.value = event.data;
        break;
      case 'snapshot:updated':
        // Pushes are always fresh — the server fetches with forceNew before emitting.
        setSnapshot(initialCamera._id, event.data.snapshot, Date.now());
        break;
    }
  }

  function handleSensorEvent(event: GlobalSensorEventMessage): void {
    if (event.type === 'sensor:added') {
      const addedEvent = event.data as SensorAddedEvent;
      sensorStates.value = {
        ...sensorStates.value,
        [addedEvent.sensor.id]: addedEvent.state,
      };
    } else if (event.type === 'sensor:removed') {
      const removedEvent = event.data as SensorRemovedEvent;
      const newStates = { ...sensorStates.value };
      delete newStates[removedEvent.sensorId];
      sensorStates.value = newStates;
    }
  }

  async function init(): Promise<void> {
    closeSubscription?.();
    closeSensorSubscription?.();

    closeSubscription = await rpcCall(rpcRef, (client) => client.subscribe<CameraDeviceListenerMessagePayload>(cameraNamespaces.cameraSubject, handleCameraEvent));
    closeSensorSubscription = await rpcCall(rpcRef, (client) => client.subscribe<GlobalSensorEventMessage>(sensorNamespaces.sensorSubject, handleSensorEvent));

    await refreshStates();
  }

  async function close(): Promise<void> {
    closeSubscription?.();
    closeSubscription = undefined;

    closeSensorSubscription?.();
    closeSensorSubscription = undefined;

    unsubscribeSnapshot();
  }

  async function fetchSnapshotFn(sourceId?: string, forceNew?: boolean): Promise<ArrayBuffer | undefined> {
    const useForSnapshotSource = sources.value.find((s) => s.useForSnapshot);
    const dedicatedSnapshotSource = sources.value.find((s) => s.role === 'snapshot');
    const id =
      sourceId ??
      dedicatedSnapshotSource?._id ??
      useForSnapshotSource?._id ??
      lowResolutionSource.value?._id ??
      midResolutionSource.value?._id ??
      highResolutionSource.value?._id ??
      streamSource.value?._id;

    if (!id) return Promise.resolve(undefined);
    return fetchSnapshot(id, forceNew);
  }

  async function probeStreamFn(sourceId?: string, probeConfig?: ProbeConfig, refresh = false): Promise<ProbeStream | undefined> {
    const id = sourceId ?? streamSource.value?._id;
    if (!id) return Promise.resolve(undefined);
    return probeStream(id, probeConfig, refresh);
  }

  await init();

  return {
    id: initialCamera._id,
    name,
    room,
    nativeId,
    disabled,
    snooze,
    isCloud,
    connected,
    frameWorkerConnected,
    sources,
    streamSource,
    snapshotSource,
    highResolutionSource,
    midResolutionSource,
    lowResolutionSource,
    capabilities,
    hasLight,
    hasSiren,
    hasDoorbell,
    hasBattery,
    hasAudioSensor,
    hasMotionSensor,
    hasObjectSensor,
    hasPtz,
    camera,
    snapshot,
    snapshotLoading,
    fetchSnapshot: fetchSnapshotFn,
    probeStream: probeStreamFn,
    streamUrl,
    refreshStates,
    reconnect: init,
    close,
  };
}
