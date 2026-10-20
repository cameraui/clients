import { SensorType } from '@camera.ui/sdk';
import { computed, ref, shallowRef } from 'vue';

import { NamespaceManager } from '../server/index.js';
import { createRetryTimer } from '../utils/createRetryTimer.js';
import { liveBulkClient, markBulkDead, probeBulkClient } from './bulkLane.js';
import { isLinkSettling, isLocalNoResponders, rpcCall } from './useRpc.js';
import { getSnapshot, getSnapshotStamp, setSnapshot, subscribeSnapshot } from './useSnapshot.js';

import type { RPCClient } from '@camera.ui/rpc';
import type { Camera, CameraInput, CameraSource, ProbeConfig, ProbeStream } from '@camera.ui/sdk';
import type { ShallowRef } from 'vue';
import type {
  CameraDeviceInterface,
  CameraDeviceListenerMessagePayload,
  CameraNamespaces,
  RefreshedStates,
  SensorAddedEvent,
  SensorAssignmentChangedEvent,
  SensorConnectedChangedEvent,
  SensorDeletedEvent,
  SensorRefreshedState,
} from '../server/index.js';
import type { ReactiveCameraDevice } from '../types.js';

export interface ReactiveCameraDeviceContext {
  rpc: ShallowRef<RPCClient | undefined>;
  bulkRpc?: ShallowRef<RPCClient | undefined>;
}

interface GlobalSensorEventMessage {
  type: 'sensor:added' | 'sensor:deleted' | 'sensor:connected:changed' | 'sensor:assignment:changed';
  data: SensorAddedEvent | SensorDeletedEvent | SensorConnectedChangedEvent | SensorAssignmentChangedEvent;
}

type SensorEventHandler = (event: GlobalSensorEventMessage) => void;

interface SensorEventFanout {
  handlers: Set<SensorEventHandler>;
  subscribed: Promise<() => void>;
}

interface FetchedSnapshot {
  data: ArrayBuffer;
  fetchedAt: number | undefined;
  stamp?: number;
}

const NOT_MODIFIED = 'not-modified';

const snapshotWithMetaSupport = new WeakMap<RPCClient, boolean>();
const sensorEventFanouts = new WeakMap<RPCClient, SensorEventFanout>();

export async function createReactiveCameraDevice(rpcOrContext: RPCClient | ReactiveCameraDeviceContext, initialCamera: Camera): Promise<ReactiveCameraDevice> {
  const cameraNamespaces: CameraNamespaces = NamespaceManager.cameraNamespaces(initialCamera._id);

  const ctx: ReactiveCameraDeviceContext | undefined =
    'rpc' in rpcOrContext && 'value' in (rpcOrContext as ReactiveCameraDeviceContext).rpc ? (rpcOrContext as ReactiveCameraDeviceContext) : undefined;
  const rpcRef: ShallowRef<RPCClient | undefined> = ctx ? (ctx.rpc as ShallowRef<RPCClient | undefined>) : shallowRef<RPCClient | undefined>(rpcOrContext as RPCClient);
  const bulkRpc = ctx?.bulkRpc;

  let closeSubscription: (() => void) | undefined;
  let closeSensorSubscription: (() => void) | undefined;
  let closed = false;
  let reconnecting: Promise<void> | undefined;
  let reconnectAgain = false;
  const reconnectRetry = createRetryTimer();
  let statesSeq = 0;
  let appliedStatesSeq = 0;
  let statesRun: Promise<void> | undefined;
  let statesNext: Promise<void> | undefined;
  let sensorRefreshQueued = false;

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
    const requestedAt = Date.now();
    try {
      const result = await requestSnapshot(sourceId, forceNew);
      if (result === NOT_MODIFIED) return getSnapshot(initialCamera._id);
      if (result && result.data.byteLength > 0) {
        const stamp = result.stamp === undefined ? undefined : { sourceId, fetchedAt: result.stamp };
        // a reply of unknown age counts as taken when it was asked for
        setSnapshot(initialCamera._id, result.data, result.fetchedAt, result.fetchedAt ?? requestedAt, stamp);
        return result.data;
      }
      return undefined;
    } finally {
      snapshotLoading.value = false;
    }
  }

  async function requestSnapshot(sourceId: string, forceNew?: boolean): Promise<FetchedSnapshot | typeof NOT_MODIFIED | undefined> {
    let lastClient: RPCClient | undefined;
    let bulkDead = false;
    try {
      // a timed out attempt keeps running on the server and fills its cache for the next one
      return await rpcCall(
        rpcRef,
        async (client) => {
          lastClient = snapshotClient(client, bulkDead);
          try {
            return await snapshotFrom(lastClient, sourceId, forceNew);
          } catch (err) {
            // a dead bulk connection stays marked up until its own ping notices, main takes over until it reconnects or answers again
            if (!bulkRpc || lastClient === client || (err as { code?: unknown }).code !== 'TIMEOUT' || (await probeBulkClient(lastClient))) throw err;
            bulkDead = true;
            markBulkDead(bulkRpc, lastClient);
            lastClient = client;
            return snapshotFrom(client, sourceId, forceNew);
          }
        },
        { retryOnTimeout: !forceNew },
      );
    } catch (err) {
      // servers that have snapshotWithMeta but keep it from viewers only let it time out
      if ((err as { code?: unknown }).code !== 'TIMEOUT' || !lastClient || snapshotWithMetaSupport.has(lastClient)) throw err;
      return rpcCall(rpcRef, (client) => legacySnapshotFrom(snapshotClient(client, bulkDead), sourceId, forceNew));
    }
  }

  function snapshotClient(client: RPCClient, mainOnly = false): RPCClient {
    return mainOnly ? client : (liveBulkClient(bulkRpc) ?? client);
  }

  async function snapshotFrom(client: RPCClient, sourceId: string, forceNew?: boolean): Promise<FetchedSnapshot | typeof NOT_MODIFIED | undefined> {
    const supported = snapshotWithMetaSupport.get(client);
    if (supported === false) return legacySnapshotFrom(client, sourceId, forceNew);
    try {
      const controller = client.createProxy<CameraDeviceInterface>(cameraNamespaces.cameraControllerRpc);
      const known = forceNew ? undefined : getSnapshotStamp(initialCamera._id, sourceId);
      const result = known === undefined ? await controller.snapshotWithMeta(sourceId, forceNew) : await controller.snapshotWithMeta(sourceId, forceNew, known);
      snapshotWithMetaSupport.set(client, true);
      if (result?.notModified) return NOT_MODIFIED;
      return result?.data ? { data: result.data, fetchedAt: Date.now() - (result.ageMs ?? 0), stamp: result.fetchedAt } : undefined;
    } catch (err) {
      if ((err as { code?: unknown }).code === 'METHOD_NOT_FOUND') {
        snapshotWithMetaSupport.set(client, false);
        return legacySnapshotFrom(client, sourceId, forceNew);
      }
      // servers before snapshotWithMeta have no responder for it, a server that answered it once only had a blip
      if (supported || !isLocalNoResponders(err)) throw err;
    }
    const result = await legacySnapshotFrom(client, sourceId, forceNew);
    // a restarted server registers its cameras one by one, a missing responder then says nothing about the method
    if (!isLinkSettling(rpcRef)) snapshotWithMetaSupport.set(client, false);
    return result;
  }

  async function legacySnapshotFrom(client: RPCClient, sourceId: string, forceNew?: boolean): Promise<FetchedSnapshot | undefined> {
    const data = await client.createProxy<CameraDeviceInterface>(cameraNamespaces.cameraControllerRpc).snapshot(sourceId, forceNew);
    // only forced fetches have a known fetch time here
    return data ? { data, fetchedAt: forceNew ? Date.now() : undefined } : undefined;
  }

  async function probeStream(sourceId: string, probeConfig?: ProbeConfig, refresh = false): Promise<ProbeStream | undefined> {
    return rpcCall(rpcRef, (client) => client.createProxy<CameraDeviceInterface>(cameraNamespaces.cameraControllerRpc).probeStream(sourceId, probeConfig, refresh), {
      retryOnTimeout: !refresh,
    });
  }

  async function streamUrl(sourceId: string): Promise<string | undefined> {
    return rpcCall(rpcRef, (client) => client.createProxy<CameraDeviceInterface>(cameraNamespaces.cameraControllerRpc).streamUrl(sourceId));
  }

  function refreshStates(): Promise<void> {
    statesNext = undefined;
    return startStatesRun();
  }

  function refreshStatesCoalesced(): Promise<void> {
    if (statesNext) return statesNext;
    if (!statesRun) return startStatesRun();
    const queuedAt = statesSeq;
    statesNext = statesRun
      .catch(() => {})
      .then(() => {
        // a call started since then already covers these callers
        if (statesSeq !== queuedAt) return statesRun;
        statesNext = undefined;
        return startStatesRun();
      });
    return statesNext;
  }

  function startStatesRun(): Promise<void> {
    const run = fetchStates(++statesSeq).finally(() => {
      if (statesRun === run) statesRun = undefined;
    });
    statesRun = run;
    return run;
  }

  async function fetchStates(seq: number): Promise<void> {
    const response: RefreshedStates = await rpcCall(rpcRef, (client) => client.createProxy<CameraDeviceInterface>(cameraNamespaces.cameraControllerRpc).refreshStates());
    // the answer to a later call is already on screen
    if (seq < appliedStatesSeq) return;
    appliedStatesSeq = seq;
    camera.value = response.camera;
    connected.value = response.cameraState;
    frameWorkerConnected.value = response.frameWorkerState;
    sensorStates.value = response.sensorStates;
  }

  function refreshForSensors(): void {
    if (sensorRefreshQueued || closed) return;
    sensorRefreshQueued = true;
    // a plugin restart reconnects all its sensors at once, their events arrive in one task
    queueMicrotask(() => {
      sensorRefreshQueued = false;
      if (!closed) refreshStatesCoalesced().catch(() => {});
    });
  }

  function dropSensorState(sensorId: string): void {
    if (sensorStates.value[sensorId] === undefined) return;
    const newStates = { ...sensorStates.value };
    delete newStates[sensorId];
    sensorStates.value = newStates;
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
      case 'snapshot:updated': {
        const { sourceId, snapshot: data, fetchedAt } = event.data;
        setSnapshot(initialCamera._id, data, fetchedAt, undefined, sourceId && fetchedAt !== undefined ? { sourceId, fetchedAt } : undefined);
        break;
      }
    }
  }

  function handleSensorEvent(event: GlobalSensorEventMessage): void {
    if (event.type === 'sensor:added') {
      const addedEvent = event.data as SensorAddedEvent;
      if (!addedEvent.sensor.assignedCameraIds.includes(initialCamera._id)) return;
      if (!addedEvent.sensor.connected) return;
      sensorStates.value = {
        ...sensorStates.value,
        [addedEvent.sensor.id]: addedEvent.state,
      };
    } else if (event.type === 'sensor:deleted') {
      dropSensorState((event.data as SensorDeletedEvent).sensorId);
    } else if (event.type === 'sensor:connected:changed') {
      const connectedEvent = event.data as SensorConnectedChangedEvent;
      if (connectedEvent.connected) {
        if (connectedEvent.assignedCameraIds && !connectedEvent.assignedCameraIds.includes(initialCamera._id)) return;
        // connect events carry no state, refetch the camera's sensor set
        refreshForSensors();
      } else {
        dropSensorState(connectedEvent.sensorId);
      }
    } else if (event.type === 'sensor:assignment:changed') {
      const assignmentEvent = event.data as SensorAssignmentChangedEvent;
      if (assignmentEvent.cameraId !== initialCamera._id) return;
      if (assignmentEvent.assigned) {
        // assignment events carry no state, refetch the camera's sensor set
        refreshForSensors();
      } else {
        dropSensorState(assignmentEvent.sensorId);
      }
    }
  }

  async function init(): Promise<void> {
    closeSubscription?.();
    closeSubscription = undefined;
    closeSensorSubscription?.();
    closeSensorSubscription = undefined;

    const cameraSubscription = await rpcCall(rpcRef, (client) => client.subscribe<CameraDeviceListenerMessagePayload>(cameraNamespaces.cameraSubject, handleCameraEvent));
    if (closed) {
      cameraSubscription();
      return;
    }
    closeSubscription = cameraSubscription;
    const sensorSubscription = await rpcCall(rpcRef, (client) => joinSensorEvents(client, handleSensorEvent));
    if (closed) {
      sensorSubscription();
      return;
    }
    closeSensorSubscription = sensorSubscription;

    await refreshStates();
  }

  function reconnect(): Promise<void> {
    if (closed) return Promise.resolve();
    reconnectRetry.cancel();
    if (reconnecting) {
      reconnectAgain = true;
      return reconnecting;
    }
    reconnecting = runReconnect();
    return reconnecting;
  }

  async function runReconnect(): Promise<void> {
    try {
      do {
        reconnectAgain = false;
        await init();
      } while (reconnectAgain && !closed);
      reconnectRetry.reset();
    } catch (err) {
      // without a retry a camera that failed here keeps a stale state, or no event subscriptions at all
      scheduleReconnect();
      throw err;
    } finally {
      reconnecting = undefined;
    }
  }

  function scheduleReconnect(): void {
    if (closed) return;
    reconnectRetry.schedule(() => {
      reconnect().catch(() => {});
    });
  }

  async function close(): Promise<void> {
    closed = true;
    reconnectRetry.cancel();

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

  try {
    await init();
  } catch (err) {
    await close();
    throw err;
  }

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
    reconnect,
    close,
  };
}

async function joinSensorEvents(client: RPCClient, handler: SensorEventHandler): Promise<() => void> {
  let fanout = sensorEventFanouts.get(client);
  if (!fanout) {
    const handlers = new Set<SensorEventHandler>();
    const subject = NamespaceManager.sensorRegistryNamespaces().sensorsSubject;
    fanout = {
      handlers,
      subscribed: client.subscribe<GlobalSensorEventMessage>(subject, (event) => {
        for (const each of handlers) {
          try {
            each(event);
          } catch {
            // one camera's handler must not cost the others the event
          }
        }
      }),
    };
    sensorEventFanouts.set(client, fanout);
  }
  const joined = fanout;
  joined.handlers.add(handler);
  try {
    await joined.subscribed;
  } catch (err) {
    joined.handlers.delete(handler);
    if (sensorEventFanouts.get(client) === joined) sensorEventFanouts.delete(client);
    throw err;
  }
  return () => leaveSensorEvents(client, joined, handler);
}

function leaveSensorEvents(client: RPCClient, fanout: SensorEventFanout, handler: SensorEventHandler): void {
  if (!fanout.handlers.delete(handler) || fanout.handlers.size > 0) return;
  if (sensorEventFanouts.get(client) === fanout) sensorEventFanouts.delete(client);
  fanout.subscribed.then((off) => off()).catch(() => {});
}
