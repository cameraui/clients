import { io, Manager } from 'socket.io-client';

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
  graceMs: 4_000,
};

export interface SocketioTransportOptions {
  readonly spec?: Partial<TransportSpec>;
  readonly path?: string;
  readonly mainNamespace?: string;
  readonly reconnection?: boolean;
  readonly reconnectionDelay?: number;
  readonly reconnectionDelayMax?: number;
  readonly timeout?: number;
  readonly logger?: Logger;
}

export interface SocketioTransport extends Transport {
  readonly manager: Manager | null;
  socket(namespace?: string): Socket | null;
  ensureSocket(namespace: string): Socket | null;
  reviveDeadSockets(): void;
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
    const m = msg.toLowerCase();
    return m.includes('auth') || m.includes('unauthorized');
  }

  function bindCommonAuthEvents(socket: Socket): void {
    let rotatedOut = false;
    socket.on('unauthenticated', () => {
      const fresh = currentTarget ? buildAuth(currentTarget) : null;
      const current = (socket.auth as { token?: string } | undefined)?.token;
      if (fresh && current !== fresh.token) {
        socket.auth = fresh;
        rotatedOut = true;
      } else {
        emitter.emit('auth-error', { message: 'unauthenticated' });
      }
    });
    socket.on('disconnect', () => {
      if (rotatedOut) {
        rotatedOut = false;
        socket.connect();
      }
    });
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
    bindCommonAuthEvents(socket);
  }

  function bindSecondarySocketEvents(socket: Socket): void {
    socket.on('connect_error', (err: Error) => {
      const msg = err?.message ?? 'connect_error';
      if (isAuthError(msg)) emitter.emit('auth-error', { message: msg });
    });
    bindCommonAuthEvents(socket);
  }

  function openSocket(namespace: string, target: ConnectionTarget): Socket {
    const url = `${target.endpoint.url}${namespace}`;
    const sock = io(url, {
      path,
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
    manager = new Manager(target.endpoint.url, {
      path,
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
    // Update auth in place — `sock.auth` is a live property and is read at
    // every (re)connect handshake. For a CONNECTED socket we deliberately do
    // NOT force a disconnect: socket.io validates tokens only at handshake
    // time, so a live session keeps running and picks up the fresh token on
    // its next natural reconnect (avoids a visible drop on every refresh).
    // For a socket that is DOWN — server-booted on a rotated-out token, or
    // dropped while backgrounded and not auto-reconnecting — the fresh token
    // is exactly what it needs, so reconnect it now instead of leaving it dead.
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
  };
}
