import { createRPCClient } from '@camera.ui/rpc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createNatsTransport } from '../nats.js';

import type { ConnectionTarget } from '../../core/types.js';
import type { NatsTransport, NatsTransportOptions } from '../nats.js';

vi.mock('@camera.ui/rpc', () => ({ createRPCClient: vi.fn() }));

const A: ConnectionTarget = { endpoint: { url: 'https://nvr.local:3443', mode: 'direct-lan' }, tokens: { access: 'at-1' } };
const A_ROTATED: ConnectionTarget = { ...A, tokens: { access: 'at-2' } };
const B: ConnectionTarget = { endpoint: { url: 'https://remote.example', mode: 'direct-wan' }, tokens: { access: 'at-1' } };

class FakeRpcClient {
  servers: string[];
  isStale = false;
  closed = false;
  forceReconnects = 0;
  flushes: Array<number | undefined> = [];
  flushError: Error | undefined;
  ignoreAbort = false;
  signal: AbortSignal | undefined;
  private settle: { resolve: () => void; reject: (err: unknown) => void } | undefined;
  private readonly events: unknown[] = [];
  private wake: (() => void) | undefined;

  constructor(
    readonly options: { servers: string[] } & Record<string, unknown>,
    private readonly onDial: (client: FakeRpcClient) => void,
  ) {
    this.servers = options.servers;
  }

  connect(opts?: { signal?: AbortSignal }): Promise<void> {
    this.signal = opts?.signal;
    const connecting = new Promise<void>((resolve, reject) => {
      this.settle = { resolve, reject };
      opts?.signal?.addEventListener(
        'abort',
        () => {
          if (!this.ignoreAbort) reject(new DOMException('Aborted', 'AbortError'));
        },
        { once: true },
      );
    });
    this.onDial(this);
    return connecting;
  }

  open(): void {
    this.settle?.resolve();
  }

  refuse(err: unknown): void {
    this.settle?.reject(err);
  }

  abortClose(): void {
    this.closed = true;
    this.wake?.();
  }

  setServers(servers: string[]): void {
    this.servers = servers;
  }

  async flush(timeoutMs?: number): Promise<void> {
    this.flushes.push(timeoutMs);
    if (this.flushError) throw this.flushError;
  }

  async forceReconnect(): Promise<void> {
    this.forceReconnects++;
  }

  status(): AsyncIterable<unknown> {
    return { [Symbol.asyncIterator]: () => this.iterate() };
  }

  emitStatus(event: unknown): void {
    this.events.push(event);
    this.wake?.();
  }

  private async *iterate(): AsyncGenerator<unknown> {
    while (!this.closed) {
      while (this.events.length > 0) yield this.events.shift();
      await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }
}

function closeError(code: number): Error {
  return Object.assign(new Error(`close code ${code}`), { wsCloseCode: code });
}

let clients: FakeRpcClient[] = [];
let onDial: (client: FakeRpcClient) => void = () => {};
let transport: NatsTransport | undefined;

function make(options: NatsTransportOptions = {}): NatsTransport {
  transport = createNatsTransport(options);
  return transport;
}

function last(): FakeRpcClient {
  const client = clients.at(-1);
  if (!client) throw new Error('no client dialed yet');
  return client;
}

beforeEach(() => {
  clients = [];
  onDial = () => {};
  vi.mocked(createRPCClient).mockImplementation((options) => {
    const client = new FakeRpcClient(options as never, (c) => onDial(c));
    clients.push(client);
    return client as never;
  });
});

afterEach(async () => {
  await transport?.dispose();
  transport = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(createRPCClient).mockReset();
});

describe('nats transport: connecting', () => {
  it('asks the client to fail fast on the first dial so the transport owns the retry', async () => {
    onDial = (c) => c.open();
    const t = make();
    await t.apply(A);
    expect(createRPCClient).toHaveBeenCalledWith(expect.objectContaining({ waitOnFirstConnect: false }));
    expect(t.health().up).toBe(true);
    expect(t.getClient()).toBe(last());
  });

  it('retries a failed first dial with growing backoff', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    onDial = (c) => c.refuse(closeError(4500));
    const t = make();
    t.apply(A).catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(clients).toHaveLength(1);
    expect(t.health()).toMatchObject({ up: false });

    const dialsAt: number[] = [];
    for (const step of [1_000, 2_000, 4_000, 5_000, 5_000]) {
      await vi.advanceTimersByTimeAsync(step - 1);
      dialsAt.push(clients.length);
      await vi.advanceTimersByTimeAsync(1);
      dialsAt.push(clients.length);
    }
    expect(dialsAt).toEqual([1, 2, 2, 3, 3, 4, 4, 5, 5, 6]);
  });

  it('a newer target aborts the dial in flight and a late success of it is dropped', async () => {
    const t = make();
    const first = t.apply(A);
    await vi.waitFor(() => expect(clients).toHaveLength(1));
    const stale = last();
    stale.ignoreAbort = true;
    onDial = (c) => c.open();
    await t.apply(B);
    const current = last();
    stale.open();
    await first;

    expect(stale.signal?.aborted).toBe(true);
    expect(stale.closed).toBe(true);
    expect(current).not.toBe(stale);
    expect(t.getClient()).toBe(current);
    expect(current.servers[0]).toContain('remote.example');
  });

  it('stops dialing once disposed and leaves no timer behind', async () => {
    vi.useFakeTimers();
    onDial = (c) => c.refuse(closeError(4500));
    const t = make();
    t.apply(A).catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    await t.dispose();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(clients).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops dialing on detach', async () => {
    vi.useFakeTimers();
    onDial = (c) => c.refuse(closeError(4500));
    const t = make();
    t.apply(A).catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    await t.apply(null);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(clients).toHaveLength(1);
    expect(t.health()).toEqual({ up: false, lastError: 'detached' });
  });
});

describe('nats transport: close codes at first contact', () => {
  it.each([
    { code: 4403, label: 'forbidden' },
    { code: 4400, label: 'bad request' },
  ])('$code ($label) stops dialing until the token or target changes', async ({ code }) => {
    vi.useFakeTimers();
    onDial = (c) => c.refuse(closeError(code));
    const t = make();
    const authErrors = vi.fn();
    t.on('auth-error', authErrors);

    await expect(t.apply(A)).rejects.toMatchObject({ wsCloseCode: code });
    await vi.advanceTimersByTimeAsync(60_000);
    await t.apply(A);
    await t.ensureAlive();

    expect(clients).toHaveLength(1);
    expect(authErrors).not.toHaveBeenCalled();
    expect(t.health().up).toBe(false);
    expect(t.health().lastError).toMatch(/^forbidden/);

    onDial = (c) => c.open();
    await t.apply(A_ROTATED);
    expect(clients).toHaveLength(2);
    expect(t.health().up).toBe(true);
  });

  it('4401 reports the rejected token once and waits for a new one', async () => {
    vi.useFakeTimers();
    onDial = (c) => c.refuse(closeError(4401));
    const t = make();
    const authErrors = vi.fn();
    t.on('auth-error', authErrors);

    await expect(t.apply(A)).rejects.toMatchObject({ wsCloseCode: 4401 });
    await vi.advanceTimersByTimeAsync(60_000);
    await t.apply(A);
    await t.ensureAlive();

    expect(clients).toHaveLength(1);
    expect(authErrors).toHaveBeenCalledTimes(1);
    expect(authErrors).toHaveBeenCalledWith(expect.objectContaining({ access: 'at-1' }));

    onDial = (c) => c.open();
    await t.apply(A_ROTATED);
    expect(clients).toHaveLength(2);
    expect(last().servers[0]).toContain('token=at-2');
    expect(t.health().up).toBe(true);
  });

  it('4401 with a resolver signs again and redials without an auth-error', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    let signed = 0;
    const resolveServers = vi.fn(async () => [`wss://signed/${++signed}`]);
    onDial = (c) => (clients.length === 1 ? c.refuse(closeError(4401)) : c.open());
    const t = make({ resolveServers });
    const authErrors = vi.fn();
    t.on('auth-error', authErrors);

    const applying = t.apply(A);
    await vi.advanceTimersByTimeAsync(1_000);
    await applying;

    expect(authErrors).not.toHaveBeenCalled();
    expect(resolveServers).toHaveBeenCalledTimes(2);
    expect(last().servers).toEqual(['wss://signed/2']);
    expect(t.health().up).toBe(true);
  });
});

describe('nats transport: close codes on a live connection', () => {
  it.each([
    { code: 4403, label: 'forbidden' },
    { code: 4400, label: 'bad request' },
  ])('$code ($label) drops the client and dials again only for a new token or target', async ({ code }) => {
    onDial = (c) => c.open();
    const t = make();
    const authErrors = vi.fn();
    t.on('auth-error', authErrors);
    await t.apply(A);
    const live = last();
    const states: boolean[] = [];
    t.subscribeClient((client) => states.push(client !== null));

    live.emitStatus({ type: 'error', error: closeError(code), data: closeError(code) });
    await vi.waitFor(() => expect(live.closed).toBe(true));
    await t.apply(A);
    await t.ensureAlive();
    await t.forceReconnect();

    expect(clients).toHaveLength(1);
    expect(live.forceReconnects).toBe(0);
    expect(authErrors).not.toHaveBeenCalled();
    expect(t.getClient()).toBeNull();
    expect(t.health()).toMatchObject({ up: false, lastError: expect.stringMatching(/^forbidden/) });
    expect(states).toEqual([true, false]);

    await t.apply(A_ROTATED);
    expect(clients).toHaveLength(2);
    expect(t.health().up).toBe(true);

    last().emitStatus({ type: 'error', error: closeError(code), data: closeError(code) });
    await vi.waitFor(() => expect(last().closed).toBe(true));
    await t.apply(B);
    expect(clients).toHaveLength(3);
    expect(t.getClient()).toBe(last());
  });

  it('a refusal that carries only the error drops the client for good', async () => {
    onDial = (c) => c.open();
    const t = make();
    await t.apply(A);
    const live = last();

    live.emitStatus({ type: 'error', error: closeError(4403) });
    await vi.waitFor(() => expect(live.closed).toBe(true));
    await t.apply(A);

    expect(clients).toHaveLength(1);
    expect(t.health()).toMatchObject({ up: false, lastError: expect.stringMatching(/^forbidden/) });
  });

  it('a refusal reason that already says forbidden is reported once', async () => {
    onDial = (c) => c.open();
    const t = make();
    await t.apply(A);
    const refusal = Object.assign(new Error('forbidden: token not allowed on rpc bus'), { wsCloseCode: 4403 });

    last().emitStatus({ type: 'error', error: refusal, data: refusal });
    await vi.waitFor(() => expect(last().closed).toBe(true));

    expect(t.health().lastError).toBe('forbidden: token not allowed on rpc bus');
  });

  it.each([
    { label: 'without a close code', data: new Error('nats: 403 in a subject name') },
    { label: 'with a transient close code', data: Object.assign(new Error('upstream lost: 403'), { wsCloseCode: 4500 }) },
  ])('an error that only mentions a refusal leaves the client running ($label)', async ({ data }) => {
    onDial = (c) => c.open();
    const t = make();
    await t.apply(A);
    const live = last();

    live.emitStatus({ type: 'error', error: data, data });
    await vi.waitFor(() => expect(t.health().up).toBe(false));
    live.emitStatus({ type: 'reconnect' });

    await vi.waitFor(() => expect(t.health().up).toBe(true));
    expect(live.closed).toBe(false);
    expect(t.getClient()).toBe(live);
  });

  it('a token that was being signed when the refusal came is still tried', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const resolveServers = vi.fn(async ({ target }: { target: ConnectionTarget }) => {
      if (target.tokens.access === 'at-2') await gate;
      return [`wss://signed?token=${target.tokens.access}`];
    });
    onDial = (c) => c.open();
    const t = make({ resolveServers });
    await t.apply(A);
    const live = last();

    const rotating = t.apply(A_ROTATED);
    live.emitStatus({ type: 'error', error: closeError(4403), data: closeError(4403) });
    await vi.waitFor(() => expect(live.closed).toBe(true));
    release();
    await rotating;

    expect(clients).toHaveLength(2);
    expect(last().servers).toEqual(['wss://signed?token=at-2']);
    expect(t.health().up).toBe(true);
  });
});

describe('nats transport: server errors on a live connection', () => {
  it('a permission violation keeps the connection up and is not taken for an auth failure', async () => {
    onDial = (c) => c.open();
    const t = make();
    const authErrors = vi.fn();
    const downs: string[] = [];
    t.on('auth-error', authErrors);
    t.on('down', ({ reason }) => downs.push(reason));
    await t.apply(A);
    const live = last();
    const violation = Object.assign(new Error('Permissions Violation for Subscription to "admin.>"'), {
      name: 'PermissionViolationError',
      operation: 'subscription',
      subject: 'admin.>',
    });

    live.emitStatus({ type: 'error', error: violation });
    live.emitStatus({ type: 'disconnect' });
    await vi.waitFor(() => expect(downs).toEqual(['disconnect']));
    live.emitStatus({ type: 'reconnect' });
    await vi.waitFor(() => expect(t.health().up).toBe(true));

    expect(authErrors).not.toHaveBeenCalled();
    expect(live.closed).toBe(false);
    expect(t.getClient()).toBe(live);
  });

  it.each([
    { label: 'a server error', event: { type: 'error', error: new Error('Authorization Violation') }, reason: 'Authorization Violation' },
    { label: 'an error status without payload', event: { type: 'error' }, reason: 'server error' },
  ])('$label marks the connection down and the next reconnect brings it back', async ({ event, reason }) => {
    onDial = (c) => c.open();
    const t = make();
    const authErrors = vi.fn();
    t.on('auth-error', authErrors);
    await t.apply(A);
    const live = last();

    live.emitStatus(event);
    await vi.waitFor(() => expect(t.health()).toEqual({ up: false, lastError: reason }));
    live.emitStatus({ type: 'reconnect' });
    await vi.waitFor(() => expect(t.health().up).toBe(true));

    expect(authErrors).not.toHaveBeenCalled();
    expect(t.getClient()).toBe(live);
  });
});

describe('nats transport: resolver failures', () => {
  it('keeps the target and retries the resolver until it answers', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    let calls = 0;
    const resolveServers = vi.fn(async ({ defaultServers }: { defaultServers: readonly string[] }) => {
      if (++calls <= 2) throw new Error('resolve timeout');
      return [...defaultServers];
    });
    onDial = (c) => c.open();
    const t = make({ resolveServers });

    let settled = false;
    const applying = t.apply(A).then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.health()).toEqual({ up: false, lastError: 'resolve timeout' });
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(3_000);
    await applying;
    expect(resolveServers).toHaveBeenCalledTimes(3);
    expect(clients).toHaveLength(1);
    expect(t.health().up).toBe(true);
  });

  it('an apply of the same target dials again after a dial crashed', async () => {
    vi.mocked(createRPCClient).mockImplementationOnce(() => {
      throw new Error('bad options');
    });
    const t = make();
    await expect(t.apply(A)).rejects.toThrow('bad options');

    onDial = (c) => c.open();
    await t.apply(A);
    expect(t.health().up).toBe(true);
  });
});

describe('nats transport: endpoint swap and resign', () => {
  it('reports down while it dials the new endpoint after a swap', async () => {
    onDial = (c) => c.open();
    const t = make();
    await t.apply(A);
    const downs: string[] = [];
    t.on('down', ({ reason }) => downs.push(reason));

    onDial = () => {};
    t.apply(B);
    await vi.waitFor(() => expect(clients).toHaveLength(2));

    expect(t.health().up).toBe(false);
    expect(t.getClient()).toBeNull();
    expect(downs).toEqual(['endpoint-changed']);

    last().open();
    await vi.waitFor(() => expect(t.health().up).toBe(true));
    expect(t.getClient()).toBe(last());
  });

  it('a token rotation keeps the live client and only swaps its server list', async () => {
    onDial = (c) => c.open();
    const t = make();
    await t.apply(A);
    const live = last();
    await t.apply(A_ROTATED);

    expect(clients).toHaveLength(1);
    expect(live.closed).toBe(false);
    expect(live.servers[0]).toContain('token=at-2');
    expect(t.health().up).toBe(true);
  });

  it('an expired signature on a live connection rebuilds with freshly resolved servers', async () => {
    let signed = 0;
    const resolveServers = vi.fn(async () => [`wss://signed/${++signed}`]);
    onDial = (c) => c.open();
    const t = make({ resolveServers });
    await t.apply(A);
    const old = last();
    const states: boolean[] = [];
    t.subscribeClient((client) => states.push(client !== null));

    onDial = () => {};
    old.emitStatus({ type: 'error', error: Object.assign(new Error('unauthorized'), { wsCloseCode: 4401 }) });
    await vi.waitFor(() => expect(clients).toHaveLength(2));

    expect(old.closed).toBe(true);
    expect(t.health()).toMatchObject({ up: false });
    expect(t.getClient()).toBeNull();

    last().open();
    await vi.waitFor(() => expect(t.health().up).toBe(true));
    expect(last().servers).toEqual(['wss://signed/2']);
    expect(states).toEqual([true, false, true]);
  });
});

describe('nats transport: ensureAlive', () => {
  it('does nothing without a target', async () => {
    const t = make();
    await expect(t.ensureAlive()).resolves.toEqual({ up: false });
    expect(clients).toHaveLength(0);
  });

  it('probes a healthy connection and leaves it alone', async () => {
    onDial = (c) => c.open();
    const t = make();
    await t.apply(A);
    await expect(t.ensureAlive()).resolves.toEqual({ up: true });
    expect(last().forceReconnects).toBe(0);
  });

  it('forces a redial when the probe of an up connection fails', async () => {
    onDial = (c) => c.open();
    const t = make();
    await t.apply(A);
    last().flushError = new Error('timeout');
    await t.ensureAlive();
    expect(last().forceReconnects).toBe(1);
    expect(clients).toHaveLength(1);
  });

  it('forces a redial of a client the library is still reconnecting', async () => {
    onDial = (c) => c.open();
    const t = make();
    await t.apply(A);
    last().emitStatus({ type: 'disconnect' });
    await vi.waitFor(() => expect(t.health().up).toBe(false));
    await t.ensureAlive();
    expect(last().forceReconnects).toBe(1);
  });

  it('keeps a wall-clock stale connection that still answers the probe', async () => {
    onDial = (c) => c.open();
    const t = make();
    await t.apply(A);
    const live = last();
    live.isStale = true;
    expect(t.health()).toEqual({ up: false, lastError: 'staleConnection' });

    await expect(t.ensureAlive()).resolves.toEqual({ up: true });
    expect(live.flushes).toEqual([3_000]);
    expect(live.forceReconnects).toBe(0);
  });

  it('reads healthy after a stale connection answers the probe, for one heartbeat window', async () => {
    vi.useFakeTimers();
    onDial = (c) => c.open();
    const t = make({ pingInterval: 25_000, pingTimeout: 20_000 });
    await t.apply(A);
    const live = last();
    live.isStale = true;

    await t.ensureAlive();
    expect(t.health()).toEqual({ up: true });

    await vi.advanceTimersByTimeAsync(45_000);
    expect(t.health()).toEqual({ up: true });
    await vi.advanceTimersByTimeAsync(1);
    expect(t.health()).toEqual({ up: false, lastError: 'staleConnection' });
  });

  it.each([
    { pingTimeout: 20_000, window: 140_000 },
    { pingTimeout: 0, window: 240_000 },
  ])('a ping interval of 0 holds the probe for the client default interval (pingTimeout $pingTimeout)', async ({ pingTimeout, window }) => {
    vi.useFakeTimers();
    onDial = (c) => c.open();
    const t = make({ pingInterval: 0, pingTimeout });
    await t.apply(A);
    const live = last();
    live.isStale = true;

    await t.ensureAlive();
    await vi.advanceTimersByTimeAsync(window);
    expect(t.health()).toEqual({ up: true });
    await vi.advanceTimersByTimeAsync(1);
    expect(t.health()).toEqual({ up: false, lastError: 'staleConnection' });
  });

  it('redials a wall-clock stale connection whose probe goes unanswered', async () => {
    onDial = (c) => c.open();
    const t = make();
    await t.apply(A);
    const live = last();
    live.isStale = true;
    live.flushError = new Error('timeout');

    await t.ensureAlive();
    expect(live.flushes).toEqual([3_000]);
    expect(live.forceReconnects).toBe(1);
    expect(t.health()).toEqual({ up: false, lastError: 'staleConnection' });
  });

  it('waits for a dial that just started instead of starting another', async () => {
    vi.useFakeTimers();
    const t = make();
    t.apply(A).catch(() => {});
    await vi.advanceTimersByTimeAsync(300);
    const first = last();

    const waking = t.ensureAlive();
    await vi.advanceTimersByTimeAsync(400);
    first.open();
    await expect(waking).resolves.toEqual({ up: true });

    expect(clients).toHaveLength(1);
    expect(first.signal?.aborted).toBe(false);
  });

  it('replaces a dial that has been hanging for a while', async () => {
    vi.useFakeTimers();
    const t = make();
    t.apply(A).catch(() => {});
    await vi.advanceTimersByTimeAsync(3_000);
    const hanging = last();

    onDial = (c) => c.open();
    await expect(t.ensureAlive()).resolves.toEqual({ up: true });
    expect(hanging.signal?.aborted).toBe(true);
    expect(clients).toHaveLength(2);
  });

  it('skips the backoff wait and dials right away', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    onDial = (c) => c.refuse(closeError(4500));
    const t = make();
    t.apply(A).catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(clients).toHaveLength(1);

    onDial = (c) => c.open();
    await expect(t.ensureAlive()).resolves.toEqual({ up: true });
    expect(clients).toHaveLength(2);
  });

  it('returns after one attempt while the server stays unreachable', async () => {
    vi.useFakeTimers();
    onDial = (c) => c.refuse(closeError(4500));
    const t = make();
    t.apply(A).catch(() => {});
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(t.ensureAlive()).resolves.toMatchObject({ up: false });
  });

  it('settles after dispose', async () => {
    onDial = (c) => c.open();
    const t = make();
    await t.apply(A);
    await t.dispose();
    await expect(t.ensureAlive()).resolves.toEqual({ up: false });
  });
});
