import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSocketioTransport } from '../socketio.js';

import type { ConnectionTarget } from '../../core/types.js';
import type { SocketioTransport } from '../socketio.js';

type Listener = (...args: any[]) => void;

const lib = vi.hoisted(() => {
  class FakeEmitter {
    private readonly listeners = new Map<string, Listener[]>();

    on(event: string, fn: Listener): this {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn]);
      return this;
    }

    off(event: string, fn: Listener): this {
      this.listeners.set(
        event,
        (this.listeners.get(event) ?? []).filter((l) => l !== fn),
      );
      return this;
    }

    removeAllListeners(): this {
      this.listeners.clear();
      return this;
    }

    fire(event: string, ...args: unknown[]): void {
      for (const fn of [...(this.listeners.get(event) ?? [])]) fn(...args);
    }
  }

  class FakeEngine {
    _pingTimeoutTime = Infinity;
    closed = 0;

    constructor(private readonly manager: FakeManager) {}

    close(): void {
      this.closed++;
      this.manager.dropAll('transport close');
    }
  }

  class FakeManager extends FakeEmitter {
    static readonly instances: FakeManager[] = [];

    readonly nsps: Record<string, FakeSocket> = {};
    readonly engine: FakeEngine;
    closed = false;

    constructor(
      readonly uri: string,
      readonly opts: Record<string, any>,
    ) {
      super();
      this.engine = new FakeEngine(this);
      FakeManager.instances.push(this);
    }

    socket(nsp: string, opts?: { auth?: unknown }): FakeSocket {
      this.nsps[nsp] ??= new FakeSocket(this, nsp, opts);
      return this.nsps[nsp];
    }

    _close(): void {
      this.closed = true;
      this.dropAll('forced close');
    }

    dropAll(reason: string): void {
      for (const sock of Object.values(this.nsps)) sock.serverDrop(reason);
    }
  }

  class FakeSocket extends FakeEmitter {
    connected = false;
    active = false;
    connects = 0;
    auth: unknown;
    responder: ((event: string) => unknown) | null = null;
    readonly sent: { event: string; args: unknown[] }[] = [];
    private ackTimeout: number | undefined;

    constructor(
      readonly io: FakeManager,
      readonly nsp: string,
      opts?: { auth?: unknown },
    ) {
      super();
      this.auth = opts?.auth;
    }

    connect(): this {
      this.active = true;
      this.connects++;
      return this;
    }

    disconnect(): this {
      this.active = false;
      if (this.connected) {
        this.connected = false;
        this.fire('disconnect', 'io client disconnect');
      }
      return this;
    }

    timeout(ms: number): this {
      this.ackTimeout = ms;
      return this;
    }

    emit(event: string, ...args: unknown[]): this {
      const timeout = this.ackTimeout;
      this.ackTimeout = undefined;
      const ack = typeof args.at(-1) === 'function' ? (args.pop() as Listener) : undefined;
      this.sent.push({ event, args });
      if (!ack) return this;
      const responder = this.responder;
      if (responder) {
        queueMicrotask(() => (timeout === undefined ? ack(responder(event)) : ack(null, responder(event))));
      } else if (timeout !== undefined) {
        setTimeout(() => ack(new Error('operation has timed out')), timeout);
      }
      return this;
    }

    serverAccept(): void {
      this.connected = true;
      this.fire('connect');
    }

    serverReject(message: string, data?: unknown): void {
      this.active = false;
      this.fire('connect_error', Object.assign(new Error(message), { data }));
    }

    serverDrop(reason: string): void {
      if (!this.connected) return;
      this.connected = false;
      this.fire('disconnect', reason);
    }
  }

  function io(uri: string, opts: Record<string, any>): FakeSocket {
    const url = new URL(uri);
    return new FakeManager(url.origin, opts).socket(url.pathname, opts).connect();
  }

  return { FakeManager, FakeSocket, io };
});

vi.mock('socket.io-client', () => ({ Manager: lib.FakeManager, io: lib.io }));

type FakeSocket = InstanceType<typeof lib.FakeSocket>;
type FakeManager = InstanceType<typeof lib.FakeManager>;

const A: ConnectionTarget = { endpoint: { url: 'https://nvr.local:3443', mode: 'direct-lan' }, tokens: { access: 'at-1' } };
const B: ConnectionTarget = { endpoint: { url: 'https://nvr.example.com', mode: 'direct-wan' }, tokens: { access: 'at-1' } };
const NAMESPACES = ['/events', '/system'];

function fake(sock: unknown): FakeSocket {
  return sock as FakeSocket;
}

function managerOf(t: SocketioTransport): FakeManager {
  return t.manager as unknown as FakeManager;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('socketio transport', () => {
  let transport: SocketioTransport;

  beforeEach(() => {
    lib.FakeManager.instances.length = 0;
  });

  afterEach(async () => {
    vi.useRealTimers();
    await transport?.dispose();
  });

  describe('multiplexing', () => {
    it('opens every namespace on the transport manager', async () => {
      transport = createSocketioTransport();
      await transport.apply(A);
      for (const ns of NAMESPACES) transport.ensureSocket(ns);

      for (const ns of ['/camera.ui', ...NAMESPACES]) {
        expect(fake(transport.socket(ns)).io).toBe(managerOf(transport));
        expect(fake(transport.socket(ns)).active).toBe(true);
      }
      expect(lib.FakeManager.instances).toHaveLength(1);
      expect(managerOf(transport).opts.autoConnect).toBe(false);
    });

    it('keeps one manager per endpoint across detach and endpoint changes', async () => {
      transport = createSocketioTransport();
      for (const target of [A, null, A, B, A]) {
        await transport.apply(target);
        if (!target) continue;
        for (const ns of NAMESPACES) transport.ensureSocket(ns);
        for (const ns of ['/camera.ui', ...NAMESPACES]) expect(fake(transport.socket(ns)).io).toBe(managerOf(transport));
      }

      const stale = lib.FakeManager.instances.filter((m) => m !== managerOf(transport));
      expect(stale).toHaveLength(3);
      expect(stale.every((m) => m.closed)).toBe(true);
    });

    it('builds the manager with the resolved query and refreshes it there', async () => {
      let n = 0;
      transport = createSocketioTransport({ resolveQuery: async ({ query }) => ({ ...query, authSig: `sig-${++n}` }) });
      await transport.apply(A);
      expect(managerOf(transport).opts.query).toEqual({ authSig: 'sig-1' });

      const main = fake(transport.socket());
      main.responder = () => 'ready';
      main.serverAccept();
      await transport.ensureAlive();
      await vi.waitFor(() => expect(managerOf(transport).opts.query).toEqual({ authSig: 'sig-2' }));
    });
  });

  describe('endpoint change', () => {
    it('hands out no socket until the new endpoint is ready', async () => {
      const pending = deferred<Record<string, string>>();
      let calls = 0;
      transport = createSocketioTransport({ resolveQuery: async ({ query }) => (++calls === 1 ? query : pending.promise) });
      await transport.apply(A);
      const old = fake(transport.ensureSocket('/events'));
      old.serverAccept();
      const seen: string[] = [];
      old.on('disconnect', (reason: string) => seen.push(reason));

      const applying = transport.apply(B);
      expect(seen).toEqual(['io client disconnect']);
      expect(transport.socket('/events')).toBeNull();
      expect(transport.ensureSocket('/events')).toBeNull();

      pending.resolve({});
      await applying;
      const fresh = fake(transport.socket('/events'));
      expect(fresh).not.toBe(old);
      expect(fresh.io).toBe(managerOf(transport));
      expect(fresh.io.uri).toBe('https://nvr.example.com');
    });

    it('reopens namespaces opened before or during the change and announces the rebuild', async () => {
      const pending = deferred<Record<string, string>>();
      let calls = 0;
      transport = createSocketioTransport({ resolveQuery: async ({ query }) => (++calls === 1 ? query : pending.promise) });
      await transport.apply(A);
      transport.ensureSocket('/events');
      const rebuilds = vi.fn();
      transport.onRebuild(rebuilds);

      const applying = transport.apply(B);
      expect(transport.ensureSocket('/system')).toBeNull();
      expect(rebuilds).not.toHaveBeenCalled();
      pending.resolve({});
      await applying;

      expect(rebuilds).toHaveBeenCalledTimes(1);
      for (const ns of NAMESPACES) {
        expect(fake(transport.socket(ns)).io).toBe(managerOf(transport));
        expect(fake(transport.socket(ns)).active).toBe(true);
      }
    });

    it('keeps sockets on a token rotation for the same endpoint', async () => {
      transport = createSocketioTransport();
      await transport.apply(A);
      const events = transport.ensureSocket('/events');
      const rebuilds = vi.fn();
      transport.onRebuild(rebuilds);

      await transport.apply({ ...A, tokens: { access: 'at-2' } });

      expect(transport.socket('/events')).toBe(events);
      expect(fake(events).auth).toEqual({ token: 'Bearer at-2' });
      expect(rebuilds).not.toHaveBeenCalled();
    });

    it('forgets namespaces on detach', async () => {
      transport = createSocketioTransport();
      await transport.apply(A);
      transport.ensureSocket('/events');
      await transport.apply(null);
      await transport.apply(A);

      expect(transport.socket()).not.toBeNull();
      expect(transport.socket('/events')).toBeNull();
    });
  });

  describe('liveness', () => {
    it('probes the main namespace on ensureAlive and stays up when the server answers', async () => {
      transport = createSocketioTransport();
      await transport.apply(A);
      const main = fake(transport.socket());
      main.responder = () => 'ready';
      main.serverAccept();

      const status = await transport.ensureAlive();

      expect(status.up).toBe(true);
      expect(main.sent.map((p) => p.event)).toEqual(['get-status']);
      expect(managerOf(transport).engine.closed).toBe(0);
    });

    it('closes the engine once when the probe goes unanswered', async () => {
      vi.useFakeTimers();
      transport = createSocketioTransport();
      await transport.apply(A);
      const main = fake(transport.socket());
      main.serverAccept();

      const first = transport.ensureAlive();
      const second = transport.ensureAlive();
      await vi.advanceTimersByTimeAsync(3_000);
      const [a, b] = await Promise.all([first, second]);

      expect(main.sent.filter((p) => p.event === 'get-status')).toHaveLength(1);
      expect(managerOf(transport).engine.closed).toBe(1);
      expect(a.up).toBe(false);
      expect(b.up).toBe(false);
    });

    it('reads a passed engine ping deadline as down', async () => {
      transport = createSocketioTransport();
      await transport.apply(A);
      fake(transport.socket()).serverAccept();
      expect(transport.health().up).toBe(true);

      managerOf(transport).engine._pingTimeoutTime = Date.now() - 1;

      expect(transport.health()).toEqual({ up: false, lastError: 'staleConnection' });
    });

    it('reconnects a rejected namespace after a good probe and leaves pending ones alone', async () => {
      transport = createSocketioTransport();
      await transport.apply(A);
      const main = fake(transport.socket());
      main.responder = () => 'ready';
      main.serverAccept();
      const events = fake(transport.ensureSocket('/events'));
      events.serverReject('User not found', { code: 'user_not_found' });
      const pending = fake(transport.ensureSocket('/system'));

      await transport.ensureAlive();

      expect(events.active).toBe(true);
      expect(events.connects).toBe(2);
      expect(pending.connects).toBe(1);
      expect(managerOf(transport).engine.closed).toBe(0);
    });

    it('probes without waiting for a hanging query resolver', async () => {
      vi.useFakeTimers();
      let calls = 0;
      transport = createSocketioTransport({
        resolveQuery: ({ query }) => (++calls === 1 ? Promise.resolve(query) : new Promise(() => {})),
      });
      await transport.apply(A);
      const main = fake(transport.socket());
      main.responder = () => 'ready';
      main.serverAccept();

      const results: boolean[] = [];
      transport.ensureAlive().then((s) => results.push(s.up));
      await vi.advanceTimersByTimeAsync(0);
      transport.ensureAlive().then((s) => results.push(s.up));
      await vi.advanceTimersByTimeAsync(0);

      expect(results).toEqual([true, true]);
      expect(main.sent.filter((p) => p.event === 'get-status')).toHaveLength(2);
    });

    it('revives a stale connection even when the query resolver hangs', async () => {
      vi.useFakeTimers();
      let calls = 0;
      transport = createSocketioTransport({
        resolveQuery: ({ query }) => (++calls === 1 ? Promise.resolve(query) : new Promise(() => {})),
      });
      await transport.apply(A);
      fake(transport.socket()).serverAccept();
      managerOf(transport).engine._pingTimeoutTime = Date.now() - 1;

      let settled = false;
      transport.ensureAlive().then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(3_000);

      expect(settled).toBe(true);
      expect(managerOf(transport).engine.closed).toBe(1);
    });

    it('revives a stale connection by closing the shared engine', async () => {
      transport = createSocketioTransport();
      await transport.apply(A);
      const main = fake(transport.socket());
      main.serverAccept();
      managerOf(transport).engine._pingTimeoutTime = Date.now() - 1;

      await transport.ensureAlive();

      expect(managerOf(transport).engine.closed).toBe(1);
      expect(main.sent).toHaveLength(0);
    });
  });

  describe('connect errors', () => {
    it('reports a rejected token as auth error', async () => {
      transport = createSocketioTransport();
      const authErrors = vi.fn();
      transport.on('auth-error', authErrors);
      await transport.apply(A);

      fake(transport.socket()).serverReject('Unauthorized: Token is missing or invalid Bearer', { code: 'invalid_token' });
      fake(transport.ensureSocket('/events')).serverReject('Unauthenticated', { code: 'unauthenticated' });

      expect(authErrors).toHaveBeenCalledTimes(2);
    });

    it('names the token the namespace dialed with', async () => {
      transport = createSocketioTransport();
      const authErrors = vi.fn();
      transport.on('auth-error', authErrors);
      await transport.apply(A);

      fake(transport.socket()).serverReject('Unauthorized', { code: 'invalid_token' });
      fake(transport.ensureSocket('/events')).serverReject('Unauthenticated', { code: 'unauthenticated' });

      expect(authErrors).toHaveBeenNthCalledWith(1, expect.objectContaining({ access: 'at-1' }));
      expect(authErrors).toHaveBeenNthCalledWith(2, expect.objectContaining({ access: 'at-1' }));
    });

    it('does not read a role rejection as an expired token', async () => {
      transport = createSocketioTransport();
      const authErrors = vi.fn();
      transport.on('auth-error', authErrors);
      await transport.apply(A);
      fake(transport.socket()).serverAccept();

      fake(transport.ensureSocket('/logs')).serverReject('Not authorized to connect to /logs', { code: 'insufficient_role' });

      expect(authErrors).not.toHaveBeenCalled();
      expect(transport.health().up).toBe(true);
    });

    it('marks the channel down when the main namespace rejects the user', async () => {
      transport = createSocketioTransport();
      const authErrors = vi.fn();
      transport.on('auth-error', authErrors);
      await transport.apply(A);

      fake(transport.socket()).serverReject('User not found', { code: 'user_not_found' });

      expect(authErrors).not.toHaveBeenCalled();
      expect(transport.health()).toEqual({ up: false, lastError: 'User not found' });
    });
  });
});
