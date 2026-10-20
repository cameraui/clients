import { Manager } from 'socket.io-client';

import { classifyClose } from './closeCodes.js';
import { isEndpointChange, isSameTarget, TransportEmitter } from './contract.js';

import type { Logger } from '@camera.ui/logger';
import type { Socket } from 'socket.io-client';
import type { ConnectionTarget, TransportSpec, TransportStatus } from '../core/types.js';
import type { Transport, TransportEvent, TransportEventHandler, Unsubscribe } from './contract.js';

const RESOLVE_RETRY_MIN_MS = 3_000;
const PROBE_TIMEOUT_MS = 3_000;
const RELEASE_GRACE_MS = 10_000;

export type { Socket };

const SOCKETIO_SPEC: TransportSpec = {
  id: 'socketio',
  kind: 'persistent',
  phaseGating: true,
};

export interface ResolveSocketQueryContext {
  readonly target: ConnectionTarget;
  readonly path: string;
  readonly query: Record<string, string>;
}

export type SocketQueryResolver = (ctx: ResolveSocketQueryContext) => Promise<Record<string, string>>;

export interface SocketioTransportOptions {
  readonly spec?: Partial<TransportSpec>;
  readonly path?: string;
  readonly resolveQuery?: SocketQueryResolver;
  readonly resolveRefreshMs?: number;
  readonly mainNamespace?: string;
  readonly reconnection?: boolean;
  readonly reconnectionDelay?: number;
  readonly reconnectionDelayMax?: number;
  readonly timeout?: number;
  readonly staleAfterMs?: number;
  readonly releaseGraceMs?: number;
  readonly logger?: Logger;
}

export interface SocketioTransport extends Transport {
  readonly manager: Manager | null;
  socket(namespace?: string): Socket | null;
  ensureSocket(namespace: string): Socket | null;
  acquire(namespace: string): Unsubscribe;
  onRebuild(handler: () => void): Unsubscribe;
  reviveDeadSockets(): void;
  ensureAlive(): Promise<TransportStatus>;
}

export function createSocketioTransport(options: SocketioTransportOptions = {}): SocketioTransport {
  const spec: TransportSpec = { ...SOCKETIO_SPEC, ...options.spec };
  const path = options.path ?? '/api/socket.io';
  const mainNs = options.mainNamespace ?? '/camera.ui';
  const reconnection = options.reconnection ?? true;
  const reconnectionDelay = options.reconnectionDelay ?? 1_000;
  const reconnectionDelayMax = options.reconnectionDelayMax ?? 5_000;
  const timeout = options.timeout ?? 20_000;
  const logger = options.logger;
  const resolveQuery = options.resolveQuery;
  const resolveRefreshMs = options.resolveRefreshMs ?? 0;
  const releaseGraceMs = options.releaseGraceMs ?? RELEASE_GRACE_MS;

  const emitter = new TransportEmitter();
  const sockets = new Map<string, Socket>();
  const reopen = new Set<string>();
  const rebuildListeners = new Set<() => void>();
  const holds = new Map<string, number>();
  const unheld = new Set<string>();
  const releaseTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let manager: Manager | null = null;
  let currentTarget: ConnectionTarget | null = null;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let queryRefreshAt = 0;
  let queryRefreshing = false;
  let status: TransportStatus = { up: false };
  let disposed = false;
  let applyEpoch = 0;
  let ensureInflight: Promise<TransportStatus> | null = null;

  const staleAfterMs = options.staleAfterMs ?? 60_000;
  let lastActivityAt = 0;

  function touchActivity(): void {
    lastActivityAt = Date.now();
  }

  function isStaleNow(): boolean {
    return lastActivityAt > 0 && Date.now() - lastActivityAt > staleAfterMs;
  }

  function isDeadNow(): boolean {
    const deadline = (manager?.engine as unknown as { _pingTimeoutTime?: unknown } | undefined)?._pingTimeoutTime;
    if (typeof deadline === 'number') return Date.now() > deadline;
    return isStaleNow();
  }

  function buildAuth(target: ConnectionTarget): Record<string, unknown> {
    return { token: `Bearer ${target.tokens.access}` };
  }

  async function queryFor(target: ConnectionTarget): Promise<Record<string, string>> {
    const base: Record<string, string> = {};
    if (!resolveQuery) return base;
    return resolveQuery({ target, path: socketPath(target), query: base });
  }

  async function refreshQuery(): Promise<void> {
    const target = currentTarget;
    if (!resolveQuery || !target || disposed) return;
    if (queryRefreshing || Date.now() - queryRefreshAt < RESOLVE_RETRY_MIN_MS) return;
    queryRefreshing = true;
    try {
      const query = await queryFor(target);
      if (currentTarget !== target || disposed) return;
      // signed queries expire, the manager re-reads opts.query on every reconnect
      if (manager) manager.opts.query = query;
    } catch (err) {
      logger?.warn(`query refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      queryRefreshing = false;
      queryRefreshAt = Date.now();
    }
  }

  async function refreshQueryWithin(ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([refreshQuery(), new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]);
    } finally {
      clearTimeout(timer);
    }
  }

  function stopRefresh(): void {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  function startRefresh(): void {
    stopRefresh();
    if (!resolveQuery || resolveRefreshMs <= 0) return;
    refreshTimer = setInterval(() => refreshQuery(), resolveRefreshMs);
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

  function isAuthError(err: Error): boolean {
    return classifyClose({ message: err?.message, data: (err as { data?: unknown } | undefined)?.data }) === 'auth-expired';
  }

  function dialedAccess(socket: Socket): string | undefined {
    const token = (socket.auth as { token?: unknown } | undefined)?.token;
    return typeof token === 'string' && token.startsWith('Bearer ') ? token.slice('Bearer '.length) : undefined;
  }

  function bindMainSocketEvents(socket: Socket): void {
    socket.on('connect', () => markUp());
    socket.on('disconnect', (reason: string) => {
      // teardown disconnects before dropping listeners, that must not mark the next endpoint down
      if (sockets.get(mainNs) !== socket) return;
      markDown(reason);
      if (resolveQuery) refreshQuery();
    });
    socket.on('connect_error', (err: Error) => {
      const msg = err?.message ?? 'connect_error';
      logger?.debug(`connect_error (main): ${msg}`);
      // a rejected upgrade is a bare websocket error here, a stale signed query is the usual cause
      if (resolveQuery) refreshQuery();
      if (isAuthError(err)) {
        emitter.emit('auth-error', { message: msg, access: dialedAccess(socket) });
        return;
      }
      markDown(msg);
    });
  }

  function bindSecondarySocketEvents(socket: Socket): void {
    socket.on('connect_error', (err: Error) => {
      if (isAuthError(err)) emitter.emit('auth-error', { message: err?.message ?? 'connect_error', access: dialedAccess(socket) });
    });
  }

  function socketOrigin(target: ConnectionTarget): string {
    return new URL(target.endpoint.url).origin;
  }

  function socketPath(target: ConnectionTarget): string {
    const prefix = new URL(target.endpoint.url).pathname.replace(/\/$/, '');
    return `${prefix}${path}`;
  }

  function openSocket(namespace: string, mgr: Manager, target: ConnectionTarget): Socket {
    const auth = buildAuth(target);
    const sock = mgr.socket(namespace, { auth });
    // the manager hands a released namespace its old socket back, auth included
    sock.auth = auth;
    sockets.set(namespace, sock);
    if (namespace === mainNs) bindMainSocketEvents(sock);
    else bindSecondarySocketEvents(sock);
    sock.connect();
    return sock;
  }

  async function rebuildManager(target: ConnectionTarget, epoch: number): Promise<void> {
    let query: Record<string, string>;
    try {
      query = await queryFor(target);
    } catch (err) {
      markDown(err instanceof Error ? err.message : String(err));
      throw err;
    }
    if (epoch !== applyEpoch || disposed) return;
    const mgr = new Manager(socketOrigin(target), {
      path: socketPath(target),
      query,
      autoConnect: false,
      reconnection,
      reconnectionDelay,
      reconnectionDelayMax,
      timeout,
      rejectUnauthorized: false,
      transports: ['websocket'],
    });
    manager = mgr;
    lastActivityAt = Date.now();
    mgr.on('open', touchActivity);
    mgr.on('ping', touchActivity);
    mgr.on('packet', touchActivity);
    openSocket(mainNs, mgr, target);
    for (const ns of reopen) {
      if (!sockets.has(ns)) openSocket(ns, mgr, target);
    }
    reopen.clear();
    startRefresh();
    for (const handler of [...rebuildListeners]) {
      try {
        handler();
      } catch (err) {
        logger?.warn(`rebuild listener failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  function closeAllSockets(): void {
    const closing = [...sockets.values()];
    const mgr = manager;
    sockets.clear();
    manager = null;
    for (const sock of closing) {
      // disconnect first so app listeners still see the socket go down
      sock.disconnect();
      sock.removeAllListeners();
    }
    mgr?._close();
  }

  function rebindAuth(target: ConnectionTarget): void {
    const auth = buildAuth(target);
    for (const sock of sockets.values()) {
      sock.auth = auth;
      if (!sock.connected) sock.connect();
    }
  }

  async function apply(target: ConnectionTarget | null): Promise<void> {
    if (disposed) throw new Error('socketio-transport disposed');
    if (isSameTarget(currentTarget, target)) return;

    const endpointChanged = isEndpointChange(currentTarget, target);
    currentTarget = target;

    if (!target) {
      applyEpoch++;
      closeAllSockets();
      reopen.clear();
      stopRefresh();
      lastActivityAt = 0;
      markDown('detached');
      return;
    }

    if (endpointChanged || !manager) {
      const epoch = ++applyEpoch;
      // tear down before the first await so nothing in between picks up an old endpoint's socket
      for (const ns of sockets.keys()) {
        if (ns !== mainNs) reopen.add(ns);
      }
      closeAllSockets();
      stopRefresh();
      try {
        await rebuildManager(target, epoch);
      } catch (err) {
        // a target we never connected to would make the same-target dedupe swallow every retry
        if (epoch === applyEpoch && currentTarget === target) currentTarget = null;
        throw err;
      }
      return;
    }
    rebindAuth(target);
  }

  function health(): TransportStatus {
    if (status.up && isDeadNow()) return { up: false, lastError: 'staleConnection' };
    return status;
  }

  function on<E extends TransportEvent>(event: E, handler: TransportEventHandler<E>): Unsubscribe {
    return emitter.on(event, handler);
  }

  async function dispose(): Promise<void> {
    disposed = true;
    applyEpoch++;
    closeAllSockets();
    reopen.clear();
    rebuildListeners.clear();
    for (const timer of releaseTimers.values()) clearTimeout(timer);
    releaseTimers.clear();
    holds.clear();
    unheld.clear();
    stopRefresh();
    currentTarget = null;
    status = { up: false };
    emitter.clear();
  }

  function socket(namespace = mainNs): Socket | null {
    return sockets.get(namespace) ?? null;
  }

  function ensureSocket(namespace: string): Socket | null {
    if (!currentTarget) return null;
    // without a hold the namespace stays open for the transport's lifetime
    if (!holds.has(namespace)) unheld.add(namespace);
    if (!manager) {
      reopen.add(namespace);
      return null;
    }
    return sockets.get(namespace) ?? openSocket(namespace, manager, currentTarget);
  }

  function acquire(namespace: string): Unsubscribe {
    holds.set(namespace, (holds.get(namespace) ?? 0) + 1);
    clearTimeout(releaseTimers.get(namespace));
    releaseTimers.delete(namespace);
    let held = true;
    return () => {
      if (!held || disposed) return;
      held = false;
      const left = (holds.get(namespace) ?? 1) - 1;
      if (left > 0) {
        holds.set(namespace, left);
        return;
      }
      holds.delete(namespace);
      if (namespace === mainNs) return;
      releaseTimers.set(
        namespace,
        setTimeout(() => closeReleased(namespace), releaseGraceMs),
      );
    };
  }

  function closeReleased(namespace: string): void {
    releaseTimers.delete(namespace);
    if (holds.has(namespace) || unheld.has(namespace)) return;
    reopen.delete(namespace);
    const sock = sockets.get(namespace);
    if (!sock) return;
    sockets.delete(namespace);
    sock.disconnect();
    sock.removeAllListeners();
  }

  function onRebuild(handler: () => void): Unsubscribe {
    rebuildListeners.add(handler);
    return () => {
      rebuildListeners.delete(handler);
    };
  }

  function reviveDeadSockets(): void {
    if (!currentTarget) return;
    if (status.up && isDeadNow()) {
      // the socket died in background, reconnect now instead of at the engine's ping timeout
      logger?.debug('reviveDeadSockets: engine stale — forcing reconnect');
      lastActivityAt = Date.now();
      manager?.engine?.close();
      return;
    }
    const auth = buildAuth(currentTarget);
    let revived = 0;
    for (const sock of sockets.values()) {
      if (!sock.connected) {
        sock.auth = auth;
        sock.connect();
        revived++;
      }
    }
    logger?.debug(`reviveDeadSockets: ${revived}/${sockets.size} reconnecting`);
  }

  function reconnectInactive(target: ConnectionTarget): void {
    const auth = buildAuth(target);
    for (const sock of sockets.values()) {
      // an active socket is mid-handshake on an open engine, connect() would send a second CONNECT
      if (sock.active) continue;
      sock.auth = auth;
      sock.connect();
    }
  }

  function ensureAlive(): Promise<TransportStatus> {
    if (ensureInflight) return ensureInflight;
    const run = async (): Promise<TransportStatus> => {
      if (disposed || !currentTarget) return health();
      const main = sockets.get(mainNs);
      if (main?.connected && !isDeadNow()) {
        // the query only matters for the next engine open, a slow signer must not hold the probe
        if (resolveQuery) refreshQuery();
        const engine = main.io.engine;
        const answered = await new Promise<boolean>((resolve) => {
          main.timeout(PROBE_TIMEOUT_MS).emit('get-status', null, (err: Error | null) => resolve(!err));
        });
        // a half-open link only surfaces at the engine ping deadline, up to 45 s after resume
        if (!answered && main.connected && main.io.engine === engine) {
          logger?.debug('ensureAlive: probe unanswered, closing engine');
          engine.close();
        } else if (answered && currentTarget) {
          reconnectInactive(currentTarget);
        }
        return health();
      }
      if (resolveQuery) await refreshQueryWithin(PROBE_TIMEOUT_MS);
      reviveDeadSockets();
      return health();
    };
    ensureInflight = run().finally(() => {
      ensureInflight = null;
    });
    return ensureInflight;
  }

  return {
    get spec() {
      return spec;
    },
    get manager() {
      return manager;
    },
    apply,
    health,
    on,
    dispose,
    socket,
    ensureSocket,
    acquire,
    onRebuild,
    reviveDeadSockets,
    ensureAlive,
  };
}
