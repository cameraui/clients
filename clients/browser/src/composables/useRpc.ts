import { tryOnScopeDispose } from '@vueuse/core';
import { effectScope, ref, shallowRef, watch } from 'vue';

import { useCameraUi } from './useCameraUi.js';

import type { RPCClient } from '@camera.ui/rpc';
import type { Ref, ShallowRef, WatchOptions, WatchSource } from 'vue';

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const LINK_SETTLE_MS = 30_000;
const LOCAL_NOT_CONNECTED = new Set(['Not connected', 'rpc: not connected']);

const linkRestoredAt = new WeakMap<object, number>();

export interface RpcCallOptions {
  maxRetries?: number;
  awaitConnect?: boolean;
  connectTimeoutMs?: number;
  retryDelayMs?: (attempt: number) => number;
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  retryOnTimeout?: boolean;
  signal?: AbortSignal;
}

export interface UseRpcCallOptions extends RpcCallOptions {
  immediate?: boolean;
  watch?: WatchSource[];
  refetchOnReconnect?: boolean;
}

export interface UseRpcCallReturn<T> {
  readonly data: ShallowRef<T | undefined>;
  readonly loading: Ref<boolean>;
  readonly error: Ref<Error | undefined>;
  execute(): Promise<T | undefined>;
  refresh(): Promise<T | undefined>;
}

export interface UseRpcSubscriptionOptions {
  onError?: (err: unknown) => void;
  maxRetries?: number;
  retryDelayMs?: (attempt: number) => number;
}

export interface UseRpcSubscriptionReturn {
  readonly isActive: Ref<boolean>;
  resubscribe(): Promise<void>;
}

export function markLinkRestored(rpcRef: Readonly<ShallowRef<RPCClient | undefined>>): void {
  linkRestoredAt.set(rpcRef, Date.now());
}

export function isLinkSettling(rpcRef: Readonly<ShallowRef<RPCClient | undefined>>): boolean {
  return Date.now() - (linkRestoredAt.get(rpcRef) ?? -Infinity) < LINK_SETTLE_MS;
}

export function isLocalNoResponders(err: unknown): boolean {
  return err instanceof Error && (err as { code?: unknown }).code === undefined && err.name === 'NoResponders';
}

export async function rpcCall<T>(rpcRef: Readonly<ShallowRef<RPCClient | undefined>>, fn: (rpc: RPCClient) => Promise<T>, options: RpcCallOptions = {}): Promise<T> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const awaitConnect = options.awaitConnect ?? true;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? defaultRetryDelayMs;
  const shouldRetry = options.shouldRetry;
  const retryOnTimeout = options.retryOnTimeout ?? false;
  const signal = options.signal;

  // the transport swaps the client to undefined while the link is down, even when the same client comes back
  let linkChanges = 0;
  const stopLinkWatch = watchDetached(rpcRef, () => linkChanges++, { flush: 'sync' });

  let lastError: unknown;
  try {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (signal?.aborted) throw makeAbortError();

      let rpc = rpcRef.value;
      if (!rpc) {
        if (!awaitConnect) throw new Error('rpc: not connected');
        rpc = await waitForRpc(rpcRef, connectTimeoutMs, signal);
      }

      const changesAtStart = linkChanges;
      try {
        return await fn(rpc);
      } catch (err) {
        lastError = err;
        if (attempt >= maxRetries) throw err;
        const retry = shouldRetry ? shouldRetry(err, attempt) : isLinkFailure(err, rpc, rpcRef, linkChanges !== changesAtStart, retryOnTimeout);
        if (!retry) throw err;
        await sleep(retryDelayMs(attempt), signal);
      }
    }
  } finally {
    stopLinkWatch();
  }
  throw lastError ?? new Error('rpc: max retries exceeded');
}

export function useRpcCall<T>(fn: (rpc: RPCClient) => Promise<T>, options: UseRpcCallOptions = {}): UseRpcCallReturn<T> {
  const ctx = useCameraUi();
  const data = shallowRef<T | undefined>();
  const loading = ref(false);
  const error = ref<Error | undefined>();

  let abortCtrl: AbortController | undefined;

  async function execute(): Promise<T | undefined> {
    abortCtrl?.abort();
    abortCtrl = new AbortController();
    const localCtrl = abortCtrl;

    loading.value = true;
    error.value = undefined;

    try {
      const result = await rpcCall(ctx.rpc, fn, { ...options, signal: localCtrl.signal });
      if (localCtrl.signal.aborted) return undefined;
      data.value = result;
      return result;
    } catch (err) {
      if (localCtrl.signal.aborted) return undefined;
      error.value = err instanceof Error ? err : new Error(String(err));
      return undefined;
    } finally {
      if (!localCtrl.signal.aborted) {
        loading.value = false;
      }
    }
  }

  if (options.immediate) {
    execute();
  }

  if (options.watch?.length) {
    watch(options.watch, () => {
      execute();
    });
  }

  if (options.refetchOnReconnect !== false) {
    const handleReconnected = (): void => {
      execute();
    };
    ctx.on('reconnected', handleReconnected);
    tryOnScopeDispose(() => ctx.off('reconnected', handleReconnected));
  }

  tryOnScopeDispose(() => abortCtrl?.abort());

  return { data, loading, error, execute, refresh: execute };
}

export function useRpcSubscription(subscribeFn: (rpc: RPCClient) => Promise<() => void>, options: UseRpcSubscriptionOptions = {}): UseRpcSubscriptionReturn {
  const ctx = useCameraUi();
  const isActive = ref(false);

  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? defaultRetryDelayMs;

  let unsubscribe: (() => void) | undefined;
  // the nats lib carries a subscription across a drop of the same client
  let boundClient: RPCClient | undefined;
  let pending = false;
  let disposed = false;

  async function bind(rpc: RPCClient): Promise<void> {
    if (pending || disposed) return;
    pending = true;
    boundClient = rpc;
    try {
      if (unsubscribe) {
        try {
          unsubscribe();
        } catch {
          // expected once the client was rebuilt
        }
        unsubscribe = undefined;
      }
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (disposed || boundClient !== rpc) return;
        try {
          const off = await subscribeFn(rpc);
          if (disposed || boundClient !== rpc) {
            off();
            return;
          }
          unsubscribe = off;
          isActive.value = true;
          return;
        } catch (err) {
          if (attempt >= maxRetries) {
            isActive.value = false;
            options.onError?.(err);
            return;
          }
          await sleep(retryDelayMs(attempt));
        }
      }
    } finally {
      pending = false;
      // a client that arrived while this bind was in flight had its bind dropped by the pending guard
      const current = ctx.rpc.value;
      if (!disposed && ctx.isConnected.value && current && current !== boundClient) {
        bind(current);
      }
    }
  }

  function unbind(): void {
    boundClient = undefined;
    if (unsubscribe) {
      try {
        unsubscribe();
      } catch {
        // ignore
      }
      unsubscribe = undefined;
    }
    isActive.value = false;
  }

  async function resubscribe(): Promise<void> {
    const rpc = ctx.rpc.value;
    if (rpc) await bind(rpc);
  }

  if (ctx.rpc.value) {
    bind(ctx.rpc.value);
  }

  const stopWatch = watch([ctx.rpc, ctx.isConnected], ([rpc, connected]) => {
    if (!connected) {
      unbind();
    } else if (rpc && (rpc !== boundClient || !isActive.value)) {
      bind(rpc);
    }
  });

  tryOnScopeDispose(() => {
    disposed = true;
    stopWatch();
    unbind();
  });

  return { isActive, resubscribe };
}

function defaultRetryDelayMs(attempt: number): number {
  return Math.min(100 * Math.pow(2, attempt), 1_000);
}

function isLinkFailure(err: unknown, rpc: RPCClient, rpcRef: Readonly<ShallowRef<RPCClient | undefined>>, linkChanged: boolean, retryOnTimeout: boolean): boolean {
  if (rpcRef.value !== rpc) return true;
  // closed without suspend or disconnect: the next call dials again
  if (rpc.isConnected === false && rpc.isClosed === false) return true;
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (code === undefined && LOCAL_NOT_CONNECTED.has(err.message)) return true;
  // this client's own no-responder error: the handler never ran, so a retry repeats nothing
  if (isLocalNoResponders(err) && isLinkSettling(rpcRef)) return true;
  // a reply lost while the link blipped surfaces as TIMEOUT
  return code === 'TIMEOUT' && (retryOnTimeout || linkChanged);
}

export function watchDetached<T>(source: Readonly<ShallowRef<T>>, cb: (value: T) => void, options?: WatchOptions): () => void {
  const scope = effectScope(true);
  scope.run(() => watch(source, cb, options));
  return () => scope.stop();
}

async function waitForRpc(rpcRef: Readonly<ShallowRef<RPCClient | undefined>>, timeoutMs: number, signal?: AbortSignal): Promise<RPCClient> {
  if (rpcRef.value) return rpcRef.value;
  return new Promise<RPCClient>((resolve, reject) => {
    const timer = setTimeout(() => {
      stopWatch();
      signal?.removeEventListener('abort', onAbort);
      reject(new Error('rpc: connect timeout'));
    }, timeoutMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      stopWatch();
      reject(makeAbortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const stopWatch = watchDetached(rpcRef, (next) => {
      if (next) {
        clearTimeout(timer);
        stopWatch();
        signal?.removeEventListener('abort', onAbort);
        resolve(next);
      }
    });
  });
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(makeAbortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(makeAbortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function makeAbortError(): Error {
  if (typeof DOMException !== 'undefined') {
    return new DOMException('Aborted', 'AbortError');
  }
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}
