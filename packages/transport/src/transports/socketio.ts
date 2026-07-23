import { io, Manager } from 'socket.io-client';

import { classifyClose } from './closeCodes.js';
import { isEndpointChange, isSameTarget, TransportEmitter } from './contract.js';

import type { Logger } from '@camera.ui/logger';
import type { Socket } from 'socket.io-client';
import type { ConnectionTarget, TransportSpec, TransportStatus } from '../core/types.js';
import type { Transport, TransportEvent, TransportEventHandler, Unsubscribe } from './contract.js';

export type { Socket };

const SOCKETIO_SPEC: TransportSpec = {
  id: 'socketio',
  kind: 'persistent',
  phaseGating: true,
};

export interface SocketioTransportOptions {
  readonly spec?: Partial<TransportSpec>;
  readonly path?: string;
  readonly mainNamespace?: string;
  readonly reconnection?: boolean;
  readonly reconnectionDelay?: number;
  readonly reconnectionDelayMax?: number;
  readonly timeout?: number;
  readonly staleAfterMs?: number;
  readonly logger?: Logger;
}

export interface SocketioTransport extends Transport {
  readonly manager: Manager | null;
  socket(namespace?: string): Socket | null;
  ensureSocket(namespace: string): Socket | null;
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

  const emitter = new TransportEmitter();
  const sockets = new Map<string, Socket>();
  let manager: Manager | null = null;
  let currentTarget: ConnectionTarget | null = null;
  let status: TransportStatus = { up: false };
  let disposed = false;

  const staleAfterMs = options.staleAfterMs ?? 60_000;
  let lastActivityAt = 0;

  function touchActivity(): void {
    lastActivityAt = Date.now();
  }

  function isStaleNow(): boolean {
    return lastActivityAt > 0 && Date.now() - lastActivityAt > staleAfterMs;
  }

  function buildAuth(target: ConnectionTarget): Record<string, unknown> {
    const auth: Record<string, unknown> = { token: `Bearer ${target.tokens.access}` };
    if (target.tokens.proxySession) auth.session = target.tokens.proxySession;
    return auth;
  }

  function buildQuery(target: ConnectionTarget): Record<string, string> {
    const q: Record<string, string> = {};
    if (target.tokens.proxySession) q.session = target.tokens.proxySession;
    return q;
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

  function isAuthError(msg: string): boolean {
    return classifyClose(msg) === 'auth-expired';
  }

  function bindMainSocketEvents(socket: Socket): void {
    socket.on('connect', () => markUp());
    socket.on('disconnect', (reason: string) => markDown(reason));
    socket.on('connect_error', (err: Error) => {
      const msg = err?.message ?? 'connect_error';
      logger?.debug(`connect_error (main): ${msg}`);
      if (isAuthError(msg)) {
        emitter.emit('auth-error', { message: msg });
        return;
      }
      markDown(msg);
    });
  }

  function bindSecondarySocketEvents(socket: Socket): void {
    socket.on('connect_error', (err: Error) => {
      const msg = err?.message ?? 'connect_error';
      if (isAuthError(msg)) emitter.emit('auth-error', { message: msg });
    });
  }

  function socketOrigin(target: ConnectionTarget): string {
    return new URL(target.endpoint.url).origin;
  }

  function socketPath(target: ConnectionTarget): string {
    const prefix = new URL(target.endpoint.url).pathname.replace(/\/$/, '');
    return `${prefix}${path}`;
  }

  function openSocket(namespace: string, target: ConnectionTarget): Socket {
    const url = `${socketOrigin(target)}${namespace}`;
    const sock = io(url, {
      path: socketPath(target),
      auth: buildAuth(target),
      query: buildQuery(target),
      reconnection,
      reconnectionDelay,
      reconnectionDelayMax,
      timeout,
      rejectUnauthorized: false,
      transports: ['websocket'],
    });
    sockets.set(namespace, sock);
    return sock;
  }

  function rebuildManager(target: ConnectionTarget): void {
    closeAllSockets();
    manager = new Manager(socketOrigin(target), {
      path: socketPath(target),
      autoConnect: false,
      reconnection,
      reconnectionDelay,
      reconnectionDelayMax,
      timeout,
      rejectUnauthorized: false,
      transports: ['websocket'],
    });
    const main = openSocket(mainNs, target);
    bindMainSocketEvents(main);

    // the sockets ride io()'s cached manager (main.io), not the local
    // `manager` instance — activity must be observed there
    lastActivityAt = Date.now();
    main.io.on('open', touchActivity);
    main.io.on('ping', touchActivity);
    main.io.on('packet', touchActivity);
  }

  function closeAllSockets(): void {
    for (const sock of sockets.values()) {
      sock.removeAllListeners();
      sock.disconnect();
    }
    sockets.clear();
    if (manager) {
      manager._close();
      manager = null;
    }
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
      closeAllSockets();
      lastActivityAt = 0;
      markDown('detached');
      return;
    }

    if (endpointChanged || !manager) {
      rebuildManager(target);
      return;
    }
    rebindAuth(target);
  }

  function health(): TransportStatus {
    if (status.up && isStaleNow()) return { up: false, lastError: 'staleConnection' };
    return status;
  }

  function on<E extends TransportEvent>(event: E, handler: TransportEventHandler<E>): Unsubscribe {
    return emitter.on(event, handler);
  }

  async function dispose(): Promise<void> {
    disposed = true;
    closeAllSockets();
    currentTarget = null;
    status = { up: false };
    emitter.clear();
  }

  function socket(namespace = mainNs): Socket | null {
    return sockets.get(namespace) ?? null;
  }

  function ensureSocket(namespace: string): Socket | null {
    if (!currentTarget) return null;
    let sock = sockets.get(namespace);
    if (!sock) {
      sock = openSocket(namespace, currentTarget);
      bindSecondarySocketEvents(sock);
    }
    return sock;
  }

  function reviveDeadSockets(): void {
    if (!currentTarget) return;
    if (status.up && isStaleNow()) {
      // engine still claims connected but the wall clock says the socket died
      // in background — force-close it so every namespace reconnects now
      // instead of after the engine's own ping timeout
      logger?.debug('reviveDeadSockets: engine stale — forcing reconnect');
      lastActivityAt = Date.now();
      sockets.get(mainNs)?.io.engine?.close();
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

  async function ensureAlive(): Promise<TransportStatus> {
    if (disposed || !currentTarget) return health();
    reviveDeadSockets();
    return health();
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
    reviveDeadSockets,
    ensureAlive,
  };
}
