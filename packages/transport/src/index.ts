export { createKernel } from './core/kernel.js';
export { reducer } from './core/reducer.js';
export { createBackgroundProbe } from './effects/backgroundProbe.js';
export { attachBackoff } from './effects/backoff.js';
export { attachCrossTab } from './effects/crossTab.js';
export { attachDegradedRecovery } from './effects/degradedRecovery.js';
export { attachNetworkChange } from './effects/networkChange.js';
export { attachPersistence, localStorageAdapter, memoryStorageAdapter } from './effects/persistence.js';
export { attachPresence } from './effects/presence.js';
export { attachProbeLoop, isProbeFailure, makeProbeFailure } from './effects/probeLoop.js';
export { attachTokenLifecycle } from './effects/tokenLifecycle.js';
export { attachTransportSync } from './effects/transportSync.js';
export { attachWorkerBridge } from './effects/workerBridge.js';
export { createConnectionJournal } from './journal.js';
export { raceFirst } from './race.js';
export { createConnectionSignal } from './signal.js';
export { classifyClose } from './transports/closeCodes.js';
export { isEndpointChange, isSameTarget, TransportEmitter } from './transports/contract.js';

export type { Kernel, KernelOptions, Listener, Unsubscribe } from './core/kernel.js';
export type {
  Action,
  BackoffHint,
  ConnectionPhase,
  ConnectionTarget,
  Endpoint,
  EndpointMode,
  ReducerContext,
  Tokens,
  TransportId,
  TransportKind,
  TransportSpec,
  TransportStatus,
} from './core/types.js';
export type { BackgroundProbe, BackgroundProbeOptions, BackgroundProbeOutcome } from './effects/backgroundProbe.js';
export type { BackoffOptions } from './effects/backoff.js';
export type { CrossTabOptions, CrossTabSource } from './effects/crossTab.js';
export type { DegradedRecoveryOptions } from './effects/degradedRecovery.js';
export type { NetworkChangeOptions, NetworkChangeSource } from './effects/networkChange.js';
export type { PersistedTarget, Persistence, PersistenceOptions, StorageAdapter } from './effects/persistence.js';
export type { PresenceCallback, PresenceOptions, VisibilitySource } from './effects/presence.js';
export type { ProbeContext, ProbeFailure, ProbeFailureKind, ProbeLoopOptions } from './effects/probeLoop.js';
export type { Detach, RefreshReason, TokenLifecycle, TokenLifecycleOptions } from './effects/tokenLifecycle.js';
export type { TransportSyncOptions } from './effects/transportSync.js';
export type { WorkerBridge, WorkerBridgeOptions } from './effects/workerBridge.js';
export type { ConnectionJournal, JournalEntry, JournalOptions } from './journal.js';
export type { RaceCandidate, RaceFirstOptions, RaceFirstResult, TimeoutByModeFn } from './race.js';
export type { ConnectionSignal, ConnectionSignalHandle, ConnectionSignalOptions } from './signal.js';
export type { CloseClass, CloseLike } from './transports/closeCodes.js';
export type { PerResourceTransport, Transport, TransportEvent, TransportEventHandler, TransportEventPayload } from './transports/contract.js';
export type { KernelSyncMessage, KernelSyncRequestMessage, MessageSource, WorkerHost, WorkerMessage } from './worker/protocol.js';
