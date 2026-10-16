import axios from 'axios';

import { isEndpointChange, isSameTarget, TransportEmitter } from './contract.js';

import type { Logger } from '@camera.ui/logger';
import type { AxiosError, AxiosInstance, AxiosRequestConfig, GenericAbortSignal, InternalAxiosRequestConfig } from 'axios';
import type { ConnectionTarget, TransportSpec, TransportStatus } from '../core/types.js';
import type { Transport, TransportEvent, TransportEventHandler, Unsubscribe } from './contract.js';

const HTTP_SPEC: TransportSpec = {
  id: 'http',
  kind: 'request',
  phaseGating: false,
};

const TOKEN_REJECTED_MESSAGES = new Set(['Unauthorized', 'Token expired', 'Token revoked']);

export type HttpAuthorizer = (config: InternalAxiosRequestConfig, target: ConnectionTarget) => void | Promise<void>;

export interface HttpTransportOptions {
  readonly apiPrefix?: string;
  readonly timeoutMs?: number;
  readonly targetWaitMs?: number;
  readonly authRetryWaitMs?: number;
  readonly spec?: Partial<TransportSpec>;
  readonly authorize?: HttpAuthorizer;
  readonly logger?: Logger;
}

interface TargetWaiter {
  resolve: () => void;
  reject: (reason: unknown) => void;
}

interface AccessWaiter {
  staleAccess: string;
  resolve: (fresh: boolean) => void;
  reject: (reason: unknown) => void;
}

interface AuthRetryConfig extends InternalAxiosRequestConfig {
  _sentAccess?: string;
  _authRetried?: boolean;
}

export interface HttpTransport extends Transport {
  readonly client: AxiosInstance;
}

export function createHttpTransport(options: HttpTransportOptions = {}): HttpTransport {
  const spec: TransportSpec = { ...HTTP_SPEC, ...options.spec };
  const apiPrefix = options.apiPrefix ?? '/api';
  const targetWaitMs = options.targetWaitMs ?? 15_000;
  const authRetryWaitMs = options.authRetryWaitMs ?? 10_000;
  const logger = options.logger;

  const emitter = new TransportEmitter();

  let currentTarget: ConnectionTarget | null = null;
  let status: TransportStatus = { up: false };
  let disposed = false;
  const targetWaiters = new Set<TargetWaiter>();
  const accessWaiters = new Set<AccessWaiter>();

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

  function waitForNewAccess(staleAccess: string, signal?: GenericAbortSignal, refresh?: Promise<boolean>): Promise<boolean> {
    if (currentTarget && currentTarget.tokens.access !== staleAccess) return Promise.resolve(true);
    return new Promise<boolean>((resolve, reject) => {
      const waiter: AccessWaiter = {
        staleAccess,
        resolve: (fresh) => {
          cleanup();
          resolve(fresh);
        },
        reject: (reason) => {
          cleanup();
          reject(reason);
        },
      };
      const timer = setTimeout(() => waiter.reject(new Error('http-transport: token refresh timed out')), authRetryWaitMs);
      const onAbort = (): void => waiter.reject(new axios.Cancel('http-transport: aborted'));
      function cleanup(): void {
        clearTimeout(timer);
        accessWaiters.delete(waiter);
        signal?.removeEventListener?.('abort', onAbort);
      }
      if (signal?.aborted) {
        waiter.reject(new axios.Cancel('http-transport: aborted'));
        return;
      }
      signal?.addEventListener?.('abort', onAbort);
      accessWaiters.add(waiter);
      refresh?.then((coming) => {
        if (!coming) waiter.resolve(false);
      });
    });
  }

  function flushAccessWaiters(): void {
    for (const waiter of [...accessWaiters]) {
      if (!currentTarget) {
        waiter.reject(new axios.Cancel('http-transport: no target'));
      } else if (currentTarget.tokens.access !== waiter.staleAccess) {
        waiter.resolve(true);
      }
    }
  }

  client.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
    if (!currentTarget) {
      await waitForTarget(config.signal);
    }
    const target = currentTarget;
    if (!target) {
      throw new axios.Cancel('http-transport: no target');
    }
    (config as AuthRetryConfig)._sentAccess = target.tokens.access;
    if (!config.baseURL) {
      config.baseURL = `${target.endpoint.url}${apiPrefix}`;
    }
    if (options.authorize) {
      await options.authorize(config, target);
    } else {
      config.headers.set('Authorization', `Bearer ${target.tokens.access}`);
    }
    return config;
  });

  client.interceptors.response.use(
    (response) => {
      if (!status.up) {
        status = { up: true };
        logger?.debug('markUp');
        emitter.emit('up', undefined);
      }
      return response;
    },
    async (error: AxiosError) => {
      if (axios.isCancel(error)) return Promise.reject(error);
      if (!error.response) {
        markDown(error.message ?? 'network');
        return Promise.reject(error);
      }
      if (error.response.status === 401) {
        logger?.debug(`auth-error 401 (${error.config?.url ?? 'unknown-url'})`);
        const refreshes: Promise<boolean>[] = [];
        const config = error.config as AuthRetryConfig | undefined;
        const message = extractMessage(error);
        const tokenRejected = !options.authorize && message !== undefined && TOKEN_REJECTED_MESSAGES.has(message);
        emitter.emit('auth-error', {
          status: 401,
          message,
          access: tokenRejected ? config?._sentAccess : undefined,
          holdFor: (refresh) => refreshes.push(refresh),
        });

        if (config?._sentAccess && !config._authRetried && !disposed) {
          config._authRetried = true;
          if (!(await shouldRetryAuth(config._sentAccess, refreshes, config.signal))) {
            return Promise.reject(error);
          }
          logger?.debug(`retry after 401 (${config.url ?? 'unknown-url'})`);
          return client(config);
        }
      }
      return Promise.reject(error);
    },
  );

  async function shouldRetryAuth(sentAccess: string, refreshes: Promise<boolean>[], signal?: GenericAbortSignal): Promise<boolean> {
    // without a refresh to follow, an authorize hook re-reads its credentials on the retry
    if (refreshes.length === 0 && options.authorize) return true;
    const refresh =
      refreshes.length > 0
        ? Promise.all(refreshes).then(
            (results) => results.some(Boolean),
            () => false,
          )
        : undefined;
    try {
      return (await waitForNewAccess(sentAccess, signal, refresh)) || Boolean(options.authorize);
    } catch {
      return false;
    }
  }

  function markDown(reason: string): void {
    if (status.up || status.lastError !== reason) {
      status = { up: false, lastError: reason };
      logger?.debug(`markDown (${reason})`);
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
      flushAccessWaiters();
      return;
    }

    if (endpointChanged) {
      status = { up: false };
    }

    flushTargetWaiters();
    flushAccessWaiters();
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
    for (const waiter of [...accessWaiters]) waiter.reject(new axios.Cancel('http-transport: disposed'));
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
