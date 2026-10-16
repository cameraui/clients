import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, effectScope, ref, shallowRef } from 'vue';

import { CAMERA_UI_INJECTION_KEY } from '../../plugin.js';
import { markLinkRestored, rpcCall, useRpcSubscription } from '../useRpc.js';

import type { RPCClient } from '@camera.ui/rpc';
import type { ShallowRef } from 'vue';
import type { CameraUiContext } from '../../types.js';

function fakeClient(state: { isConnected?: boolean; isClosed?: boolean } = {}): RPCClient {
  return { isConnected: state.isConnected ?? true, isClosed: state.isClosed ?? false } as unknown as RPCClient;
}

function rpcError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

// shape of the nats NoRespondersError the lib throws once its own retries are spent
function noResponders(): Error {
  return Object.assign(new Error("no responders: 'rpc.camera.cam-1.controller.rpc.refreshStates'"), { name: 'NoResponders' });
}

function inContext<T>(rpc: ShallowRef<RPCClient | undefined>, isConnected: { value: boolean }, fn: () => T): { result: T; stop: () => void } {
  const app = createApp({});
  app.provide(CAMERA_UI_INJECTION_KEY, { rpc, isConnected } as unknown as CameraUiContext);
  const scope = effectScope();
  const result = app.runWithContext(() => scope.run(fn)!);
  return { result, stop: () => scope.stop() };
}

async function settle<T>(promise: Promise<T>): Promise<{ value?: T; error?: unknown }> {
  const result = promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await vi.runAllTimersAsync();
  return result;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('rpcCall retry', () => {
  it('does not retry remote errors whatever their text says', async () => {
    const rpcRef = shallowRef<RPCClient | undefined>(fakeClient());
    for (const err of [
      rpcError('NOT_FOUND', 'No responders for rpc.plugin.x.streamUrl'),
      rpcError('INTERNAL_ERROR', 'socket hang up'),
      rpcError('INTERNAL_ERROR', 'upstream timed out'),
      rpcError('INTERNAL_ERROR', 'Not connected'),
      rpcError('CONNECTION_CLOSED', 'Connection closed'),
      new Error('no responders available'),
    ]) {
      const fn = vi.fn().mockRejectedValue(err);
      const { error } = await settle(rpcCall(rpcRef, fn));
      expect(error).toBe(err);
      expect(fn).toHaveBeenCalledTimes(1);
    }
  });

  it('does not retry a TIMEOUT on a link that stayed up', async () => {
    const rpcRef = shallowRef<RPCClient | undefined>(fakeClient());
    const fn = vi.fn().mockRejectedValue(rpcError('TIMEOUT', 'RPC call to "rpc.x" timed out after 10000ms'));

    const { error } = await settle(rpcCall(rpcRef, fn));

    expect((error as { code?: string }).code).toBe('TIMEOUT');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a TIMEOUT when the caller marked the read idempotent', async () => {
    const rpcRef = shallowRef<RPCClient | undefined>(fakeClient());
    const fn = vi.fn().mockRejectedValueOnce(rpcError('TIMEOUT', 'timed out')).mockResolvedValueOnce('cached');

    const { value } = await settle(rpcCall(rpcRef, fn, { retryOnTimeout: true }));

    expect(value).toBe('cached');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries a TIMEOUT when the link dropped and came back during the attempt', async () => {
    const client = fakeClient();
    const rpcRef = shallowRef<RPCClient | undefined>(client);
    const fn = vi
      .fn()
      .mockImplementationOnce(async () => {
        rpcRef.value = undefined;
        rpcRef.value = client;
        throw rpcError('TIMEOUT', 'timed out');
      })
      .mockResolvedValueOnce('ok');

    const { value } = await settle(rpcCall(rpcRef, fn));

    expect(value).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on the new client after the transport rebuilt it', async () => {
    const first = fakeClient();
    const second = fakeClient();
    const rpcRef = shallowRef<RPCClient | undefined>(first);
    const fn = vi
      .fn()
      .mockImplementationOnce(async () => {
        rpcRef.value = second;
        throw rpcError('CONNECTION_CLOSED', 'Connection closed');
      })
      .mockResolvedValueOnce('ok');

    const { value } = await settle(rpcCall(rpcRef, fn));

    expect(value).toBe('ok');
    expect(fn.mock.calls[1][0]).toBe(second);
  });

  it('waits for the link and retries when it is down at failure time', async () => {
    const client = fakeClient();
    const rpcRef = shallowRef<RPCClient | undefined>(client);
    const fn = vi
      .fn()
      .mockImplementationOnce(async () => {
        rpcRef.value = undefined;
        setTimeout(() => (rpcRef.value = client), 2_000);
        throw rpcError('TIMEOUT', 'timed out');
      })
      .mockResolvedValueOnce('ok');

    const { value } = await settle(rpcCall(rpcRef, fn));

    expect(value).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries the local not-connected error', async () => {
    const rpcRef = shallowRef<RPCClient | undefined>(fakeClient());
    const local = vi.fn().mockRejectedValueOnce(new Error('Not connected')).mockResolvedValueOnce('ok');

    expect((await settle(rpcCall(rpcRef, local))).value).toBe('ok');
    expect(local).toHaveBeenCalledTimes(2);
  });

  it('retries when the connection closed for good without a disconnect', async () => {
    const client = fakeClient({ isConnected: false, isClosed: false });
    const rpcRef = shallowRef<RPCClient | undefined>(client);
    const fn = vi.fn().mockRejectedValueOnce(rpcError('CONNECTION_CLOSED', 'Connection closed')).mockResolvedValueOnce('ok');

    const { value } = await settle(rpcCall(rpcRef, fn));

    expect(value).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('gives up after maxRetries on a link that keeps failing', async () => {
    const client = fakeClient({ isConnected: false, isClosed: false });
    const rpcRef = shallowRef<RPCClient | undefined>(client);
    const fn = vi.fn().mockRejectedValue(rpcError('CONNECTION_CLOSED', 'Connection closed'));

    const { error } = await settle(rpcCall(rpcRef, fn, { maxRetries: 2 }));

    expect((error as { code?: string }).code).toBe('CONNECTION_CLOSED');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry a missing responder on a settled link', async () => {
    const rpcRef = shallowRef<RPCClient | undefined>(fakeClient());
    const fn = vi.fn().mockRejectedValue(noResponders());

    const { error } = await settle(rpcCall(rpcRef, fn));

    expect((error as Error).name).toBe('NoResponders');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a missing responder right after the link came back', async () => {
    const rpcRef = shallowRef<RPCClient | undefined>(fakeClient());
    markLinkRestored(rpcRef);
    const fn = vi.fn().mockRejectedValueOnce(noResponders()).mockRejectedValueOnce(noResponders()).mockResolvedValueOnce('ok');

    const { value } = await settle(rpcCall(rpcRef, fn));

    expect(value).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('stops retrying a missing responder once the link has settled', async () => {
    const rpcRef = shallowRef<RPCClient | undefined>(fakeClient());
    markLinkRestored(rpcRef);
    await vi.advanceTimersByTimeAsync(30_000);
    const fn = vi.fn().mockRejectedValue(noResponders());

    await settle(rpcCall(rpcRef, fn));

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry a relayed no-responder error after the link came back', async () => {
    const rpcRef = shallowRef<RPCClient | undefined>(fakeClient());
    markLinkRestored(rpcRef);
    const fn = vi.fn().mockRejectedValue(Object.assign(rpcError('INTERNAL_ERROR', "no responders: 'rpc.plugin.x.streamUrl'"), { name: 'NoResponders' }));

    await settle(rpcCall(rpcRef, fn));

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('keeps a custom shouldRetry in charge', async () => {
    const rpcRef = shallowRef<RPCClient | undefined>(fakeClient());
    const shouldRetry = vi.fn((_err: unknown, attempt: number) => attempt < 1);
    const fn = vi.fn().mockRejectedValue(rpcError('INTERNAL_ERROR', 'boom'));

    await settle(rpcCall(rpcRef, fn, { shouldRetry }));

    expect(fn).toHaveBeenCalledTimes(2);
    expect(shouldRetry).toHaveBeenCalledTimes(2);
  });
});

describe('rpcCall link wait', () => {
  it('waits for the link and calls once it is back', async () => {
    const rpcRef = shallowRef<RPCClient | undefined>(undefined);
    const fn = vi.fn().mockResolvedValue('ok');
    setTimeout(() => (rpcRef.value = fakeClient()), 2_000);

    const { value } = await settle(rpcCall(rpcRef, fn));

    expect(value).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('gives up when the link stays down past the connect timeout', async () => {
    const rpcRef = shallowRef<RPCClient | undefined>(undefined);
    const fn = vi.fn();

    const { error } = await settle(rpcCall(rpcRef, fn, { connectTimeoutMs: 5_000 }));

    expect((error as Error).message).toBe('rpc: connect timeout');
    expect(fn).not.toHaveBeenCalled();
  });

  it('fails at once without a link when told not to wait', async () => {
    const rpcRef = shallowRef<RPCClient | undefined>(undefined);
    const fn = vi.fn();

    const { error } = await settle(rpcCall(rpcRef, fn, { awaitConnect: false }));

    expect((error as Error).message).toBe('rpc: not connected');
    expect(fn).not.toHaveBeenCalled();
  });

  it('keeps waiting after the scope that started the call has ended', async () => {
    const rpcRef = shallowRef<RPCClient | undefined>(undefined);
    const fn = vi.fn().mockResolvedValue('ok');
    const scope = effectScope();
    const call = scope.run(() => rpcCall(rpcRef, fn))!;
    scope.stop();

    rpcRef.value = fakeClient();
    await vi.advanceTimersByTimeAsync(10);

    expect(fn).toHaveBeenCalledTimes(1);
    expect((await settle(call)).value).toBe('ok');
  });

  it('still sees a link drop after the scope that started the call has ended', async () => {
    const client = fakeClient();
    const rpcRef = shallowRef<RPCClient | undefined>(client);
    let fail!: (err: Error) => void;
    const fn = vi
      .fn()
      .mockImplementationOnce(() => new Promise((_resolve, reject) => (fail = reject)))
      .mockResolvedValueOnce('ok');
    const scope = effectScope();
    const call = scope.run(() => rpcCall(rpcRef, fn))!;
    scope.stop();

    rpcRef.value = undefined;
    rpcRef.value = client;
    fail(rpcError('TIMEOUT', 'timed out'));

    expect((await settle(call)).value).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('stops waiting when aborted', async () => {
    const rpcRef = shallowRef<RPCClient | undefined>(undefined);
    const ctrl = new AbortController();
    const fn = vi.fn();
    const call = rpcCall(rpcRef, fn, { signal: ctrl.signal });
    ctrl.abort();

    const { error } = await settle(call);
    rpcRef.value = fakeClient();
    await vi.advanceTimersByTimeAsync(10);

    expect((error as Error).name).toBe('AbortError');
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('useRpcSubscription', () => {
  function subscriber() {
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(async (_rpc: RPCClient) => unsubscribe);
    return { subscribe, unsubscribe };
  }

  it('keeps the subscription across a short drop of the same client', async () => {
    const client = fakeClient();
    const rpc = shallowRef<RPCClient | undefined>(client);
    const { subscribe, unsubscribe } = subscriber();
    const { result, stop } = inContext(rpc, ref(true), () => useRpcSubscription(subscribe));
    await vi.advanceTimersByTimeAsync(0);

    rpc.value = undefined;
    await vi.advanceTimersByTimeAsync(1_500);
    rpc.value = client;
    await vi.advanceTimersByTimeAsync(0);

    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(unsubscribe).not.toHaveBeenCalled();
    expect(result.isActive.value).toBe(true);
    stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('moves the subscription to a new client', async () => {
    const first = fakeClient();
    const second = fakeClient();
    const rpc = shallowRef<RPCClient | undefined>(first);
    const { subscribe, unsubscribe } = subscriber();
    const { stop } = inContext(rpc, ref(true), () => useRpcSubscription(subscribe));
    await vi.advanceTimersByTimeAsync(0);

    rpc.value = undefined;
    await vi.advanceTimersByTimeAsync(0);
    rpc.value = second;
    await vi.advanceTimersByTimeAsync(0);

    expect(subscribe.mock.calls.map(([client]) => client)).toEqual([first, second]);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    stop();
  });

  it('drops the subscription once the connection counts as lost and binds again when it is back', async () => {
    const client = fakeClient();
    const rpc = shallowRef<RPCClient | undefined>(client);
    const isConnected = ref(true);
    const { subscribe, unsubscribe } = subscriber();
    const { result, stop } = inContext(rpc, isConnected, () => useRpcSubscription(subscribe));
    await vi.advanceTimersByTimeAsync(0);

    rpc.value = undefined;
    isConnected.value = false;
    await vi.advanceTimersByTimeAsync(0);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(result.isActive.value).toBe(false);

    rpc.value = client;
    isConnected.value = true;
    await vi.advanceTimersByTimeAsync(0);

    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(result.isActive.value).toBe(true);
    stop();
  });

  it.each([
    ['the connection counts as lost', false],
    ['the scope ended', true],
  ])('undoes a subscribe that lands after %s', async (_name, endScope) => {
    const client = fakeClient();
    const rpc = shallowRef<RPCClient | undefined>(client);
    const isConnected = ref(true);
    const unsubscribe = vi.fn();
    let land!: () => void;
    const subscribe = vi.fn((_rpc: RPCClient) => new Promise<() => void>((resolve) => (land = () => resolve(unsubscribe))));
    const { result, stop } = inContext(rpc, isConnected, () => useRpcSubscription(subscribe));
    await vi.advanceTimersByTimeAsync(0);

    if (endScope) stop();
    else isConnected.value = false;
    await vi.advanceTimersByTimeAsync(0);
    land();
    await vi.advanceTimersByTimeAsync(0);

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(result.isActive.value).toBe(false);
    stop();
  });

  it('gives up on a failing subscribe until the client comes back', async () => {
    const client = fakeClient();
    const rpc = shallowRef<RPCClient | undefined>(client);
    const onError = vi.fn();
    const subscribe = vi.fn(async (_rpc: RPCClient): Promise<() => void> => {
      throw new Error('denied');
    });
    const { result, stop } = inContext(rpc, ref(true), () => useRpcSubscription(subscribe, { maxRetries: 1, onError }));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(result.isActive.value).toBe(false);

    subscribe.mockResolvedValueOnce(() => {});
    rpc.value = undefined;
    await vi.advanceTimersByTimeAsync(0);
    rpc.value = client;
    await vi.advanceTimersByTimeAsync(0);

    expect(subscribe).toHaveBeenCalledTimes(3);
    expect(result.isActive.value).toBe(true);
    stop();
  });
});
