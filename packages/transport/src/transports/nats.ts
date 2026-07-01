import { createRPCClient } from '@camera.ui/rpc';

import { isEndpointChange, isSameTarget, TransportEmitter } from './contract.js';

import type { RPCClient } from '@camera.ui/rpc';
import type { ConnectionTarget, TransportSpec, TransportStatus } from '../core/types.js';
import type { Transport, TransportEvent, TransportEventHandler, Unsubscribe } from './contract.js';

const NATS_SPEC: TransportSpec = {
  id: 'nats',
  kind: 'persistent',
  phaseGating: true,
  graceMs: 4_000,
};

export interface NatsTransportOptions {
  readonly spec?: Partial<TransportSpec>;
  readonly proxyPath?: string;
  readonly clientName?: string;
  readonly natsUser?: string;
  readonly natsPassword?: string;
  readonly reconnectTimeWait?: number;
  readonly reconnectionDelayMax?: number;
  readonly reconnectionRandomizationFactor?: number;
  readonly timeout?: number;
  readonly pingInterval?: number;
  readonly pingTimeout?: number;
  readonly maxPingOut?: number;
}

export type NatsClientListener = (client: RPCClient | null) => void;

export interface NatsTransport extends Transport {
  getClient(): RPCClient | null;
  subscribeClient(listener: NatsClientListener): Unsubscribe;
  probeAlive(timeoutMs?: number): Promise<void>;
  forceReconnect(): Promise<void>;
}

function newConnId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  if (c?.getRandomValues) {
    const bytes = new Uint8Array(16);
    c.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export function createNatsTransport(options: NatsTransportOptions = {}): NatsTransport {
  const spec: TransportSpec = { ...NATS_SPEC, ...options.spec };
  const proxyPath = options.proxyPath ?? '/api/proxy';
  const clientName = options.clientName ?? '@camera.ui/transport/nats';
  const natsUser = options.natsUser ?? 'secret';
  const natsPassword = options.natsPassword ?? 'secret';
  const reconnectTimeWait = options.reconnectTimeWait ?? 1_000;
  const reconnectionDelayMax = options.reconnectionDelayMax ?? 5_000;
  const reconnectionRandomizationFactor = options.reconnectionRandomizationFactor ?? 0.5;
  const timeout = options.timeout ?? 10_000;
  const pingInterval = options.pingInterval ?? 25_000;
  const pingTimeout = options.pingTimeout ?? 20_000;
  const maxPingOut = options.maxPingOut ?? 1;

  const emitter = new TransportEmitter();
  const clientListeners = new Set<NatsClientListener>();
  let proxy: RPCClient | null = null;
  let currentTarget: ConnectionTarget | null = null;
  let status: TransportStatus = { up: false };
  let statusAbort: AbortController | null = null;
  let disposed = false;
  // Stable for the lifetime of the current RPCClient (regenerated per rebuildClient).
  // Kept in sync between the proxy URL (?connId=) and the client's reply subjects.
  let connId: string | null = null;

  function buildServers(target: ConnectionTarget): string[] {
    const url = new URL(target.endpoint.url);
    const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    const params = new URLSearchParams({ token: target.tokens.access });
    if (target.tokens.proxySession) params.set('session', target.tokens.proxySession);
    if (connId) params.set('connId', connId);
    return [`${wsProtocol}//${url.hostname}:${port}${proxyPath}?${params.toString()}`];
  }

  function notifyClient(): void {
    // Surface only when actually connected. Internal nats-lib reconnect
    // keeps the same `proxy` reference alive across drops, so a passive
    // `fn(proxy)` would never let listeners observe the drop/recovery
    // transition. Listeners get `null` while we're down and the live
    // client when we're up.
    const next = status.up ? proxy : null;
    for (const fn of [...clientListeners]) {
      try {
        fn(next);
      } catch {
        // listener-side error must not break the transport
      }
    }
  }

  function markUp(): void {
    if (status.up) return;
    status = { up: true };
    emitter.emit('up', undefined);
  }

  function markDown(reason: string): void {
    if (!status.up && status.lastError === reason) return;
    status = { up: false, lastError: reason };
    emitter.emit('down', { reason });
  }

  function stopStatusMonitor(): void {
    statusAbort?.abort();
    statusAbort = null;
  }

  function startStatusMonitor(p: RPCClient): void {
    stopStatusMonitor();
    const abort = new AbortController();
    statusAbort = abort;

    (async () => {
      const iter = p.status();
      if (!iter) return;
      for await (const event of iter) {
        if (abort.signal.aborted) break;
        switch (event.type) {
          case 'reconnect':
            markUp();
            notifyClient();
            break;
          case 'disconnect':
            markDown('disconnect');
            notifyClient();
            break;
          case 'staleConnection':
            // Heartbeat detected silent failure. Library should follow up with
            // disconnect but the transport-close path can be slow / silent on
            // truly-dead sockets — treat staleConnection as authoritative.
            markDown('staleConnection');
            notifyClient();
            break;
          case 'error':
            handleErrorEvent(event as { data?: unknown });
            break;
        }
      }
    })().catch(() => {
      // iterator closes on disconnect — expected
    });
  }

  function handleErrorEvent(event: { data?: unknown }): void {
    const message = stringifyError(event.data);
    const lower = message.toLowerCase();
    if (lower.includes('auth') || lower.includes('401') || lower.includes('forbidden') || lower.includes('403')) {
      emitter.emit('auth-error', { message });
      return;
    }
    markDown(message);
  }

  async function rebuildClient(target: ConnectionTarget): Promise<void> {
    stopStatusMonitor();
    if (proxy) {
      try {
        proxy.abortClose();
      } catch {
        // ignore — closing a half-dead client; nothing actionable
      }
      proxy = null;
      notifyClient();
    }

    // Fresh per-connection token BEFORE buildServers so the proxy URL and the
    // client's reply subjects carry the same connId.
    connId = newConnId();
    const servers = buildServers(target);
    const next = createRPCClient({
      servers,
      name: clientName,
      connId,
      auth: { user: natsUser, password: natsPassword },
      reconnect: true,
      maxReconnectAttempts: -1,
      reconnectTimeWait,
      reconnectionDelayMax,
      reconnectionRandomizationFactor,
      timeout,
      pingInterval,
      pingTimeout,
      maxPingOut,
      ignoreAuthErrorAbort: true,
    });

    try {
      await next.connect();
    } catch (err) {
      try {
        next.abortClose();
      } catch {
        // ignore
      }
      const msg = err instanceof Error ? err.message : String(err);
      markDown(msg);
      throw err;
    }

    proxy = next;
    // markUp BEFORE notifyClient — notifyClient gates on status.up, so we
    // need the up-flag set before we tell listeners we have a live client.
    markUp();
    notifyClient();
    startStatusMonitor(next);
  }

  async function apply(target: ConnectionTarget | null): Promise<void> {
    if (disposed) throw new Error('nats-transport disposed');
    if (isSameTarget(currentTarget, target)) return;

    const endpointChanged = isEndpointChange(currentTarget, target);
    currentTarget = target;

    if (!target) {
      stopStatusMonitor();
      if (proxy) {
        try {
          proxy.abortClose();
        } catch {
          // ignore
        }
        proxy = null;
        notifyClient();
      }
      markDown('detached');
      return;
    }

    if (endpointChanged || !proxy) {
      await rebuildClient(target);
      return;
    }

    // Token-only change: update server-list. Live connection keeps the old
    // token (server only validates at handshake); the new token applies at
    // the next natural reconnect. This matches the existing managed.ts
    // behaviour and avoids gratuitous disconnects on every refresh.
    const newServers = buildServers(target);
    proxy.setServers(newServers);
  }

  function health(): TransportStatus {
    return status;
  }

  function on<E extends TransportEvent>(event: E, handler: TransportEventHandler<E>): Unsubscribe {
    return emitter.on(event, handler);
  }

  async function dispose(): Promise<void> {
    disposed = true;
    stopStatusMonitor();
    if (proxy) {
      try {
        proxy.abortClose();
      } catch {
        // ignore
      }
      proxy = null;
      notifyClient();
    }
    clientListeners.clear();
    status = { up: false };
    emitter.clear();
  }

  function getClient(): RPCClient | null {
    return proxy;
  }

  function subscribeClient(listener: NatsClientListener): Unsubscribe {
    clientListeners.add(listener);
    listener(proxy);
    return () => clientListeners.delete(listener);
  }

  async function probeAlive(timeoutMs = 5_000): Promise<void> {
    if (!proxy) throw new Error('nats-transport: no client');
    await proxy.flush(timeoutMs);
  }

  async function forceReconnect(): Promise<void> {
    if (!proxy) return;
    await proxy.forceReconnect();
  }

  return {
    spec,
    apply,
    health,
    on,
    dispose,
    getClient,
    subscribeClient,
    probeAlive,
    forceReconnect,
  };
}

function stringifyError(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
