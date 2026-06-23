export { createKernel } from './core/kernel.js';
export { reducer } from './core/reducer.js';
export { endpointKey, isSameEndpoint, sortByPriority } from './core/resolver.js';
export { attachBackoff } from './effects/backoff.js';
export { attachCrossTab } from './effects/crossTab.js';
export { attachNetworkChange } from './effects/networkChange.js';
export { attachPersistence, localStorageAdapter, memoryStorageAdapter } from './effects/persistence.js';
export { attachPresence, defaultOnNetworkOnline } from './effects/presence.js';
export { attachProbeLoop, isProbeFailure, makeProbeFailure } from './effects/probeLoop.js';
export { attachReconnectWatchdog } from './effects/reconnectWatchdog.js';
export { attachTokenLifecycle } from './effects/tokenLifecycle.js';
export { attachTransportSync } from './effects/transportSync.js';
export { attachTransportWatchdog } from './effects/transportWatchdog.js';
export { attachWorkerBridge } from './effects/workerBridge.js';
export { DEFAULT_RACE_TIMEOUT_BY_MODE, raceFirst, RaceFirstError } from './race.js';
export { isEndpointChange, isSameTarget, isTokenOnlyChange, TransportEmitter } from './transports/contract.js';

export type {
  Action,
  BackoffHint,
  ConnectionPhase,
  ConnectionTarget,
  Endpoint,
  EndpointMode,
  ReconnectCause,
  ReducerContext,
  Tokens,
  TransportId,
  TransportKind,
  TransportSpec,
  TransportStatus,
} from './core/types.js';
export type { Kernel, KernelOptions, Listener, Unsubscribe } from './core/kernel.js';
export type { BackoffOptions } from './effects/backoff.js';
export type { CrossTabOptions, CrossTabSource } from './effects/crossTab.js';
export type { NetworkChangeOptions, NetworkChangeSource } from './effects/networkChange.js';
export type { PersistedTarget, Persistence, PersistenceOptions, StorageAdapter } from './effects/persistence.js';
export type { PresenceCallback, PresenceOptions, VisibilitySource } from './effects/presence.js';
export type { ProbeContext, ProbeFailure, ProbeFailureKind, ProbeLoopOptions } from './effects/probeLoop.js';
export type { ReconnectWatchdogOptions } from './effects/reconnectWatchdog.js';
export type { Detach, RefreshReason, TokenLifecycle, TokenLifecycleOptions } from './effects/tokenLifecycle.js';
export type { TransportSyncOptions } from './effects/transportSync.js';
export type { TransportWatchdogOptions, WatchdogClearReason } from './effects/transportWatchdog.js';
export type { WorkerBridge, WorkerBridgeOptions } from './effects/workerBridge.js';
export type { RaceCandidate, RaceFirstOptions, RaceFirstResult, TimeoutByModeFn } from './race.js';
export type { KernelSyncMessage, KernelSyncRequestMessage, MessageSource, WorkerHost, WorkerMessage } from './worker/protocol.js';
export type { PerResourceTransport, Transport, TransportEvent, TransportEventHandler, TransportEventPayload } from './transports/contract.js';
