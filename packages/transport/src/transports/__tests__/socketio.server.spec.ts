import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

import { Server } from 'socket.io';
import { afterEach, describe, expect, it } from 'vitest';

import { createSocketioTransport } from '../socketio.js';

import type { ConnectionTarget } from '../../core/types.js';

const NS = ['/camera.ui', '/events', '/notifications', '/system'];

interface TestServer {
  io: Server;
  port: number;
  engineConns: () => number;
  live: () => number;
  close: () => Promise<void>;
}

async function startServer(opts: { ackStatus?: boolean; rejectLogs?: boolean } = {}): Promise<TestServer> {
  const http = createServer();
  const io = new Server(http, { path: '/api/socket.io', transports: ['websocket'], pingInterval: 25_000, pingTimeout: 20_000 });
  let engineConns = 0;
  io.engine.on('connection', () => engineConns++);
  for (const ns of NS) {
    io.of(ns).on('connection', (sock) => {
      if (ns === '/camera.ui' && opts.ackStatus !== false) sock.on('get-status', (_p: unknown, cb?: (s: string) => void) => cb?.('ready'));
    });
  }
  io.of('/logs').use((_sock, next) => {
    if (!opts.rejectLogs) return next();
    const err = Object.assign(new Error('Not authorized to connect to /logs'), {
      data: { message: 'Not authorized to connect to /logs', code: 'insufficient_role', type: 'UnauthorizedError' },
    });
    next(err);
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
  const port = (http.address() as { port: number }).port;
  return {
    io,
    port,
    engineConns: () => engineConns,
    live: () => io.engine.clientsCount,
    close: () =>
      new Promise<void>((r) => {
        io.close();
        http.close(() => r());
      }),
  };
}

function target(port: number, access = 'tok-1'): ConnectionTarget {
  return { endpoint: { url: `http://127.0.0.1:${port}`, mode: 'direct-lan' }, tokens: { access } } as ConnectionTarget;
}

async function until(cond: () => boolean, ms = 3_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('until timed out');
    await sleep(20);
  }
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

describe('socket.io transport against a real server', () => {
  it('keeps one websocket per tab across detach and endpoint changes', async () => {
    const a = await startServer();
    const b = await startServer();
    cleanups.push(a.close, b.close);
    const t = createSocketioTransport({ reconnectionDelay: 100, reconnectionDelayMax: 200 });
    cleanups.push(() => t.dispose());
    const lives: Record<string, number> = {};

    async function openAll(label: string, srv: TestServer): Promise<void> {
      for (const ns of NS.slice(1)) t.ensureSocket(ns);
      await until(() => NS.every((ns) => t.socket(ns)?.connected));
      await sleep(100);
      lives[label] = srv.live();
    }

    await t.apply(target(a.port));
    await openAll('A', a);
    await t.apply(null);
    await sleep(100);
    await t.apply(target(a.port));
    await openAll('A after detach', a);
    await t.apply(target(b.port));
    await openAll('B', b);
    await t.apply(target(a.port));
    await openAll('A again', a);
    await sleep(200);

    expect(lives).toEqual({ A: 1, 'A after detach': 1, B: 1, 'A again': 1 });
    expect(b.live()).toBe(0);
  });

  it('ensureAlive closes a connection whose server stopped answering and reconnects', async () => {
    const a = await startServer({ ackStatus: false });
    cleanups.push(a.close);
    const t = createSocketioTransport({ reconnectionDelay: 100, reconnectionDelayMax: 200 });
    cleanups.push(() => t.dispose());
    await t.apply(target(a.port));
    t.ensureSocket('/events');
    await until(() => !!t.socket()?.connected && !!t.socket('/events')?.connected);
    const before = a.engineConns();

    const t0 = Date.now();
    const status = await t.ensureAlive();
    const tookMs = Date.now() - t0;
    await until(() => !!t.socket()?.connected && !!t.socket('/events')?.connected && a.engineConns() > before, 5_000);

    expect({ up: status.up, probeWithin: tookMs < 3_500, newEngines: a.engineConns() - before, live: a.live() }).toEqual({
      up: false,
      probeWithin: true,
      newEngines: 1,
      live: 1,
    });
  });

  it('ensureAlive leaves a healthy connection alone', async () => {
    const a = await startServer();
    cleanups.push(a.close);
    const t = createSocketioTransport();
    cleanups.push(() => t.dispose());
    await t.apply(target(a.port));
    await until(() => !!t.socket()?.connected);
    const before = a.engineConns();

    const status = await t.ensureAlive();
    await sleep(200);

    expect({ up: status.up, newEngines: a.engineConns() - before }).toEqual({ up: true, newEngines: 0 });
  });

  it('revives every namespace on one engine after a wall-clock jump', async () => {
    const a = await startServer();
    cleanups.push(a.close);
    const t = createSocketioTransport({ reconnectionDelay: 100, reconnectionDelayMax: 200 });
    cleanups.push(() => t.dispose());
    await t.apply(target(a.port));
    for (const ns of NS.slice(1)) t.ensureSocket(ns);
    await until(() => NS.every((ns) => t.socket(ns)?.connected));
    const before = a.engineConns();

    const realNow = Date.now;
    Date.now = () => realNow() + 120_000;
    let healthBefore: boolean | undefined;
    try {
      healthBefore = t.health().up;
      await t.ensureAlive();
    } finally {
      Date.now = realNow;
    }
    await until(() => NS.every((ns) => t.socket(ns)?.connected) && a.engineConns() > before, 5_000);
    await sleep(200);

    expect({ healthBefore, newEngines: a.engineConns() - before, live: a.live() }).toEqual({ healthBefore: false, newEngines: 1, live: 1 });
  });

  it('a role rejection on one namespace is no auth error', async () => {
    const a = await startServer({ rejectLogs: true });
    cleanups.push(a.close);
    const t = createSocketioTransport();
    cleanups.push(() => t.dispose());
    const authErrors: string[] = [];
    t.on('auth-error', (p) => authErrors.push(p.message ?? ''));
    await t.apply(target(a.port));
    await until(() => !!t.socket()?.connected);
    const logs = t.ensureSocket('/logs')!;
    await new Promise<void>((r) => logs.once('connect_error', () => r()));
    await sleep(50);

    expect({ authErrors, up: t.health().up }).toEqual({ authErrors: [], up: true });
  });

  it('reconnects a transiently rejected namespace after a good probe, without a second CONNECT for a slow one', async () => {
    const http = createServer();
    const io = new Server(http, { path: '/api/socket.io', transports: ['websocket'] });
    io.of('/camera.ui').on('connection', (sock) => sock.on('get-status', (_p: unknown, cb?: (s: string) => void) => cb?.('ready')));
    let eventsAttempts = 0;
    io.of('/events').use((_s, next) => {
      eventsAttempts++;
      if (eventsAttempts === 1) return next(Object.assign(new Error('User not found'), { data: { code: 'user_not_found' } }));
      next();
    });
    io.of('/events').on('connection', () => {});
    let slowAttempts = 0;
    io.of('/slow').use((_s, next) => {
      slowAttempts++;
      setTimeout(() => next(), 800);
    });
    io.of('/slow').on('connection', () => {});
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
    cleanups.push(
      () =>
        new Promise<void>((r) => {
          io.close();
          http.close(() => r());
        }),
    );
    const port = (http.address() as { port: number }).port;

    const t = createSocketioTransport();
    cleanups.push(() => t.dispose());
    await t.apply(target(port, 'tok'));
    await until(() => !!t.socket()?.connected);
    const events = t.ensureSocket('/events')!;
    await new Promise<void>((r) => events.once('connect_error', () => r()));
    t.ensureSocket('/slow');
    await sleep(100);

    const status = await t.ensureAlive();
    await until(() => !!t.socket('/events')?.connected && !!t.socket('/slow')?.connected, 3_000);

    expect({ up: status.up, eventsAttempts, slowAttempts, live: io.engine.clientsCount }).toEqual({
      up: true,
      eventsAttempts: 2,
      slowAttempts: 1,
      live: 1,
    });
  });
});

describe('namespace holds against a real server', () => {
  function counted(srv: TestServer, ns: string): { connects: () => number; tokens: string[] } {
    let connects = 0;
    const tokens: string[] = [];
    srv.io.of(ns).on('connection', (sock) => {
      connects++;
      tokens.push(String((sock.handshake.auth as { token?: unknown }).token));
    });
    return { connects: () => connects, tokens };
  }

  it('closes a namespace the grace after its last release and opens it with fresh auth on the next acquire', async () => {
    const a = await startServer();
    cleanups.push(a.close);
    const events = counted(a, '/events');
    const t = createSocketioTransport({ releaseGraceMs: 150 });
    cleanups.push(() => t.dispose());
    await t.apply(target(a.port, 'tok-1'));
    const release = t.acquire('/events');
    t.ensureSocket('/events');
    await until(() => !!t.socket()?.connected && a.io.of('/events').sockets.size === 1);

    release();
    await sleep(50);
    const duringGrace = a.io.of('/events').sockets.size;
    await until(() => a.io.of('/events').sockets.size === 0);
    const afterGrace = { socket: t.socket('/events'), mainUp: !!t.socket()?.connected, live: a.live() };

    await t.apply(target(a.port, 'tok-2'));
    t.acquire('/events');
    t.ensureSocket('/events');
    await until(() => a.io.of('/events').sockets.size === 1);

    expect({ duringGrace, afterGrace, connects: events.connects(), tokens: events.tokens, live: a.live() }).toEqual({
      duringGrace: 1,
      afterGrace: { socket: null, mainUp: true, live: 1 },
      connects: 2,
      tokens: ['Bearer tok-1', 'Bearer tok-2'],
      live: 1,
    });
  });

  it('a new acquire within the grace keeps the same socket', async () => {
    const a = await startServer();
    cleanups.push(a.close);
    const events = counted(a, '/events');
    const t = createSocketioTransport({ releaseGraceMs: 150 });
    cleanups.push(() => t.dispose());
    await t.apply(target(a.port));
    const release = t.acquire('/events');
    const first = t.ensureSocket('/events');
    await until(() => !!first?.connected);

    release();
    await sleep(50);
    t.acquire('/events');
    const second = t.ensureSocket('/events');
    await sleep(300);

    expect({ same: first === second, connected: second?.connected, connects: events.connects(), open: a.io.of('/events').sockets.size }).toEqual({
      same: true,
      connected: true,
      connects: 1,
      open: 1,
    });
  });

  it('counts holders, and a release handle only counts once', async () => {
    const a = await startServer();
    cleanups.push(a.close);
    const t = createSocketioTransport({ releaseGraceMs: 100 });
    cleanups.push(() => t.dispose());
    await t.apply(target(a.port));
    const first = t.acquire('/events');
    t.acquire('/events');
    t.ensureSocket('/events');
    await until(() => !!t.socket('/events')?.connected);

    first();
    first();
    await sleep(300);

    expect(a.io.of('/events').sockets.size).toBe(1);
  });

  it('never closes the main namespace or one opened without a hold', async () => {
    const a = await startServer();
    cleanups.push(a.close);
    const t = createSocketioTransport({ releaseGraceMs: 100 });
    cleanups.push(() => t.dispose());
    await t.apply(target(a.port));
    t.ensureSocket('/system');
    t.acquire('/camera.ui')();
    t.acquire('/system')();
    await until(() => !!t.socket()?.connected && !!t.socket('/system')?.connected);
    await sleep(300);

    expect({ main: a.io.of('/camera.ui').sockets.size, system: a.io.of('/system').sockets.size }).toEqual({ main: 1, system: 1 });
  });

  it('a namespace released just before an endpoint change closes on the new endpoint too', async () => {
    const a = await startServer();
    const b = await startServer();
    cleanups.push(a.close, b.close);
    const t = createSocketioTransport({ releaseGraceMs: 200 });
    cleanups.push(() => t.dispose());
    await t.apply(target(a.port));
    const release = t.acquire('/events');
    t.ensureSocket('/events');
    await until(() => !!t.socket('/events')?.connected);

    release();
    await t.apply(target(b.port));
    await until(() => !!t.socket()?.connected);
    await sleep(400);

    expect({ socket: t.socket('/events'), onB: b.io.of('/events').sockets.size, onA: a.io.of('/events').sockets.size, live: b.live() }).toEqual({
      socket: null,
      onB: 0,
      onA: 0,
      live: 1,
    });
  });

  it('a namespace whose grace ends while the next endpoint is still resolving stays closed', async () => {
    const a = await startServer();
    const b = await startServer();
    cleanups.push(a.close, b.close);
    const eventsOnB = counted(b, '/events');
    const t = createSocketioTransport({
      releaseGraceMs: 100,
      resolveQuery: async ({ target: next, query }) => {
        if (next.endpoint.url.endsWith(`:${b.port}`)) await sleep(400);
        return query;
      },
    });
    cleanups.push(() => t.dispose());
    await t.apply(target(a.port));
    const release = t.acquire('/events');
    t.ensureSocket('/events');
    await until(() => !!t.socket('/events')?.connected);

    release();
    await t.apply(target(b.port));
    await until(() => !!t.socket()?.connected);
    await sleep(300);

    expect({ socket: t.socket('/events'), connects: eventsOnB.connects(), onB: b.io.of('/events').sockets.size, live: b.live() }).toEqual({
      socket: null,
      connects: 0,
      onB: 0,
      live: 1,
    });
  });
});
