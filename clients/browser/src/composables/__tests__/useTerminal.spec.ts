import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, effectScope, ref, shallowRef } from 'vue';

import { CAMERA_UI_INJECTION_KEY } from '../../plugin.js';
import { useTerminal } from '../useTerminal.js';

import type { RPCClient } from '@camera.ui/rpc';
import type { ShallowRef } from 'vue';
import type { CameraUiContext, CameraUiEventType } from '../../types.js';

interface FakeStream {
  iterator: AsyncGenerator<Uint8Array>;
  push(chunk: Uint8Array): void;
  fail(err: Error): void;
  end(): void;
}

function fakeStream(): FakeStream {
  const queue: Uint8Array[] = [];
  let waiter: { resolve: (r: IteratorResult<Uint8Array>) => void; reject: (err: unknown) => void } | undefined;
  let finished = false;
  let failure: Error | undefined;

  function finish(): void {
    finished = true;
    waiter?.resolve({ value: undefined, done: true });
    waiter = undefined;
  }

  const source: AsyncIterableIterator<Uint8Array> = {
    next() {
      if (failure) return Promise.reject(failure);
      if (queue.length) return Promise.resolve({ value: queue.shift()!, done: false });
      if (finished) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve, reject) => (waiter = { resolve, reject }));
    },
    return() {
      finish();
      return Promise.resolve({ value: undefined, done: true });
    },
    [Symbol.asyncIterator]() {
      return source;
    },
  };

  // rpc streams are native async generators: return() waits for a pending next()
  const wrapper = {
    async *output(): AsyncGenerator<Uint8Array> {
      yield* source;
    },
  };

  return {
    iterator: wrapper.output(),
    end: finish,
    push(chunk) {
      const w = waiter;
      waiter = undefined;
      if (w) w.resolve({ value: chunk, done: false });
      else queue.push(chunk);
    },
    fail(err) {
      failure = err;
      const w = waiter;
      waiter = undefined;
      w?.reject(err);
    },
  };
}

function fakeServer() {
  let sessions = 0;
  const streams: FakeStream[] = [];
  const createSession = vi.fn(async () => ({ sessionId: `s${++sessions}`, pid: 1, dimensions: { cols: 80, rows: 24 } }));
  const closeSession = vi.fn(async (_sessionId: string) => {});
  const generateOutput = vi.fn((_sessionId: string) => {
    const stream = fakeStream();
    streams.push(stream);
    return stream.iterator;
  });
  const api = { createSession, closeSession, generateOutput, writeInput: vi.fn(async () => {}), resize: vi.fn(async () => {}) };
  const client = (): RPCClient => ({ createProxy: () => api }) as unknown as RPCClient;
  return { ...api, streams, client };
}

function fakeContext(client: RPCClient) {
  const rpc: ShallowRef<RPCClient | undefined> = shallowRef(client);
  const listeners = new Map<CameraUiEventType, Set<() => void>>();
  const context = {
    rpc,
    isConnected: ref(true),
    on: (event: CameraUiEventType, cb: () => void) => {
      const set = listeners.get(event) ?? new Set();
      set.add(cb);
      listeners.set(event, set);
    },
    off: (event: CameraUiEventType, cb: () => void) => listeners.get(event)?.delete(cb),
  } as unknown as CameraUiContext;
  const emit = (event: CameraUiEventType): void => listeners.get(event)?.forEach((cb) => cb());
  return { context, rpc, emit };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function inContext<T>(context: CameraUiContext, fn: () => T): { result: T; stop: () => void } {
  const app = createApp({});
  app.provide(CAMERA_UI_INJECTION_KEY, context);
  const scope = effectScope();
  const result = app.runWithContext(() => scope.run(fn)!);
  return { result, stop: () => scope.stop() };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useTerminal', () => {
  it('closes the old shell and its stream when the client changes', async () => {
    const server = fakeServer();
    const { context, rpc, emit } = fakeContext(server.client());
    const onData = vi.fn();
    const { result, stop } = inContext(context, () => useTerminal());
    await result.connect({ onData });
    await flush();

    rpc.value = server.client();
    emit('reconnected');
    await flush();
    server.streams[0]!.push(new Uint8Array([1]));
    await flush();

    expect(server.closeSession).toHaveBeenCalledWith('s1');
    expect(onData).not.toHaveBeenCalled();
    expect(server.createSession).toHaveBeenCalledTimes(2);
    expect(result.sessionId.value).toBe('s2');
    expect(result.isConnected.value).toBe(true);
    stop();
  });

  it('keeps the shell across a short blip on the same client', async () => {
    const server = fakeServer();
    const { context, emit } = fakeContext(server.client());
    const onData = vi.fn();
    const { result, stop } = inContext(context, () => useTerminal());
    await result.connect({ onData });
    await flush();

    emit('reconnected');
    await flush();
    server.streams[0]!.push(new Uint8Array([1]));
    await flush();

    expect(server.createSession).toHaveBeenCalledTimes(1);
    expect(server.closeSession).not.toHaveBeenCalled();
    expect(onData).toHaveBeenCalledTimes(1);
    expect(result.isConnected.value).toBe(true);
    stop();
  });

  it('opens a new shell after an outage that outlasted the debounce', async () => {
    const server = fakeServer();
    const { context, emit } = fakeContext(server.client());
    const { result, stop } = inContext(context, () => useTerminal());
    await result.connect({});
    await flush();

    emit('disconnected');
    emit('reconnected');
    await flush();

    expect(server.closeSession).toHaveBeenCalledWith('s1');
    expect(server.createSession).toHaveBeenCalledTimes(2);
    expect(result.sessionId.value).toBe('s2');
    stop();
  });

  it('opens a new shell when a stream kept across a blip fails', async () => {
    const server = fakeServer();
    const { context, emit } = fakeContext(server.client());
    const onError = vi.fn();
    const { result, stop } = inContext(context, () => useTerminal());
    await result.connect({ onError });
    await flush();

    emit('reconnected');
    await flush();
    server.streams[0]!.fail(new Error('stream lost'));
    await flush();

    expect(server.closeSession).toHaveBeenCalledWith('s1');
    expect(server.createSession).toHaveBeenCalledTimes(2);
    expect(result.sessionId.value).toBe('s2');
    expect(result.isConnected.value).toBe(true);
    expect(onError).not.toHaveBeenCalled();
    stop();
  });

  it('reports a failure of a new stream after a kept one ended', async () => {
    const server = fakeServer();
    const { context, emit } = fakeContext(server.client());
    const onError = vi.fn();
    const { result, stop } = inContext(context, () => useTerminal());
    await result.connect({ onError });
    await flush();

    emit('reconnected');
    await flush();
    server.streams[0]!.end();
    await flush();
    expect(result.isConnected.value).toBe(false);

    await result.connect({ onError });
    await flush();
    server.streams[1]!.fail(new Error('stream lost'));
    await flush();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(server.createSession).toHaveBeenCalledTimes(2);
    stop();
  });

  it('closes the server session when its stream fails', async () => {
    const server = fakeServer();
    const { context } = fakeContext(server.client());
    const onError = vi.fn();
    const { result, stop } = inContext(context, () => useTerminal());
    await result.connect({ onError });
    await flush();

    server.streams[0]!.fail(new Error('stream lost'));
    await flush();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(server.closeSession).toHaveBeenCalledWith('s1');
    expect(result.isConnected.value).toBe(false);
    stop();
  });

  it('asks for a shell only once when the reply times out', async () => {
    const server = fakeServer();
    const client = server.client();
    const { context, rpc } = fakeContext(client);
    server.createSession.mockImplementationOnce(async () => {
      rpc.value = undefined;
      rpc.value = client;
      throw Object.assign(new Error('timed out'), { code: 'TIMEOUT' });
    });
    const { result, stop } = inContext(context, () => useTerminal());

    const connecting = result.connect({});
    await vi.advanceTimersByTimeAsync(5_000);
    await connecting;

    expect(server.createSession).toHaveBeenCalledTimes(1);
    expect(result.error.value?.message).toBe('timed out');
    stop();
  });
});
