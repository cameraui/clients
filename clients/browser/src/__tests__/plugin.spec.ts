import { afterEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

import { rpcCall } from '../composables/useRpc.js';
import { createCameraUiPlugin } from '../plugin.js';

import type { RPCClient } from '@camera.ui/rpc';
import type { ConnectionTarget } from '@camera.ui/transport';
import type { NatsTransport } from '@camera.ui/transport/transports/nats';
import type { CameraUiContext } from '../types.js';

function fakeTransport(initial: RPCClient | null) {
  let current = initial;
  const listeners = new Set<(client: RPCClient | null) => void>();
  const transport = {
    getClient: () => current,
    subscribeClient(listener: (client: RPCClient | null) => void) {
      listeners.add(listener);
      listener(current);
      return () => listeners.delete(listener);
    },
    on: () => () => {},
  } as unknown as NatsTransport;
  function emit(next: RPCClient | null): void {
    current = next;
    for (const listener of listeners) listener(next);
  }
  return { transport, emit };
}

function install(input: Parameters<typeof createCameraUiPlugin>[0]): CameraUiContext {
  let ctx: CameraUiContext | undefined;
  createCameraUiPlugin(input).install({ provide: (_key, value) => (ctx = value as CameraUiContext) });
  return ctx!;
}

describe('createCameraUiPlugin', () => {
  it('exposes the bulk lane client while it is up', () => {
    const main = fakeTransport({ isConnected: true } as unknown as RPCClient);
    const bulkClient = { isConnected: true } as unknown as RPCClient;
    const bulk = fakeTransport(null);
    const ctx = install({ natsTransport: main.transport, bulkTransport: bulk.transport, target: ref(null) });

    expect(ctx.bulkRpc?.value).toBeUndefined();
    bulk.emit(bulkClient);
    expect(ctx.bulkRpc?.value).toBe(bulkClient);
    bulk.emit(null);
    expect(ctx.bulkRpc?.value).toBeUndefined();
  });

  it('has no bulk lane without a bulk transport', () => {
    const main = fakeTransport(null);
    const ctx = install({ natsTransport: main.transport, target: ref(null) });

    expect(ctx.bulkRpc).toBeUndefined();
  });

  it('adds no proxy session to direct requests', () => {
    const main = fakeTransport(null);
    const target = ref({ endpoint: { url: 'https://cam.example' }, tokens: { access: 'a', proxySession: 'session-1' } } as unknown as ConnectionTarget);
    const ctx = install({ natsTransport: main.transport, target });

    expect(ctx.endpoint.value).toBe('https://cam.example');
    expect(ctx.token.value).toBe('a');
    expect(ctx.extraProxyQuery.value).toBeUndefined();
  });
});

describe('connection debounce', () => {
  function events(ctx: CameraUiContext) {
    const seen: string[] = [];
    ctx.on('reconnected', () => seen.push('reconnected'));
    ctx.on('disconnected', () => seen.push('disconnected'));
    return seen;
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps isConnected through a drop shorter than 4 s and drops the client at once', async () => {
    vi.useFakeTimers();
    const client = { isConnected: true } as unknown as RPCClient;
    const main = fakeTransport(client);
    const ctx = install({ natsTransport: main.transport, target: ref(null) });
    const seen = events(ctx);

    main.emit(null);
    expect(ctx.rpc.value).toBeUndefined();
    await vi.advanceTimersByTimeAsync(3_999);
    expect(ctx.isConnected.value).toBe(true);

    main.emit(client);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(ctx.rpc.value).toBe(client);
    expect(ctx.isConnected.value).toBe(true);
    expect(seen).toEqual(['reconnected']);
  });

  it('reports the connection lost after 4 s and back once a client returns', async () => {
    vi.useFakeTimers();
    const client = { isConnected: true } as unknown as RPCClient;
    const main = fakeTransport(client);
    const ctx = install({ natsTransport: main.transport, target: ref(null) });
    const seen = events(ctx);

    main.emit(null);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(ctx.isConnected.value).toBe(false);

    main.emit(client);

    expect(ctx.isConnected.value).toBe(true);
    expect(seen).toEqual(['disconnected', 'reconnected']);
  });

  it('reports a new client as reconnected without a drop', () => {
    const first = { isConnected: true } as unknown as RPCClient;
    const second = { isConnected: true } as unknown as RPCClient;
    const main = fakeTransport(first);
    const ctx = install({ natsTransport: main.transport, target: ref(null) });
    const seen = events(ctx);

    main.emit(second);

    expect(ctx.rpc.value).toBe(second);
    expect(seen).toEqual(['reconnected']);
  });

  it('does not report the first connect as reconnected', () => {
    const main = fakeTransport(null);
    const ctx = install({ natsTransport: main.transport, target: ref(null) });
    const seen = events(ctx);

    main.emit({ isConnected: true } as unknown as RPCClient);

    expect(ctx.isConnected.value).toBe(true);
    expect(seen).toEqual([]);
  });

  it('lets a call made during a short drop run on the returning client', async () => {
    vi.useFakeTimers();
    const client = { isConnected: true } as unknown as RPCClient;
    const main = fakeTransport(client);
    const ctx = install({ natsTransport: main.transport, target: ref(null) });

    main.emit(null);
    const fn = vi.fn().mockResolvedValue('ok');
    const call = rpcCall(ctx.rpc, fn);
    await vi.advanceTimersByTimeAsync(1_000);
    main.emit(client);

    expect(await call).toBe('ok');
    expect(fn).toHaveBeenCalledWith(client);
  });
});

describe('link settle window', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function callsUntilSettled(ctx: CameraUiContext): Promise<number> {
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error("no responders: 'rpc.camera.cam-1.controller.rpc'"), { name: 'NoResponders' }));
    const done = rpcCall(ctx.rpc, fn).catch(() => undefined);
    await vi.runAllTimersAsync();
    await done;
    return fn.mock.calls.length;
  }

  it('waits for missing responders after a reconnect', async () => {
    vi.useFakeTimers();
    const client = { isConnected: true } as unknown as RPCClient;
    const main = fakeTransport(null);
    const ctx = install({ natsTransport: main.transport, target: ref(null) });

    main.emit(client);
    expect(await callsUntilSettled(ctx)).toBe(1);

    main.emit(null);
    main.emit(client);
    expect(await callsUntilSettled(ctx)).toBe(4);
  });
});
