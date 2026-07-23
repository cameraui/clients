import type { ConnectionTarget, TransportSpec, TransportStatus } from '../core/types.js';

export type TransportEvent = 'up' | 'down' | 'auth-error';

export type TransportEventPayload<E extends TransportEvent> = E extends 'down'
  ? { readonly reason: string }
  : E extends 'auth-error'
    ? { readonly status?: number; readonly message?: string }
    : void;

export type TransportEventHandler<E extends TransportEvent> = (payload: TransportEventPayload<E>) => void;

export type Unsubscribe = () => void;

export interface Transport {
  readonly spec: TransportSpec;
  apply(target: ConnectionTarget | null): Promise<void>;
  health(): TransportStatus;
  ensureAlive?(): Promise<TransportStatus>;
  on<E extends TransportEvent>(event: E, handler: TransportEventHandler<E>): Unsubscribe;
  dispose(): Promise<void>;
}

export interface PerResourceTransport<R = unknown, S = unknown> extends Transport {
  open(spec: S): R;
}

export function isSameTarget(a: ConnectionTarget | null, b: ConnectionTarget | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.endpoint.url !== b.endpoint.url || a.endpoint.mode !== b.endpoint.mode) return false;
  if (a.tokens.access !== b.tokens.access) return false;
  if ((a.tokens.proxySession ?? null) !== (b.tokens.proxySession ?? null)) return false;
  return true;
}

export function isEndpointChange(a: ConnectionTarget | null, b: ConnectionTarget | null): boolean {
  if (a === b) return false;
  if (!a || !b) return true;
  return a.endpoint.url !== b.endpoint.url || a.endpoint.mode !== b.endpoint.mode;
}

export class TransportEmitter {
  private readonly listeners: Map<TransportEvent, Set<(payload: any) => void>> = new Map();

  on<E extends TransportEvent>(event: E, handler: TransportEventHandler<E>): Unsubscribe {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
    };
  }

  emit<E extends TransportEvent>(event: E, payload: TransportEventPayload<E>): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      fn(payload);
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
