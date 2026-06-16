import type { Kernel } from '../core/kernel.js';
import type { ConnectionPhase } from '../core/types.js';
import type { KernelSyncMessage, WorkerHost, WorkerMessage } from '../worker/protocol.js';

export type Detach = () => void;

export interface WorkerBridgeOptions {
  readonly kernel: Kernel;
  readonly hosts: () => Iterable<WorkerHost>;
  readonly listenForResyncRequests?: boolean;
  readonly onBroadcast?: (generation: number, hostCount: number) => void;
  readonly onSyncHost?: (generation: number) => void;
}

export interface WorkerBridge {
  readonly detach: Detach;
  syncHost(host: WorkerHost): void;
  syncAll(): void;
  revalidateWorkers(): void;
}

export function attachWorkerBridge(options: WorkerBridgeOptions): WorkerBridge {
  let generation = 0;
  let detached = false;
  const hostListenerCleanups = new Map<WorkerHost, () => void>();

  function makeSync(phase: ConnectionPhase): KernelSyncMessage {
    generation++;
    return { type: 'kernel-sync', generation, phase };
  }

  function broadcast(phase: ConnectionPhase): void {
    if (detached) return;
    const msg = makeSync(phase);
    let count = 0;
    for (const host of options.hosts()) {
      try {
        host.postMessage(msg);
        count++;
        maybeAttachHostListener(host);
      } catch (err) {
        console.warn('[workerBridge] broadcast postMessage failed', { gen: msg.generation, phase: phase.kind, err });
      }
    }
    options.onBroadcast?.(generation, count);
  }

  function syncOne(host: WorkerHost): void {
    if (detached) return;
    const msg = makeSync(options.kernel.phase);
    try {
      host.postMessage(msg);
      maybeAttachHostListener(host);
      options.onSyncHost?.(generation);
    } catch (err) {
      console.warn('[workerBridge] syncOne postMessage failed', { gen: msg.generation, err });
    }
  }

  function maybeAttachHostListener(host: WorkerHost): void {
    if (!options.listenForResyncRequests) return;
    if (!host.addEventListener) return;
    if (hostListenerCleanups.has(host)) return; // already wired
    const listener = (event: MessageEvent<WorkerMessage>): void => {
      if (detached) return;
      if (event.data?.type === 'kernel-sync-request') {
        syncOne(host);
      }
    };
    host.addEventListener('message', listener);
    hostListenerCleanups.set(host, () => {
      host.removeEventListener?.('message', listener);
    });
  }

  const unsubKernel = options.kernel.subscribe((next) => {
    broadcast(next);
  });

  return {
    detach() {
      detached = true;
      unsubKernel();
      for (const cleanup of hostListenerCleanups.values()) cleanup();
      hostListenerCleanups.clear();
    },
    syncHost(host: WorkerHost) {
      syncOne(host);
    },
    syncAll() {
      broadcast(options.kernel.phase);
    },
    revalidateWorkers() {
      if (detached) return;
      for (const host of options.hosts()) {
        try {
          host.postMessage({ type: 'kernel-revalidate' });
          maybeAttachHostListener(host);
        } catch (err) {
          console.warn('[workerBridge] revalidate postMessage failed', err);
        }
      }
    },
  };
}
