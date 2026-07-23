import { createRPCClient } from '@camera.ui/rpc';

import { classifyClose } from './closeCodes.js';
import { isEndpointChange, isSameTarget, TransportEmitter } from './contract.js';

import type { Logger } from '@camera.ui/logger';
import type { RPCClient } from '@camera.ui/rpc';
import type { ConnectionTarget, TransportSpec, TransportStatus } from '../core/types.js';
import type { CloseLike } from './closeCodes.js';
import type { Transport, TransportEvent, TransportEventHandler, Unsubscribe } from './contract.js';

const NATS_SPEC: TransportSpec = {
  id: 'nats',
  kind: 'persistent',
  phaseGating: true,
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
  readonly connectTimeout?: number;
  readonly pingInterval?: number;
  readonly pingTimeout?: number;
  readonly maxPingOut?: number;
  readonly logger?: Logger;
}

export type NatsClientListener = (client: RPCClient | null) => void;

export interface NatsTransport extends Transport {
  getClient(): RPCClient | null;
  subscribeClient(listener: NatsClientListener): Unsubscribe;
  probeAlive(timeoutMs?: number): Promise<void>;
  forceReconnect(): Promise<void>;
  ensureAlive(): Promise<TransportStatus>;
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
  const connectTimeout = options.connectTimeout ?? 5_000;
  const pingInterval = options.pingInterval ?? 25_000;
  const pingTimeout = options.pingTimeout ?? 20_000;
  const maxPingOut = options.maxPingOut ?? 1;
  const logger = options.logger;

  const emitter = new TransportEmitter();
  const clientListeners = new Set<NatsClientListener>();
  let proxy: RPCClient | null = null;
  let currentTarget: ConnectionTarget | null = null;
  let status: TransportStatus = { up: false };
  let statusAbort: AbortController | null = null;
  let disposed = false;
  let connId: string | null = null;
  let applyEpoch = 0;
  let pendingConnectAbort: AbortController | null = null;

  function buildServers(target: ConnectionTarget): string[] {
    const url = new URL(target.endpoint.url);
    const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    const prefix = url.pathname.replace(/\/$/, '');
    const params = new URLSearchParams({ token: target.tokens.access });
    if (target.tokens.proxySession) params.set('session', target.tokens.proxySession);
    if (connId) params.set('connId', connId);
    return [`${wsProtocol}//${url.hostname}:${port}${prefix}${proxyPath}?${params.toString()}`];
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
    logger?.debug('markUp');
    emitter.emit('up', undefined);
  }

  function markDown(reason: string): void {
    if (!status.up && status.lastError === reason) return;
    status = { up: false, lastError: reason };
    logger?.debug(`markDown (${reason})`);
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
        logger?.debug(`status: ${event.type}${'server' in event && event.server ? ` server=${String(event.server)}` : ''}`);
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
    // per-subject permission violations don't kill the connection — marking
    // down would brick a healthy socket with no reconnect event to revive it
    if (message.toLowerCase().includes('permissions violation')) {
      logger?.warn(`permission violation (connection stays up): ${message}`);
      return;
    }
    const cls = classifyClose(typeof event.data === 'object' && event.data !== null ? { ...(event.data as object), message } : message);
    if (cls === 'auth-expired') {
      emitter.emit('auth-error', { message });
      return;
    }
    if (cls === 'forbidden') {
      // refreshing cannot fix a 4403 — mark down without the auth-error that
      // used to trigger a refresh loop
      logger?.warn(`forbidden by server: ${message}`);
      markDown(`forbidden: ${message}`);
      return;
    }
    markDown(message);
  }

  async function rebuildClient(target: ConnectionTarget, epoch: number): Promise<void> {
    logger?.debug(`rebuildClient start (epoch=${epoch})`);
    const t0 = Date.now();
    stopStatusMonitor();
    pendingConnectAbort?.abort();
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
      connectTimeout,
      pingInterval,
      pingTimeout,
      maxPingOut,
      ignoreAuthErrorAbort: true,
    });

    const connectAbort = new AbortController();
    pendingConnectAbort = connectAbort;

    try {
      await next.connect({ signal: connectAbort.signal });
    } catch (err) {
      try {
        next.abortClose();
      } catch {
        // ignore
      }
      if (disposed || epoch !== applyEpoch) {
        // Superseded while pending — a newer apply()/dispose() owns the
        // state now; stay silent.
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      logger?.debug(`rebuildClient connect FAILED after ${Date.now() - t0}ms: ${msg}`);
      // a 4401 at connect means the URL token is stale — without this the dial
      // loop retries the same dead token until the next rotation
      if (classifyClose(err instanceof Error ? (err as CloseLike) : msg) === 'auth-expired') {
        emitter.emit('auth-error', { message: msg });
      }
      markDown(msg);
      throw err;
    } finally {
      if (pendingConnectAbort === connectAbort) pendingConnectAbort = null;
    }

    if (disposed || epoch !== applyEpoch) {
      // The connect resolved late — after a newer apply(null)/apply(target)/
      // dispose(). Installing it would hijack the newer state; discard it.
      try {
        next.abortClose();
      } catch {
        // ignore
      }
      return;
    }

    proxy = next;
    logger?.debug(`rebuildClient connected in ${Date.now() - t0}ms`);
    // markUp BEFORE notifyClient — notifyClient gates on status.up, so we
    // need the up-flag set before we tell listeners we have a live client.
    markUp();
    notifyClient();
    startStatusMonitor(next);
  }

  async function apply(target: ConnectionTarget | null): Promise<void> {
    if (disposed) throw new Error('nats-transport disposed');
    if (isSameTarget(currentTarget, target)) return;

    const epoch = ++applyEpoch;
    const endpointChanged = isEndpointChange(currentTarget, target);
    currentTarget = target;

    if (!target) {
      stopStatusMonitor();
      pendingConnectAbort?.abort();
      pendingConnectAbort = null;
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
      try {
        await rebuildClient(target, epoch);
      } catch (err) {
        // Failed rebuild must not leave currentTarget pointing at a target
        // we never connected to — the same-target dedupe (here and in
        // transportSync) would otherwise swallow every retry.
        if (epoch === applyEpoch && currentTarget === target) currentTarget = null;
        throw err;
      }
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
    // A connection frozen while backgrounded keeps reporting up until its
    // throttled heartbeat timer fires. The client's wall-clock staleness check
    // surfaces the dead socket immediately, so callers acting on resume (the
    // kernel's nats-recovery, phase gating) don't trust a zombie.
    if (status.up && proxy?.isStale) {
      return { up: false, lastError: 'staleConnection' };
    }
    return status;
  }

  function on<E extends TransportEvent>(event: E, handler: TransportEventHandler<E>): Unsubscribe {
    return emitter.on(event, handler);
  }

  async function dispose(): Promise<void> {
    disposed = true;
    applyEpoch++;
    stopStatusMonitor();
    pendingConnectAbort?.abort();
    pendingConnectAbort = null;
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
    // Same gating as notifyClient: while down, consumers must see null even
    // though the lib-internal reconnect keeps the proxy reference alive.
    return status.up ? proxy : null;
  }

  function subscribeClient(listener: NatsClientListener): Unsubscribe {
    clientListeners.add(listener);
    listener(status.up ? proxy : null);
    return () => clientListeners.delete(listener);
  }

  async function probeAlive(timeoutMs = 5_000): Promise<void> {
    if (!proxy) throw new Error('nats-transport: no client');
    const t0 = Date.now();
    try {
      await proxy.flush(timeoutMs);
      logger?.debug(`probeAlive OK in ${Date.now() - t0}ms`);
    } catch (err) {
      logger?.debug(`probeAlive FAILED after ${Date.now() - t0}ms: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  async function forceReconnect(): Promise<void> {
    if (!proxy) {
      logger?.debug('forceReconnect: no client');
      return;
    }
    logger?.debug(`forceReconnect: issuing (up=${status.up} stale=${proxy.isStale})`);
    const t0 = Date.now();
    await proxy.forceReconnect();
    logger?.debug(`forceReconnect: returned after ${Date.now() - t0}ms (up=${status.up})`);
  }

  let ensureInflight: Promise<TransportStatus> | null = null;

  function ensureAlive(): Promise<TransportStatus> {
    if (ensureInflight) return ensureInflight;
    const run = async (): Promise<TransportStatus> => {
      if (disposed || !currentTarget) return health();
      if (!proxy) {
        // no client and no dial loop — rebuild from the current target, the
        // one state neither the lib nor the status iterator can recover from
        const epoch = ++applyEpoch;
        try {
          await rebuildClient(currentTarget, epoch);
        } catch {
          // markDown happened inside rebuildClient
        }
        return health();
      }
      if (health().up) {
        try {
          await probeAlive(3_000);
          return health();
        } catch {
          // proved dead, fall through to the forced redial
        }
      }
      try {
        await forceReconnect();
      } catch {
        // failures surface via the status iterator's down event
      }
      return health();
    };
    ensureInflight = run().finally(() => {
      ensureInflight = null;
    });
    return ensureInflight;
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
    ensureAlive,
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
