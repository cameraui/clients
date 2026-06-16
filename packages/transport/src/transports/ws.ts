import { isEndpointChange, isSameTarget, TransportEmitter } from './contract.js';

import type { ConnectionTarget, TransportSpec, TransportStatus } from '../core/types.js';
import type { PerResourceTransport, TransportEvent, TransportEventHandler, Unsubscribe } from './contract.js';

const WS_SPEC: TransportSpec = {
  id: 'ws',
  kind: 'per-resource',
  phaseGating: false,
};

const WS_CLOSE_TARGET_CHANGED = 4000;
const WS_CLOSE_DETACHED = 4001;
const WS_CLOSE_DISPOSED = 4002;

export interface WsHandleSpec {
  readonly path: string;
  readonly query?: Record<string, string>;
  readonly protocols?: string | readonly string[];
  readonly binaryType?: 'arraybuffer' | 'blob';
}

export type WsEvent = 'open' | 'close' | 'message' | 'error';

export interface WsCloseInfo {
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;
}

export type WsEventPayload<E extends WsEvent> = E extends 'open'
  ? void
  : E extends 'close'
    ? WsCloseInfo
    : E extends 'message'
      ? MessageEvent
      : E extends 'error'
        ? Event
        : never;

export type WsEventHandler<E extends WsEvent> = (payload: WsEventPayload<E>) => void;

export interface WsHandle {
  readonly readyState: number;
  readonly url: string | null;
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  on<E extends WsEvent>(event: E, handler: WsEventHandler<E>): Unsubscribe;
  dispose(): void;
}

export interface WsTransportOptions {
  readonly spec?: Partial<TransportSpec>;
  readonly webSocketCtor?: typeof WebSocket;
  readonly tokenParam?: string;
  readonly sessionParam?: string;
}

export interface WsTransport extends PerResourceTransport<WsHandle, WsHandleSpec> {
  readonly handleCount: number;
}

interface InternalHandle {
  api: WsHandle;
  readonly spec: WsHandleSpec;
  readonly listeners: { [E in WsEvent]: Set<WsEventHandler<E>> };
  ws: WebSocket | null;
  url: string | null;
  disposed: boolean;
}

export function createWsTransport(options: WsTransportOptions = {}): WsTransport {
  const spec: TransportSpec = { ...WS_SPEC, ...options.spec };
  const tokenParam = options.tokenParam ?? 'token';
  const sessionParam = options.sessionParam ?? 'session';
  const WsCtor = options.webSocketCtor ?? (typeof WebSocket !== 'undefined' ? WebSocket : undefined);

  const emitter = new TransportEmitter();
  const handles = new Set<InternalHandle>();
  let currentTarget: ConnectionTarget | null = null;
  let status: TransportStatus = { up: false };
  let disposed = false;

  function ensureCtor(): typeof WebSocket {
    if (!WsCtor) {
      throw new Error('ws-transport: no WebSocket constructor available; pass webSocketCtor in non-browser environments');
    }
    return WsCtor;
  }

  function buildUrl(target: ConnectionTarget, handleSpec: WsHandleSpec): string {
    const base = new URL(target.endpoint.url);
    const wsProtocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
    const port = base.port || (base.protocol === 'https:' ? '443' : '80');
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(handleSpec.query ?? {})) {
      if (v !== undefined && v !== null && v !== '') params.set(k, v);
    }
    params.set(tokenParam, target.tokens.access);
    if (target.tokens.proxySession) params.set(sessionParam, target.tokens.proxySession);
    return `${wsProtocol}//${base.hostname}:${port}${handleSpec.path}?${params.toString()}`;
  }

  function isAuthCloseEvent(event: CloseEvent): boolean {
    if (event.code === 1008 || event.code === 4401) return true;
    if (!event.reason) return false;
    const lower = event.reason.toLowerCase();
    return lower.includes('unauthorized') || lower.includes('forbidden') || lower.includes('401') || lower.includes('403');
  }

  function bindWs(handle: InternalHandle, ws: WebSocket): void {
    ws.onopen = () => {
      if (handle.disposed || handle.ws !== ws) return;
      if (!status.up) {
        status = { up: true };
        emitter.emit('up', undefined);
      }
      for (const fn of [...handle.listeners.open]) fn();
    };
    ws.onclose = (event: CloseEvent) => {
      if (handle.ws === ws) {
        handle.ws = null;
        handle.url = null;
      }
      if (isAuthCloseEvent(event)) {
        emitter.emit('auth-error', { message: event.reason || `ws close code ${event.code}` });
      }
      const info: WsCloseInfo = { code: event.code, reason: event.reason, wasClean: event.wasClean };
      for (const fn of [...handle.listeners.close]) fn(info);
    };
    ws.onmessage = (event: MessageEvent) => {
      if (handle.disposed || handle.ws !== ws) return;
      for (const fn of [...handle.listeners.message]) fn(event);
    };
    ws.onerror = (event: Event) => {
      if (handle.disposed || handle.ws !== ws) return;
      for (const fn of [...handle.listeners.error]) fn(event);
    };
  }

  function closeWs(handle: InternalHandle, code: number, reason: string): void {
    const ws = handle.ws;
    if (!ws) return;
    const Ctor = ensureCtor();
    if (ws.readyState === Ctor.OPEN || ws.readyState === Ctor.CONNECTING) {
      // Native onclose drives the close-event delivery so we don't double-fire.
      try {
        ws.close(code, reason);
      } catch {
        // closing a half-dead socket — nothing actionable
      }
      return;
    }
    // Socket already gone — synthesize a close so listeners learn about it.
    if (handle.ws === ws) {
      handle.ws = null;
      handle.url = null;
    }
    const info: WsCloseInfo = { code, reason, wasClean: false };
    for (const fn of [...handle.listeners.close]) fn(info);
  }

  function openWs(handle: InternalHandle): void {
    if (handle.disposed) return;
    if (!currentTarget) return;
    const url = buildUrl(currentTarget, handle.spec);
    const Ctor = ensureCtor();
    const ws = new Ctor(url, handle.spec.protocols as string | string[] | undefined);
    if (handle.spec.binaryType) ws.binaryType = handle.spec.binaryType;
    handle.ws = ws;
    handle.url = url;
    bindWs(handle, ws);
  }

  function recycleAll(code: number, reason: string): void {
    // Snapshot first — `close` listeners may dispose their handle (mutates `handles`).
    const snapshot = [...handles];
    for (const handle of snapshot) {
      closeWs(handle, code, reason);
    }
    if (status.up) {
      status = { up: false, lastError: reason };
      emitter.emit('down', { reason });
    }
    if (!currentTarget) return;
    // Re-open every handle that's still alive after the close-event callbacks.
    for (const handle of handles) {
      if (!handle.disposed) openWs(handle);
    }
  }

  async function apply(target: ConnectionTarget | null): Promise<void> {
    if (disposed) throw new Error('ws-transport disposed');
    if (isSameTarget(currentTarget, target)) return;

    const endpointChanged = isEndpointChange(currentTarget, target);
    currentTarget = target;

    if (!target) {
      // Snapshot — `close` callbacks may dispose their handle.
      const snapshot = [...handles];
      for (const handle of snapshot) {
        closeWs(handle, WS_CLOSE_DETACHED, 'detached');
      }
      status = { up: false };
      emitter.emit('down', { reason: 'detached' });
      return;
    }

    if (endpointChanged) {
      recycleAll(WS_CLOSE_TARGET_CHANGED, 'endpoint-changed');
    }
  }

  function health(): TransportStatus {
    return status;
  }

  function on<E extends TransportEvent>(event: E, handler: TransportEventHandler<E>): Unsubscribe {
    return emitter.on(event, handler);
  }

  async function dispose(): Promise<void> {
    disposed = true;
    const snapshot = [...handles];
    for (const handle of snapshot) {
      handle.disposed = true;
      handle.listeners.open.clear();
      handle.listeners.close.clear();
      handle.listeners.message.clear();
      handle.listeners.error.clear();
      closeWs(handle, WS_CLOSE_DISPOSED, 'disposed');
    }
    handles.clear();
    currentTarget = null;
    status = { up: false };
    emitter.clear();
  }

  function open(handleSpec: WsHandleSpec): WsHandle {
    if (disposed) throw new Error('ws-transport disposed');
    const handle: InternalHandle = {
      api: undefined as unknown as WsHandle,
      spec: handleSpec,
      listeners: { open: new Set(), close: new Set(), message: new Set(), error: new Set() },
      ws: null,
      url: null,
      disposed: false,
    };

    function send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      if (handle.disposed) throw new Error('ws-handle disposed');
      const ws = handle.ws;
      if (!ws) throw new Error('ws-handle: no active socket');
      if (ws.readyState !== WsCtor!.OPEN) throw new Error('ws-handle: socket not open');
      ws.send(data as never);
    }

    function close(code?: number, reason?: string): void {
      closeWs(handle, code ?? 1000, reason ?? '');
    }

    function onHandle<E extends WsEvent>(event: E, handler: WsEventHandler<E>): Unsubscribe {
      const set = handle.listeners[event] as Set<WsEventHandler<E>>;
      set.add(handler);
      return () => {
        set.delete(handler);
      };
    }

    function disposeHandle(): void {
      if (handle.disposed) return;
      handle.disposed = true;
      handle.listeners.open.clear();
      handle.listeners.close.clear();
      handle.listeners.message.clear();
      handle.listeners.error.clear();
      closeWs(handle, WS_CLOSE_DISPOSED, 'disposed');
      handles.delete(handle);
    }

    handle.api = {
      get readyState() {
        return handle.ws?.readyState ?? WsCtor?.CLOSED ?? 3;
      },
      get url() {
        return handle.url;
      },
      send,
      close,
      on: onHandle,
      dispose: disposeHandle,
    };

    handles.add(handle);
    if (currentTarget) openWs(handle);
    return handle.api;
  }

  return {
    get spec() {
      return spec;
    },
    get handleCount() {
      return handles.size;
    },
    apply,
    health,
    on,
    dispose,
    open,
  };
}
