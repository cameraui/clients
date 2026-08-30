import { Logger } from '@camera.ui/logger';

import type { Kernel } from '../core/kernel.js';
import type { ConnectionPhase, ConnectionTarget } from '../core/types.js';
import type { KernelResolveReplyMessage, KernelResolveRequestMessage, KernelSyncMessage, WorkerHost, WorkerMessage } from '../worker/protocol.js';

const log = new Logger('workerBridge');

export type Detach = () => void;

export interface BridgeResolveContext {
  readonly target: ConnectionTarget;
  readonly connId: string;
  readonly defaultServers: readonly string[];
}

export interface WorkerBridgeOptions {
  readonly kernel: Kernel;
  readonly listenForResyncRequests?: boolean;
  readonly hosts: () => Iterable<WorkerHost>;
  readonly resolveServers?: (ctx: BridgeResolveContext) => Promise<string[]>;
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
    return { type: 'kernel-sync', generation, phase, resolver: options.resolveServers !== undefined };
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
        log.warn('broadcast postMessage failed', { gen: msg.generation, phase: phase.kind, err });
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
      log.warn('syncOne postMessage failed', { gen: msg.generation, err });
    }
  }

  async function answerResolve(host: WorkerHost, req: KernelResolveRequestMessage): Promise<void> {
    const reply = (msg: Omit<KernelResolveReplyMessage, 'type' | 'id'>): void => {
      try {
        host.postMessage({ type: 'kernel-resolve-reply', id: req.id, ...msg });
      } catch (err) {
        log.warn('resolve reply postMessage failed', err);
      }
    };
    if (!options.resolveServers) {
      reply({ servers: [...req.defaultServers] });
      return;
    }
    const phase = options.kernel.phase;
    if (phase.kind !== 'online') {
      reply({ error: `kernel ${phase.kind}` });
      return;
    }
    try {
      reply({ servers: await options.resolveServers({ target: phase.target, connId: req.connId, defaultServers: req.defaultServers }) });
    } catch (err) {
      reply({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  function maybeAttachHostListener(host: WorkerHost): void {
    if (!options.listenForResyncRequests && !options.resolveServers) return;
    if (!host.addEventListener) return;
    if (hostListenerCleanups.has(host)) return; // already wired
    const listener = (event: MessageEvent<WorkerMessage>): void => {
      if (detached) return;
      const msg = event.data;
      if (msg?.type === 'kernel-sync-request' && options.listenForResyncRequests) {
        syncOne(host);
      } else if (msg?.type === 'kernel-resolve-request') {
        answerResolve(host, msg);
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
          log.warn('revalidate postMessage failed', err);
        }
      }
    },
  };
}
