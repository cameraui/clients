import axios, { AxiosError, AxiosHeaders, CanceledError } from 'axios';

import type { AxiosAdapter, AxiosInstance, AxiosResponse, GenericAbortSignal, InternalAxiosRequestConfig, ResponseType } from 'axios';

export type NativeResponseType = 'text' | 'json' | 'blob' | 'arraybuffer' | 'document';

export interface NativeHttpRequestInit {
  url: string;
  method: string;
  headers: Record<string, string>;
  params?: Record<string, string>;
  data?: unknown;
  responseType: NativeResponseType;
  connectTimeout?: number;
  readTimeout?: number;
}

export interface NativeHttpResult {
  data: unknown;
  status: number;
  headers?: Record<string, string>;
  url?: string;
}

export type NativeHttpRequest = (init: NativeHttpRequestInit) => Promise<NativeHttpResult>;

export interface NativeHttpBinding {
  readonly request: NativeHttpRequest;
  readonly extraHeaders?: Record<string, string>;
}

export function isAbsoluteURL(url: string): boolean {
  return /^([a-z][a-z\d+\-.]*:)?\/\//i.test(url);
}

export function buildFullUrl(config: InternalAxiosRequestConfig): string {
  const url = config.url ?? '';
  const base = config.baseURL ?? '';
  if (base && !isAbsoluteURL(url)) {
    return `${base.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`;
  }
  return url;
}

export function isPublicFqdnUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  if (!host || host === 'localhost' || host.endsWith('.local')) return false;
  if (host.includes(':')) return false; // IPv6 literal (URL.hostname strips brackets)
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return false; // IPv4 literal
  return host.includes('.');
}

export function shouldUseNativeHttp(config: InternalAxiosRequestConfig): boolean {
  return !config.withCredentials && isPublicFqdnUrl(buildFullUrl(config));
}

export function createNativeHttpAdapter(binding: NativeHttpBinding): AxiosAdapter {
  return async (config) => {
    throwIfAborted(config.signal);

    const headers = flattenHeaders(config.headers);
    if (binding.extraHeaders) Object.assign(headers, binding.extraHeaders);

    const timeout = typeof config.timeout === 'number' && config.timeout > 0 ? config.timeout : undefined;

    const pending = binding.request({
      url: buildFullUrl(config),
      method: (config.method ?? 'get').toUpperCase(),
      headers,
      params: normalizeParams(config.params),
      data: normalizeBody(config),
      responseType: mapResponseType(config.responseType),
      connectTimeout: timeout,
      readTimeout: timeout,
    });

    let res: NativeHttpResult;
    try {
      res = await raceAbort(pending, config.signal);
    } catch (err) {
      if (err instanceof CanceledError) throw err;
      // Native transport failure → axios "network error" (no response) so the
      // probe loop classifies it as transient, identical to an XHR network error.
      throw new AxiosError(err instanceof Error ? err.message : 'Network Error', AxiosError.ERR_NETWORK, config, pending);
    }

    const response: AxiosResponse = {
      data: res.data,
      status: res.status,
      statusText: '',
      headers: AxiosHeaders.from(res.headers ?? {}),
      config,
      request: pending,
    };

    if (!config.validateStatus || config.validateStatus(res.status)) {
      return response;
    }
    throw new AxiosError(
      `Request failed with status code ${res.status}`,
      res.status >= 500 ? AxiosError.ERR_BAD_RESPONSE : AxiosError.ERR_BAD_REQUEST,
      config,
      pending,
      response,
    );
  };
}

export function applyNativeHttp(client: AxiosInstance, opts: { enabled: boolean } & NativeHttpBinding): void {
  if (!opts.enabled) return;
  const fallback = axios.getAdapter(client.defaults.adapter ?? axios.defaults.adapter);
  const native = createNativeHttpAdapter(opts);
  client.defaults.adapter = (config) => (shouldUseNativeHttp(config) ? native(config) : fallback(config));
}

function throwIfAborted(signal?: GenericAbortSignal): void {
  if (signal?.aborted) throw new CanceledError('canceled');
}

function raceAbort<T>(pending: Promise<T>, signal?: GenericAbortSignal): Promise<T> {
  if (!signal || typeof signal.addEventListener !== 'function') return pending;
  if (signal.aborted) return Promise.reject(new CanceledError('canceled'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new CanceledError('canceled'));
    signal.addEventListener!('abort', onAbort, { once: true } as never);
    const cleanup = (): void => signal.removeEventListener?.('abort', onAbort);
    pending.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (err: unknown) => {
        cleanup();
        reject(err);
      },
    );
  });
}

function flattenHeaders(headers: InternalAxiosRequestConfig['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  const json = AxiosHeaders.from(headers as AxiosHeaders).toJSON();
  for (const [key, value] of Object.entries(json)) {
    if (value == null) continue;
    out[key] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}

function normalizeParams(params: unknown): Record<string, string> | undefined {
  if (!params || typeof params !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    if (value != null) out[key] = String(value);
  }
  return out;
}

export function normalizeBody(config: InternalAxiosRequestConfig): unknown {
  const data: unknown = config.data;
  // axios keeps an explicit null body (e.g. put(url, null)); the Capacitor
  // bridge turns null into NSNull and iOS fails the request with
  // CapacitorUrlRequestError. undefined drops the key entirely.
  if (data == null) return undefined;
  if (typeof data !== 'string') return data;
  const contentType = String(AxiosHeaders.from(config.headers as AxiosHeaders).get('Content-Type') ?? '');
  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(data);
    } catch {
      // Not actually JSON — send the raw string.
    }
  }
  return data;
}

export function mapResponseType(type?: ResponseType): NativeResponseType {
  switch (type) {
    case 'blob':
      return 'blob';
    case 'arraybuffer':
      return 'arraybuffer';
    default:
      return 'text';
  }
}
