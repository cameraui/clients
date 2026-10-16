import axios, { AxiosError, AxiosHeaders, CanceledError } from 'axios';

import type { AxiosAdapter, AxiosInstance, AxiosResponse, GenericAbortSignal, InternalAxiosRequestConfig, ResponseType } from 'axios';

export type NativeResponseType = 'text' | 'json' | 'blob' | 'arraybuffer' | 'document';

export interface NativeHttpRequestInit {
  url: string;
  method: string;
  headers: Record<string, string>;
  params?: Record<string, string>;
  data?: unknown;
  dataType?: 'file' | 'formData';
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

interface NativeFormDataEntry {
  key: string;
  value: string;
  type: 'string' | 'base64File';
  fileName?: string;
  contentType?: string;
}

interface NativeBody {
  data: unknown;
  dataType?: 'file' | 'formData';
  contentType?: string;
}

const BASE64_CHUNK = 3 * 8192;

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

export function shouldUseNativeHttp(config: InternalAxiosRequestConfig, exclude?: (url: string) => boolean): boolean {
  if (config.withCredentials) return false;
  const url = buildFullUrl(config);
  return isPublicFqdnUrl(url) && !exclude?.(url);
}

export function createNativeHttpAdapter(binding: NativeHttpBinding): AxiosAdapter {
  return async (config) => {
    throwIfAborted(config.signal);

    const headers = flattenHeaders(config.headers);
    if (binding.extraHeaders) Object.assign(headers, binding.extraHeaders);

    const body = await encodeBody(config, headers);
    throwIfAborted(config.signal);
    if (body.contentType) setContentType(headers, body.contentType);

    const timeout = typeof config.timeout === 'number' && config.timeout > 0 ? config.timeout : undefined;

    const pending = binding.request({
      url: buildFullUrl(config),
      method: (config.method ?? 'get').toUpperCase(),
      headers,
      params: normalizeParams(config.params),
      data: body.data,
      dataType: body.dataType,
      responseType: mapResponseType(config.responseType),
      connectTimeout: timeout,
      readTimeout: timeout,
    });

    let res: NativeHttpResult;
    try {
      res = await raceNative(pending, config, timeout);
    } catch (err) {
      if (err instanceof AxiosError) throw err;
      // Native transport failure → axios "network error" (no response) so the
      // probe loop classifies it as transient, identical to an XHR network error.
      throw new AxiosError(err instanceof Error ? err.message : 'Network Error', AxiosError.ERR_NETWORK, config, pending);
    }

    const responseHeaders = AxiosHeaders.from(res.headers ?? {});
    const response: AxiosResponse = {
      data: decodeBinaryResponse(res.data, config.responseType, String(responseHeaders.get('Content-Type') ?? '')),
      status: res.status,
      statusText: '',
      headers: responseHeaders,
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

export function applyNativeHttp(client: AxiosInstance, opts: { enabled: boolean; exclude?: (url: string) => boolean } & NativeHttpBinding): void {
  if (!opts.enabled) return;
  const fallback = axios.getAdapter(client.defaults.adapter ?? axios.defaults.adapter);
  const native = createNativeHttpAdapter(opts);
  client.defaults.adapter = (config) => (shouldUseNativeHttp(config, opts.exclude) ? native(config) : fallback(config));
}

function throwIfAborted(signal?: GenericAbortSignal): void {
  if (signal?.aborted) throw new CanceledError('canceled');
}

function raceNative<T>(pending: Promise<T>, config: InternalAxiosRequestConfig, timeout: number | undefined): Promise<T> {
  const signal = config.signal;
  const abortable = !!signal && typeof signal.addEventListener === 'function';
  if (!abortable && !timeout) return pending;
  if (signal?.aborted) return Promise.reject(new CanceledError('canceled'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      reject(new CanceledError('canceled'));
    };
    const timer = timeout
      ? setTimeout(() => {
          cleanup();
          reject(timeoutError(config, timeout, pending));
        }, timeout)
      : undefined;
    if (abortable) signal!.addEventListener!('abort', onAbort, { once: true } as never);
    function cleanup(): void {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }
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

function timeoutError(config: InternalAxiosRequestConfig, timeout: number, request: unknown): AxiosError {
  const code = config.transitional?.clarifyTimeoutError ? AxiosError.ETIMEDOUT : AxiosError.ECONNABORTED;
  return new AxiosError(config.timeoutErrorMessage || `timeout of ${timeout}ms exceeded`, code, config, request);
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

async function encodeBody(config: InternalAxiosRequestConfig, headers: Record<string, string>): Promise<NativeBody> {
  const data: unknown = config.data;
  if (data instanceof FormData) {
    return { data: await encodeFormData(data), dataType: 'formData', contentType: 'multipart/form-data' };
  }
  const bytes = await binaryOf(data);
  if (!bytes) return { data: normalizeBody(config) };
  const explicit = headerValue(headers, 'Content-Type');
  // axios defaults every POST/PUT to form-urlencoded, which never describes a binary body
  const contentType = explicit && !explicit.includes('application/x-www-form-urlencoded') ? explicit : (data instanceof Blob && data.type) || 'application/octet-stream';
  return { data: bytesToBase64(bytes), dataType: 'file', contentType };
}

async function encodeFormData(form: FormData): Promise<NativeFormDataEntry[]> {
  const pairs: [string, FormDataEntryValue][] = [];
  form.forEach((value, key) => pairs.push([key, value]));
  const entries: NativeFormDataEntry[] = [];
  for (const [key, value] of pairs) {
    if (typeof value === 'string') {
      entries.push({ key, value, type: 'string' });
      continue;
    }
    entries.push({
      key,
      value: bytesToBase64(new Uint8Array(await value.arrayBuffer())),
      type: 'base64File',
      fileName: value.name || 'blob',
      contentType: value.type || 'application/octet-stream',
    });
  }
  return entries;
}

async function binaryOf(data: unknown): Promise<Uint8Array | null> {
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) return headers[key];
  }
  return undefined;
}

function setContentType(headers: Record<string, string>, value: string): void {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'content-type') delete headers[key];
  }
  headers['Content-Type'] = value;
}

function decodeBinaryResponse(data: unknown, type: ResponseType | undefined, contentType: string): unknown {
  if ((type !== 'arraybuffer' && type !== 'blob') || typeof data !== 'string' || contentType.includes('application/json')) return data;
  if (/[ \t\f]/.test(data)) return data;
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = base64ToBytes(data);
  } catch {
    return data;
  }
  return type === 'blob' ? new Blob([bytes], { type: contentType }) : bytes.buffer;
}

function bytesToBase64(bytes: Uint8Array): string {
  const native = (bytes as { toBase64?: () => string }).toBase64;
  if (typeof native === 'function') return native.call(bytes);
  let out = '';
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    out += btoa(String.fromCharCode.apply(null, bytes.subarray(i, i + BASE64_CHUNK) as unknown as number[]));
  }
  return out;
}

function base64ToBytes(text: string): Uint8Array<ArrayBuffer> {
  const native = (Uint8Array as { fromBase64?: (input: string) => Uint8Array<ArrayBuffer> }).fromBase64;
  if (typeof native === 'function') return native(text);
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
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
