import { tryOnScopeDispose } from '@vueuse/core';
import { ref, shallowRef, watch } from 'vue';

import { useCameraUi } from './useCameraUi.js';

import type { RPCClient } from '@camera.ui/rpc';
import type { Ref, ShallowRef, WatchSource } from 'vue';

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

export interface RpcCallOptions {
  maxRetries?: number;
  awaitConnect?: boolean;
  connectTimeoutMs?: number;
  retryDelayMs?: (attempt: number) => number;
  shouldRetry?: (err: unknown, attempt: number) => boolean;
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

export async function rpcCall<T>(rpcRef: Readonly<ShallowRef<RPCClient | undefined>>, fn: (rpc: RPCClient) => Promise<T>, options: RpcCallOptions = {}): Promise<T> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const awaitConnect = options.awaitConnect ?? true;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? defaultRetryDelayMs;
  const shouldRetry = options.shouldRetry ?? defaultShouldRetry;
  const signal = options.signal;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) throw makeAbortError();

    let rpc = rpcRef.value;
    if (!rpc) {
      if (!awaitConnect) throw new Error('rpc: not connected');
      rpc = await waitForRpc(rpcRef, connectTimeoutMs, signal);
    }

    try {
      return await fn(rpc);
    } catch (err) {
      lastError = err;
      if (attempt >= maxRetries) throw err;
      if (!shouldRetry(err, attempt)) throw err;
      await sleep(retryDelayMs(attempt), signal);
    }
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
  let pending = false;
  let disposed = false;

  async function bind(rpc: RPCClient): Promise<void> {
    if (pending || disposed) return;
    pending = true;
    try {
      if (unsubscribe) {
        try {
          unsubscribe();
        } catch {
          // Old subscription dead — that's expected when the RPCClient has
          // been rebuilt; the unsubscribe handle won't reach anything.
        }
        unsubscribe = undefined;
      }
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (disposed) return;
        try {
          unsubscribe = await subscribeFn(rpc);
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
      // A newer RPCClient may have arrived while this bind was in flight —
      // the watch's bind() call was dropped by the pending guard. Without
      // this rebind the subscription would stay dead until the NEXT
      // reconnect.
      const current = ctx.rpc.value;
      if (!disposed && current && current !== rpc) {
        void bind(current);
      }
    }
  }

  function unbind(): void {
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

  const stopWatch = watch(ctx.rpc, (rpc, prevRpc) => {
    if (rpc && rpc !== prevRpc) {
      bind(rpc);
    } else if (!rpc && prevRpc) {
      unbind();
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

function defaultShouldRetry(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (code === 'TIMEOUT' || code === 'CONNECTION_CLOSED') return true;
  const msg = err.message.toLowerCase();
  if (msg.includes('not connected')) return true;
  if (msg.includes('connection closed')) return true;
  if (msg.includes('no responders')) return true;
  if (msg.includes('connection refused')) return true;
  if (msg.includes('socket')) return true;
  if (msg.includes('timed out') || msg.includes('timeout')) return true;
  return false;
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
    const stopWatch = watch(rpcRef, (next) => {
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
