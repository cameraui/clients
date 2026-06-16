import axios, { AxiosError, AxiosHeaders, CanceledError } from 'axios';
import { describe, expect, it, vi } from 'vitest';

import {
  applyNativeHttp,
  buildFullUrl,
  createNativeHttpAdapter,
  isAbsoluteURL,
  isPublicFqdnUrl,
  mapResponseType,
  normalizeBody,
  shouldUseNativeHttp,
} from '../nativeHttp.js';

import type { InternalAxiosRequestConfig } from 'axios';
import type { NativeHttpRequest, NativeHttpResult } from '../nativeHttp.js';

function cfg(o: Partial<InternalAxiosRequestConfig> = {}): InternalAxiosRequestConfig {
  // axios always populates validateStatus from its defaults; mirror that so the
  // adapter's settle behaviour matches real usage.
  return { validateStatus: (s: number) => s >= 200 && s < 300, ...o, headers: AxiosHeaders.from((o.headers as AxiosHeaders) ?? {}) } as InternalAxiosRequestConfig;
}

describe('isAbsoluteURL', () => {
  it('detects scheme and protocol-relative URLs', () => {
    expect(isAbsoluteURL('https://x.dev')).toBe(true);
    expect(isAbsoluteURL('//x.dev')).toBe(true);
    expect(isAbsoluteURL('/instances')).toBe(false);
    expect(isAbsoluteURL('instances')).toBe(false);
  });
});

describe('buildFullUrl', () => {
  it('concatenates baseURL + relative path, keeping the base path (the /api bug)', () => {
    expect(buildFullUrl(cfg({ baseURL: 'https://nvr.seydx.dev/api', url: '/instances' }))).toBe('https://nvr.seydx.dev/api/instances');
  });

  it('collapses duplicate slashes between base and path', () => {
    expect(buildFullUrl(cfg({ baseURL: 'https://nvr.seydx.dev/api/', url: '/instances' }))).toBe('https://nvr.seydx.dev/api/instances');
  });

  it('ignores baseURL for an absolute url', () => {
    expect(buildFullUrl(cfg({ baseURL: 'https://nvr.seydx.dev/api', url: 'https://other.dev/x' }))).toBe('https://other.dev/x');
  });

  it('returns the url unchanged when there is no baseURL', () => {
    expect(buildFullUrl(cfg({ url: 'https://nvr.seydx.dev/api/auth/check' }))).toBe('https://nvr.seydx.dev/api/auth/check');
  });
});

describe('isPublicFqdnUrl', () => {
  it('accepts public FQDN hosts', () => {
    expect(isPublicFqdnUrl('https://nvr.seydx.dev/api')).toBe(true);
    expect(isPublicFqdnUrl('https://proxy-service.seydx.dev')).toBe(true);
  });

  it('rejects IP literals, loopback and .local (self-signed LAN)', () => {
    expect(isPublicFqdnUrl('https://192.168.178.27:3443')).toBe(false);
    expect(isPublicFqdnUrl('https://[2003:f6:4f14::2010]:3443')).toBe(false);
    expect(isPublicFqdnUrl('https://localhost:3000')).toBe(false);
    expect(isPublicFqdnUrl('https://nvr.local')).toBe(false);
    expect(isPublicFqdnUrl('not a url')).toBe(false);
  });
});

describe('shouldUseNativeHttp', () => {
  it('is true only for public-FQDN, non-cookie requests', () => {
    expect(shouldUseNativeHttp(cfg({ baseURL: 'https://nvr.seydx.dev/api', url: '/instances' }))).toBe(true);
    expect(shouldUseNativeHttp(cfg({ baseURL: 'https://nvr.seydx.dev/api', url: '/instances', withCredentials: true }))).toBe(false);
    expect(shouldUseNativeHttp(cfg({ baseURL: 'https://192.168.178.27:3443', url: '/instances' }))).toBe(false);
  });
});

describe('mapResponseType', () => {
  it('maps JSON/text/undefined to text and keeps binary native', () => {
    expect(mapResponseType(undefined)).toBe('text');
    expect(mapResponseType('json')).toBe('text');
    expect(mapResponseType('text')).toBe('text');
    expect(mapResponseType('blob')).toBe('blob');
    expect(mapResponseType('arraybuffer')).toBe('arraybuffer');
  });
});

describe('normalizeBody', () => {
  it('parses an axios-stringified JSON body back to an object', () => {
    const body = normalizeBody(cfg({ data: '{"a":1}', headers: AxiosHeaders.from({ 'Content-Type': 'application/json' }) }));
    expect(body).toEqual({ a: 1 });
  });

  it('passes through objects, undefined and non-JSON strings', () => {
    expect(normalizeBody(cfg({ data: { a: 1 }, headers: AxiosHeaders.from({ 'Content-Type': 'application/json' }) }))).toEqual({ a: 1 });
    expect(normalizeBody(cfg({ data: undefined }))).toBeUndefined();
    expect(normalizeBody(cfg({ data: 'not-json', headers: AxiosHeaders.from({ 'Content-Type': 'application/json' }) }))).toBe('not-json');
    expect(normalizeBody(cfg({ data: 'raw=1', headers: AxiosHeaders.from({ 'Content-Type': 'text/plain' }) }))).toBe('raw=1');
  });
});

describe('createNativeHttpAdapter', () => {
  function ok(data: unknown, status = 200, headers: Record<string, string> = {}): NativeHttpResult {
    return { data, status, headers };
  }

  it('returns an AxiosResponse and builds the full URL with the /api prefix', async () => {
    const request = vi.fn<NativeHttpRequest>(async () => ok({ instances: [], homeId: 'h' }));
    const adapter = createNativeHttpAdapter({ request });

    const res = await adapter(cfg({ baseURL: 'https://nvr.seydx.dev/api', url: '/instances', method: 'get' }));

    expect(request.mock.calls[0]![0].url).toBe('https://nvr.seydx.dev/api/instances');
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ instances: [], homeId: 'h' });
  });

  it('applies extraHeaders (Accept-Encoding: identity) and normalizes params + body', async () => {
    const request = vi.fn<NativeHttpRequest>(async () => ok({}, 200));
    const adapter = createNativeHttpAdapter({ request, extraHeaders: { 'Accept-Encoding': 'identity' } });

    await adapter(
      cfg({
        baseURL: 'https://nvr.seydx.dev/api',
        url: '/cameras',
        method: 'post',
        params: { page: 1, pageSize: -1 },
        data: '{"name":"cam"}',
        headers: AxiosHeaders.from({ 'Content-Type': 'application/json' }),
      }),
    );

    const init = request.mock.calls[0]![0];
    expect(init.headers['Accept-Encoding']).toBe('identity');
    expect(init.params).toEqual({ page: '1', pageSize: '-1' });
    expect(init.data).toEqual({ name: 'cam' });
  });

  it('throws an AxiosError with a response for non-2xx status', async () => {
    const request = vi.fn<NativeHttpRequest>(async () => ok({ message: 'nope' }, 401));
    const adapter = createNativeHttpAdapter({ request });

    await expect(adapter(cfg({ url: 'https://nvr.seydx.dev/api/x' }))).rejects.toMatchObject({
      name: 'AxiosError',
      response: { status: 401, data: { message: 'nope' } },
    });
  });

  it('maps a native transport failure to a network AxiosError with no response', async () => {
    const request = vi.fn<NativeHttpRequest>(async () => {
      throw new Error('boom');
    });
    const adapter = createNativeHttpAdapter({ request });

    try {
      await adapter(cfg({ url: 'https://nvr.seydx.dev/api/x' }));
      throw new Error('should have thrown');
    } catch (err) {
      expect(axios.isAxiosError(err)).toBe(true);
      expect((err as AxiosError).code).toBe(AxiosError.ERR_NETWORK);
      expect((err as AxiosError).response).toBeUndefined();
    }
  });

  it('rejects with CanceledError when the signal is already aborted', async () => {
    const request = vi.fn<NativeHttpRequest>(async () => ok({}, 200));
    const adapter = createNativeHttpAdapter({ request });
    const controller = new AbortController();
    controller.abort();

    await expect(adapter(cfg({ url: 'https://nvr.seydx.dev/api/x', signal: controller.signal }))).rejects.toBeInstanceOf(CanceledError);
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects with CanceledError when aborted mid-flight', async () => {
    const request: NativeHttpRequest = () => new Promise<NativeHttpResult>(() => {});
    const adapter = createNativeHttpAdapter({ request });
    const controller = new AbortController();

    const p = adapter(cfg({ url: 'https://nvr.seydx.dev/api/x', signal: controller.signal }));
    controller.abort();

    await expect(p).rejects.toBeInstanceOf(CanceledError);
  });
});

describe('applyNativeHttp', () => {
  it('is a no-op when disabled', () => {
    const fallback = vi.fn();
    const client = axios.create();
    client.defaults.adapter = fallback;

    applyNativeHttp(client, { enabled: false, request: vi.fn() });

    expect(client.defaults.adapter).toBe(fallback);
  });

  it('routes public-FQDN requests native and leaves LAN/IP on the fallback', async () => {
    const native = vi.fn<NativeHttpRequest>(async () => ({ data: '{}', status: 200, headers: {} }));
    const fallback = vi.fn(async (config: InternalAxiosRequestConfig) => ({
      data: 'fallback',
      status: 200,
      statusText: '',
      headers: new AxiosHeaders(),
      config,
      request: null,
    }));

    const client = axios.create();
    client.defaults.adapter = fallback;
    applyNativeHttp(client, { enabled: true, request: native });

    await client.get('https://nvr.seydx.dev/api/instances');
    expect(native).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();

    native.mockClear();
    fallback.mockClear();

    await client.get('https://192.168.178.27:3443/api/instances');
    expect(native).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledTimes(1);
  });
});
