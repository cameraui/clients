import { createRPCClient } from '@camera.ui/rpc';

import { classifyClose, refusedByServer } from './closeCodes.js';
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

const RESOLVE_RETRY_MIN_MS = 3_000;
const DIAL_GRACE_MS = 2_000;
const CLIENT_DEFAULT_PING_INTERVAL_MS = 120_000;

export interface ResolveServersContext {
  readonly target: ConnectionTarget;
  readonly connId: string;
  readonly defaultServers: readonly string[];
}

export type ServersResolver = (ctx: ResolveServersContext) => Promise<string[]>;

export interface NatsTransportOptions {
  readonly spec?: Partial<TransportSpec>;
  readonly proxyPath?: string;
  readonly resolveRefreshMs?: number;
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
  readonly resolveServers?: ServersResolver;
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
  const heartbeatInterval = pingInterval || CLIENT_DEFAULT_PING_INTERVAL_MS;
  const heartbeatWindow = heartbeatInterval + (pingTimeout > 0 ? pingTimeout : heartbeatInterval);
  const logger = options.logger;
  const resolveServers = options.resolveServers;
  const resolveRefreshMs = options.resolveRefreshMs ?? 0;

  const emitter = new TransportEmitter();
  const clientListeners = new Set<NatsClientListener>();
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let proxy: RPCClient | null = null;
  let currentTarget: ConnectionTarget | null = null;
  let status: TransportStatus = { up: false };
  let statusAbort: AbortController | null = null;
  let disposed = false;
  let connId: string | null = null;
  let applyEpoch = 0;
  let dialAbort: AbortController | null = null;
  let dialAttempt: { readonly startedAt: number; readonly settled: Promise<void> } | null = null;
  // the server refused this target for good, only a new token or target dials again
  let parked = false;
  let poolRefreshAt = 0;
  let poolRefreshing = false;
  // token in the server list the client dials with, reconnects keep using it until setServers
  let dialAccess: string | undefined;
  // the client clears isStale only on its own heartbeat pong, an answered probe holds for the same window
  let probedUntil = 0;

  function buildServers(target: ConnectionTarget): string[] {
    const url = new URL(target.endpoint.url);
    const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    const prefix = url.pathname.replace(/\/$/, '');
    const params = new URLSearchParams({ token: target.tokens.access });
    if (connId) params.set('connId', connId);
    return [`${wsProtocol}//${url.hostname}:${port}${prefix}${proxyPath}?${params.toString()}`];
  }

  async function serversFor(target: ConnectionTarget): Promise<string[]> {
    const defaultServers = buildServers(target);
    if (!resolveServers) return defaultServers;
    return resolveServers({ target, connId: connId ?? '', defaultServers });
  }

  async function refreshPool(p: RPCClient): Promise<void> {
    const target = currentTarget;
    if (!resolveServers || !target || disposed) return;
    if (poolRefreshing || Date.now() - poolRefreshAt < RESOLVE_RETRY_MIN_MS) return;
    poolRefreshing = true;
    try {
      const servers = await serversFor(target);
      if (proxy === p && !disposed) p.setServers(servers);
    } catch (err) {
      logger?.warn(`server refresh failed: ${stringifyError(err)}`);
    } finally {
      poolRefreshing = false;
      poolRefreshAt = Date.now();
    }
  }

  function stopRefresh(): void {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  function startRefresh(p: RPCClient): void {
    stopRefresh();
    if (!resolveServers || resolveRefreshMs <= 0) return;
    refreshTimer = setInterval(() => refreshPool(p), resolveRefreshMs);
  }

  async function resign(reason: string): Promise<void> {
    const target = currentTarget;
    if (!proxy || !target || disposed) return;
    logger?.debug(`resign (${reason})`);
    const epoch = ++applyEpoch;
    stopStatusMonitor();
    stopRefresh();
    try {
      proxy.abortClose();
    } catch {
      // ignore
    }
    proxy = null;
    notifyClient();
    markDown(`signature-expired: ${reason}`);
    try {
      await rebuildClient(target, epoch);
    } catch {
      // parked or crashed, health() says why
    }
  }

  function notifyClient(): void {
    // the lib keeps the proxy alive across reconnects, listeners must see null while down
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
            if (resolveServers) refreshPool(p);
            break;
          case 'reconnecting':
            if (resolveServers) refreshPool(p);
            break;
          case 'staleConnection':
            // the close path can be slow or silent on dead sockets, stale is authoritative
            markDown('staleConnection');
            notifyClient();
            break;
          case 'error':
            handleErrorEvent(event);
            break;
        }
      }
    })().catch(() => {
      // the iterator closes on disconnect
    });
  }

  function handleErrorEvent(event: { error?: unknown; data?: unknown }): void {
    // server -ERR statuses carry only `error`, older clients only `data`
    const payload = event.error ?? event.data;
    const message = stringifyError(payload ?? 'server error');
    // permission violations don't kill the connection, marking down would brick a healthy socket
    if (message.toLowerCase().includes('permissions violation')) {
      logger?.warn(`permission violation (connection stays up): ${message}`);
      return;
    }
    const cls = classifyClose(typeof payload === 'object' && payload !== null ? { ...(payload as object), message } : message);
    if (cls === 'auth-expired') {
      if (resolveServers) {
        resign(message);
        return;
      }
      emitter.emit('auth-error', { message, access: dialAccess });
      return;
    }
    if (cls === 'forbidden') {
      // every reconnect would be refused the same way
      if (refusedByServer(payload)) {
        park(message);
        return;
      }
      logger?.warn(`forbidden by server: ${message}`);
      markDown(forbiddenError(message));
      return;
    }
    markDown(message);
  }

  function park(message: string): void {
    parked = true;
    const dropped = proxy;
    if (dropped) {
      stopStatusMonitor();
      stopRefresh();
      proxy = null;
      try {
        dropped.abortClose();
      } catch {
        // ignore
      }
    }
    logger?.warn(`forbidden by server: ${message}`);
    markDown(forbiddenError(message));
    if (dropped) notifyClient();
  }

  async function rebuildClient(target: ConnectionTarget, epoch: number): Promise<void> {
    logger?.debug(`rebuildClient start (epoch=${epoch})`);
    stopStatusMonitor();
    stopRefresh();
    dialAbort?.abort();
    parked = false;
    if (proxy) {
      try {
        proxy.abortClose();
      } catch {
        // ignore
      }
      proxy = null;
      markDown('endpoint-changed');
      notifyClient();
    }

    const abort = new AbortController();
    dialAbort = abort;
    try {
      for (let retry = 0; ; retry++) {
        if (retry > 0) {
          const wait = retryDelay(retry - 1);
          logger?.debug(`rebuildClient retry in ${wait}ms`);
          await sleep(wait, abort.signal);
          if (disposed || epoch !== applyEpoch) return;
        }
        if (await dialOnce(target, epoch, abort.signal)) return;
      }
    } finally {
      if (dialAbort === abort) dialAbort = null;
    }
  }

  async function dialOnce(target: ConnectionTarget, epoch: number, signal: AbortSignal): Promise<boolean> {
    const t0 = Date.now();
    let settle!: () => void;
    const attempt = { startedAt: t0, settled: new Promise<void>((resolve) => (settle = resolve)) };
    dialAttempt = attempt;
    try {
      // before serversFor, the proxy URL and the reply subjects must carry the same connId
      connId = newConnId();
      let servers: string[];
      try {
        servers = await serversFor(target);
      } catch (err) {
        if (disposed || epoch !== applyEpoch) return true;
        const msg = stringifyError(err);
        logger?.debug(`rebuildClient resolve FAILED: ${msg}`);
        markDown(msg);
        return false;
      }
      if (disposed || epoch !== applyEpoch) return true;
      dialAccess = target.tokens.access;
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
        // the library would retry a first dial about once a second and never surface its close code
        waitOnFirstConnect: false,
      });

      try {
        await next.connect({ signal });
      } catch (err) {
        try {
          next.abortClose();
        } catch {
          // ignore
        }
        if (disposed || epoch !== applyEpoch) {
          // superseded, a newer apply or dispose owns the state
          return true;
        }
        const msg = err instanceof Error ? err.message : String(err);
        logger?.debug(`rebuildClient connect FAILED after ${Date.now() - t0}ms: ${msg}`);
        const cls = classifyClose(err instanceof Error ? (err as CloseLike) : msg);
        if (cls === 'forbidden') {
          park(msg);
          throw err;
        }
        // the URL token is dead, a resolver signs a fresh URL on the next attempt instead
        if (cls === 'auth-expired' && !resolveServers) {
          parked = true;
          emitter.emit('auth-error', { message: msg, access: target.tokens.access });
          markDown(msg);
          throw err;
        }
        markDown(msg);
        return false;
      }

      if (disposed || epoch !== applyEpoch) {
        // resolved after a newer apply or dispose, installing it would hijack that state
        try {
          next.abortClose();
        } catch {
          // ignore
        }
        return true;
      }

      proxy = next;
      logger?.debug(`rebuildClient connected in ${Date.now() - t0}ms`);
      // markUp first, notifyClient gates on status.up
      markUp();
      notifyClient();
      startStatusMonitor(next);
      startRefresh(next);
      return true;
    } finally {
      settle();
      if (dialAttempt === attempt) dialAttempt = null;
    }
  }

  function retryDelay(retry: number): number {
    const base = reconnectionDelayMax > 0 ? Math.min(reconnectTimeWait * 2 ** retry, reconnectionDelayMax) : reconnectTimeWait;
    const spread = base * reconnectionRandomizationFactor;
    return Math.round(base - spread + Math.random() * 2 * spread);
  }

  async function apply(target: ConnectionTarget | null): Promise<void> {
    if (disposed) throw new Error('nats-transport disposed');
    // a crashed dial leaves nothing holding the target, the same target has to dial again
    if (isSameTarget(currentTarget, target) && (!target || proxy || dialAbort || parked)) return;

    const epoch = ++applyEpoch;
    const endpointChanged = isEndpointChange(currentTarget, target);
    currentTarget = target;

    if (!target) {
      stopStatusMonitor();
      stopRefresh();
      dialAbort?.abort();
      dialAbort = null;
      parked = false;
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
      await rebuildClient(target, epoch);
      return;
    }

    // the server checks the token only at handshake, the new one applies at the next reconnect
    const p = proxy;
    const newServers = await serversFor(target);
    if (epoch !== applyEpoch) return;
    if (proxy === p) {
      p.setServers(newServers);
      dialAccess = target.tokens.access;
    } else if (parked) {
      // refused while this token was being signed, it has not been tried yet
      await rebuildClient(target, epoch);
    }
  }

  function health(): TransportStatus {
    // a socket frozen in background reports up until its throttled heartbeat fires, the wall-clock check catches it
    if (status.up && proxy?.isStale && Date.now() > probedUntil) {
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
    stopRefresh();
    dialAbort?.abort();
    dialAbort = null;
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
      probedUntil = Date.now() + heartbeatWindow;
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
      if (disposed || !currentTarget || parked) return health();
      if (!proxy) {
        // a dial that just started is likely still good, after that a wake skips the backoff and dials fresh
        const attempt = dialAttempt;
        if (attempt && Date.now() - attempt.startedAt < DIAL_GRACE_MS) {
          await attempt.settled;
          return health();
        }
        rebuildClient(currentTarget, ++applyEpoch).catch(() => {
          // parked or crashed, health() says why
        });
        await dialAttempt?.settled;
        return health();
      }
      // stale can be a heartbeat throttled in a hidden window while the socket still answers
      if (status.up) {
        try {
          await probeAlive(3_000);
          return status;
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

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}

function forbiddenError(message: string): string {
  return /^forbidden\b/.test(message) ? message : `forbidden: ${message}`;
}

function stringifyError(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
