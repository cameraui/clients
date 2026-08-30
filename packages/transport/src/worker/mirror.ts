import type { ConnectionPhase, ConnectionTarget } from '../core/types.js';
import type { MessageSource, WorkerMessage } from './protocol.js';

export type Unsubscribe = () => void;

export type MirrorListener = (next: ConnectionPhase, prev: ConnectionPhase) => void;

export interface MirrorResolveContext {
  readonly connId: string;
  readonly defaultServers: readonly string[];
}

export interface WorkerKernelMirror {
  readonly phase: ConnectionPhase;
  readonly target: ConnectionTarget | null;
  readonly hasResolver: boolean;
  subscribe(listener: MirrorListener): Unsubscribe;
  onRevalidate(listener: () => void): Unsubscribe;
  requestSync(): void;
  resolveServers(ctx: MirrorResolveContext): Promise<string[]>;
  dispose(): void;
}

export interface WorkerKernelMirrorOptions {
  readonly source: MessageSource;
  readonly initial?: ConnectionPhase;
  readonly resolveTimeoutMs?: number;
}

interface PendingResolve {
  resolve: (servers: string[]) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function createWorkerKernelMirror(options: WorkerKernelMirrorOptions): WorkerKernelMirror {
  let current: ConnectionPhase = options.initial ?? { kind: 'idle' };
  let lastGeneration = -1;
  let hasResolver = false;
  const listeners = new Set<MirrorListener>();
  const revalidateListeners = new Set<() => void>();
  const pending = new Map<number, PendingResolve>();
  const resolveTimeoutMs = options.resolveTimeoutMs ?? 15_000;
  let nextResolveId = 1;
  let disposed = false;

  function settleResolve(id: number, servers?: string[], error?: string): void {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    if (error !== undefined || !servers) entry.reject(new Error(error ?? 'resolve failed'));
    else entry.resolve(servers);
  }

  function handler(event: MessageEvent<WorkerMessage>): void {
    if (disposed) return;
    const msg = event.data;
    if (!msg) return;

    if (msg.type === 'kernel-resolve-reply') {
      settleResolve(msg.id, msg.servers, msg.error);
      return;
    }

    if (msg.type === 'kernel-revalidate') {
      for (const l of [...revalidateListeners]) {
        try {
          l();
        } catch {
          // ignore
        }
      }
      return;
    }

    if (msg.type !== 'kernel-sync') return;
    if (msg.generation <= lastGeneration) return; // stale or duplicate
    lastGeneration = msg.generation;
    hasResolver = msg.resolver === true;
    const prev = current;
    current = msg.phase;
    if (phaseEquals(prev, current)) return;
    for (const l of [...listeners]) {
      try {
        l(current, prev);
      } catch {
        // ignore
      }
    }
  }

  options.source.addEventListener('message', handler);

  function targetOf(p: ConnectionPhase): ConnectionTarget | null {
    if (p.kind === 'online') return p.target;
    return null;
  }

  function phaseEquals(a: ConnectionPhase, b: ConnectionPhase): boolean {
    if (a.kind !== b.kind) return false;
    const ta = targetOf(a);
    const tb = targetOf(b);
    if (ta === null || tb === null) return ta === tb;
    return (
      ta.endpoint.url === tb.endpoint.url &&
      ta.endpoint.mode === tb.endpoint.mode &&
      ta.tokens.access === tb.tokens.access &&
      ta.tokens.proxySession === tb.tokens.proxySession &&
      ta.tokens.refresh === tb.tokens.refresh
    );
  }

  return {
    get phase() {
      return current;
    },
    get target() {
      return targetOf(current);
    },
    get hasResolver() {
      return hasResolver;
    },
    subscribe(listener: MirrorListener): Unsubscribe {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onRevalidate(listener: () => void): Unsubscribe {
      revalidateListeners.add(listener);
      return () => {
        revalidateListeners.delete(listener);
      };
    },
    requestSync(): void {
      if (disposed) return;
      options.source.postMessage({ type: 'kernel-sync-request' });
    },
    resolveServers(ctx: MirrorResolveContext): Promise<string[]> {
      if (disposed) return Promise.reject(new Error('mirror disposed'));
      const id = nextResolveId++;
      return new Promise<string[]>((resolve, reject) => {
        const timer = setTimeout(() => settleResolve(id, undefined, 'resolve timeout'), resolveTimeoutMs);
        pending.set(id, { resolve, reject, timer });
        options.source.postMessage({ type: 'kernel-resolve-request', id, connId: ctx.connId, defaultServers: [...ctx.defaultServers] });
      });
    },
    dispose(): void {
      disposed = true;
      options.source.removeEventListener('message', handler);
      listeners.clear();
      revalidateListeners.clear();
      for (const id of [...pending.keys()]) settleResolve(id, undefined, 'mirror disposed');
    },
  };
}
