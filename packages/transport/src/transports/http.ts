import axios from 'axios';

import { isEndpointChange, isSameTarget, TransportEmitter } from './contract.js';

import type { AxiosError, AxiosInstance, AxiosRequestConfig, GenericAbortSignal, InternalAxiosRequestConfig } from 'axios';
import type { ConnectionTarget, TransportSpec, TransportStatus } from '../core/types.js';
import type { Transport, TransportEvent, TransportEventHandler, Unsubscribe } from './contract.js';

const HTTP_SPEC: TransportSpec = {
  id: 'http',
  kind: 'request',
  phaseGating: false,
};

export interface HttpTransportOptions {
  readonly apiPrefix?: string;
  readonly timeoutMs?: number;
  readonly targetWaitMs?: number;
  readonly spec?: Partial<TransportSpec>;
}

interface TargetWaiter {
  resolve: () => void;
  reject: (reason: unknown) => void;
}

export interface HttpTransport extends Transport {
  readonly client: AxiosInstance;
}

export function createHttpTransport(options: HttpTransportOptions = {}): HttpTransport {
  const spec: TransportSpec = { ...HTTP_SPEC, ...options.spec };
  const apiPrefix = options.apiPrefix ?? '/api';
  const targetWaitMs = options.targetWaitMs ?? 15_000;
  const emitter = new TransportEmitter();

  let currentTarget: ConnectionTarget | null = null;
  let status: TransportStatus = { up: false };
  let disposed = false;
  const targetWaiters = new Set<TargetWaiter>();

  const client = axios.create({
    timeout: options.timeoutMs ?? 30_000,
  });

  function waitForTarget(signal?: GenericAbortSignal): Promise<void> {
    if (currentTarget) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const waiter: TargetWaiter = {
        resolve: () => {
          cleanup();
          resolve();
        },
        reject: (reason) => {
          cleanup();
          reject(reason);
        },
      };
      const timer = setTimeout(() => waiter.reject(new axios.Cancel('http-transport: no target')), targetWaitMs);
      const onAbort = (): void => waiter.reject(new axios.Cancel('http-transport: aborted'));
      function cleanup(): void {
        clearTimeout(timer);
        targetWaiters.delete(waiter);
        signal?.removeEventListener?.('abort', onAbort);
      }
      if (signal?.aborted) {
        waiter.reject(new axios.Cancel('http-transport: aborted'));
        return;
      }
      signal?.addEventListener?.('abort', onAbort);
      targetWaiters.add(waiter);
    });
  }

  function flushTargetWaiters(): void {
    if (!currentTarget) return;
    for (const waiter of [...targetWaiters]) waiter.resolve();
  }

  client.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
    if (!currentTarget) {
      await waitForTarget(config.signal);
    }
    const target = currentTarget;
    if (!target) {
      throw new axios.Cancel('http-transport: no target');
    }
    if (!config.baseURL) {
      config.baseURL = `${target.endpoint.url}${apiPrefix}`;
    }
    config.headers.set('Authorization', `Bearer ${target.tokens.access}`);
    if (target.tokens.proxySession) {
      config.headers.set('X-Proxy-Session', target.tokens.proxySession);
    }
    return config;
  });

  client.interceptors.response.use(
    (response) => {
      if (!status.up) {
        status = { up: true };
        emitter.emit('up', undefined);
      }
      return response;
    },
    (error: AxiosError) => {
      if (axios.isCancel(error)) return Promise.reject(error);
      if (!error.response) {
        markDown(error.message ?? 'network');
        return Promise.reject(error);
      }
      if (error.response.status === 401) {
        emitter.emit('auth-error', { status: 401, message: extractMessage(error) });
      }
      return Promise.reject(error);
    },
  );

  function markDown(reason: string): void {
    if (status.up || status.lastError !== reason) {
      status = { up: false, lastError: reason };
      emitter.emit('down', { reason });
    }
  }

  async function apply(target: ConnectionTarget | null): Promise<void> {
    if (disposed) throw new Error('http-transport disposed');
    if (isSameTarget(currentTarget, target)) return;

    const endpointChanged = isEndpointChange(currentTarget, target);
    currentTarget = target;

    if (!target) {
      status = { up: false };
      emitter.emit('down', { reason: 'detached' });
      return;
    }

    if (endpointChanged) {
      status = { up: false };
    }

    flushTargetWaiters();
  }

  function health(): TransportStatus {
    return status;
  }

  function on<E extends TransportEvent>(event: E, handler: TransportEventHandler<E>): Unsubscribe {
    return emitter.on(event, handler);
  }

  async function dispose(): Promise<void> {
    disposed = true;
    currentTarget = null;
    status = { up: false };
    for (const waiter of [...targetWaiters]) waiter.reject(new axios.Cancel('http-transport: disposed'));
    emitter.clear();
  }

  return { spec, client, apply, health, on, dispose };
}

function extractMessage(error: AxiosError): string | undefined {
  const data = error.response?.data;
  if (data && typeof data === 'object' && 'message' in data && typeof data.message === 'string') {
    return data.message;
  }
  return error.message;
}

export type { AxiosInstance, AxiosRequestConfig };
