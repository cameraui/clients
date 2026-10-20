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
  // axios always fills validateStatus from its defaults
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

  it('drops an explicit null body (iOS bridges null to NSNull and fails the request)', () => {
    expect(normalizeBody(cfg({ data: null }))).toBeUndefined();
    expect(normalizeBody(cfg({ data: null, headers: AxiosHeaders.from({ 'Content-Type': 'application/json' }) }))).toBeUndefined();
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

  it('rejects with a timeout error when the native call outlives the axios timeout', async () => {
    const request: NativeHttpRequest = () => new Promise<NativeHttpResult>(() => {});
    const adapter = createNativeHttpAdapter({ request });

    const started = Date.now();
    const err = await adapter(cfg({ url: 'https://nvr.seydx.dev/api/hang', timeout: 40 })).catch((e: unknown) => e);

    expect(axios.isAxiosError(err)).toBe(true);
    expect((err as AxiosError).code).toBe(AxiosError.ECONNABORTED);
    expect((err as AxiosError).message).toBe('timeout of 40ms exceeded');
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('createNativeHttpAdapter binary responses', () => {
  const GZIP_HEAD = [0x1f, 0x8b, 0x08, 0x00];

  function base64Of(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('base64');
  }

  it('decodes a base64 arraybuffer body back to the original bytes', async () => {
    const request = vi.fn<NativeHttpRequest>(async () => ({
      data: base64Of(new Uint8Array(GZIP_HEAD)),
      status: 200,
      headers: { 'content-type': 'application/gzip' },
    }));
    const adapter = createNativeHttpAdapter({ request });

    const res = await adapter(cfg({ url: 'https://nvr.seydx.dev/api/backup/download', method: 'post', responseType: 'arraybuffer' }));

    expect(request.mock.calls[0]![0].responseType).toBe('arraybuffer');
    expect(res.data).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(res.data as ArrayBuffer)]).toEqual(GZIP_HEAD);
  });

  it('returns a Blob with the response content type for responseType blob', async () => {
    const request = vi.fn<NativeHttpRequest>(async () => ({
      data: base64Of(new Uint8Array(GZIP_HEAD)),
      status: 200,
      headers: { 'Content-Type': 'application/gzip' },
    }));
    const adapter = createNativeHttpAdapter({ request });

    const res = await adapter(cfg({ url: 'https://nvr.seydx.dev/api/file', responseType: 'blob' }));

    expect(res.data).toBeInstanceOf(Blob);
    expect((res.data as Blob).type).toBe('application/gzip');
    expect([...new Uint8Array(await (res.data as Blob).arrayBuffer())]).toEqual(GZIP_HEAD);
  });

  it('keeps the bytes 1:1 instead of handing over the 4/3 larger base64 text', async () => {
    const original = new Uint8Array(5 * 1024 * 1024);
    for (let i = 0; i < original.length; i++) original[i] = (i * 31 + (i >> 8)) & 0xff;
    const wire = base64Of(original);
    const request = vi.fn<NativeHttpRequest>(async () => ({ data: wire, status: 200, headers: { 'content-type': 'application/gzip' } }));
    const adapter = createNativeHttpAdapter({ request });

    const res = await adapter(cfg({ url: 'https://nvr.seydx.dev/api/backup/download', responseType: 'arraybuffer' }));
    const saved = new Uint8Array(await new Blob([res.data as ArrayBuffer]).arrayBuffer());

    expect(wire.length / original.length).toBeCloseTo(4 / 3, 2);
    expect(saved.byteLength).toBe(original.byteLength);
    expect(Buffer.compare(Buffer.from(saved), Buffer.from(original))).toBe(0);
  });

  it('keeps a plain-text error body that is not base64', async () => {
    const request = vi.fn<NativeHttpRequest>(async () => ({ data: 'Backup failed!', status: 500, headers: { 'content-type': 'text/plain' } }));
    const adapter = createNativeHttpAdapter({ request });

    await expect(adapter(cfg({ url: 'https://nvr.seydx.dev/api/backup/download', responseType: 'arraybuffer' }))).rejects.toMatchObject({
      response: { status: 500, data: 'Backup failed!' },
    });
  });

  it('keeps a plain-text error body made only of base64 letters and spaces', async () => {
    const request = vi.fn<NativeHttpRequest>(async () => ({ data: 'Bad Gateway', status: 502, headers: { 'content-type': 'text/plain' } }));
    const adapter = createNativeHttpAdapter({ request });

    await expect(adapter(cfg({ url: 'https://nvr.seydx.dev/api/backup/download', responseType: 'arraybuffer' }))).rejects.toMatchObject({
      response: { status: 502, data: 'Bad Gateway' },
    });
  });

  it('leaves parsed JSON bodies alone for binary response types', async () => {
    const request = vi.fn<NativeHttpRequest>(async () => ({ data: { message: 'nope' }, status: 403, headers: { 'content-type': 'application/json' } }));
    const adapter = createNativeHttpAdapter({ request });

    await expect(adapter(cfg({ url: 'https://nvr.seydx.dev/api/backup/download', responseType: 'arraybuffer' }))).rejects.toMatchObject({
      response: { status: 403, data: { message: 'nope' } },
    });
  });

  it('does not touch text responses', async () => {
    const request = vi.fn<NativeHttpRequest>(async () => ({ data: 'aGVsbG8=', status: 200, headers: { 'content-type': 'text/plain' } }));
    const adapter = createNativeHttpAdapter({ request });

    const res = await adapter(cfg({ url: 'https://nvr.seydx.dev/api/x' }));

    expect(res.data).toBe('aGVsbG8=');
  });
});

describe('createNativeHttpAdapter binary request bodies', () => {
  function capture() {
    const request = vi.fn<NativeHttpRequest>(async () => ({ data: {}, status: 200, headers: { 'content-type': 'application/json' } }));
    return { request, adapter: createNativeHttpAdapter({ request }) };
  }

  function axiosDefaultHeaders(): AxiosHeaders {
    return AxiosHeaders.from({ Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/x-www-form-urlencoded' });
  }

  it('sends FormData as an entry list with a multipart content type and no boundary', async () => {
    const { request, adapter } = capture();
    const form = new FormData();
    form.append('name', 'front door');
    form.append('file', new Blob([new Uint8Array([0x1f, 0x8b, 0x08, 0x00])], { type: 'application/gzip' }), 'backup.tar.gz');
    form.append('raw', new Blob([new Uint8Array([1, 2, 3])]), 'raw.bin');

    await adapter(cfg({ url: 'https://nvr.seydx.dev/api/backup/restore', method: 'post', data: form, headers: axiosDefaultHeaders() }));

    const init = request.mock.calls[0]![0];
    expect(init.dataType).toBe('formData');
    expect(init.data).toEqual([
      { key: 'name', value: 'front door', type: 'string' },
      { key: 'file', value: 'H4sIAA==', type: 'base64File', fileName: 'backup.tar.gz', contentType: 'application/gzip' },
      { key: 'raw', value: 'AQID', type: 'base64File', fileName: 'raw.bin', contentType: 'application/octet-stream' },
    ]);
    expect(init.headers['Content-Type']).toBe('multipart/form-data');
    expect(Object.keys(init.headers).filter((k) => k.toLowerCase() === 'content-type')).toHaveLength(1);
  });

  it('sends a Blob body as a base64 file with its own type', async () => {
    const { request, adapter } = capture();

    await adapter(
      cfg({
        url: 'https://nvr.seydx.dev/api/users/me/avatar',
        method: 'put',
        data: new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' }),
        headers: axiosDefaultHeaders(),
      }),
    );

    const init = request.mock.calls[0]![0];
    expect(init.dataType).toBe('file');
    expect(init.data).toBe('/9j/');
    expect(init.headers['Content-Type']).toBe('image/jpeg');
  });

  it('sends ArrayBuffer and typed array bodies as octet-stream files', async () => {
    const { request, adapter } = capture();
    const bytes = new Uint8Array([0, 1, 2, 3, 4, 5]);

    await adapter(cfg({ url: 'https://nvr.seydx.dev/api/x', method: 'post', data: bytes.buffer, headers: axiosDefaultHeaders() }));
    await adapter(cfg({ url: 'https://nvr.seydx.dev/api/x', method: 'post', data: bytes.subarray(2, 4) }));

    expect(request.mock.calls[0]![0]).toMatchObject({ dataType: 'file', data: 'AAECAwQF', headers: { 'Content-Type': 'application/octet-stream' } });
    expect(request.mock.calls[1]![0]).toMatchObject({ dataType: 'file', data: 'AgM=', headers: { 'Content-Type': 'application/octet-stream' } });
  });

  it('keeps an explicit content type on a binary body', async () => {
    const { request, adapter } = capture();

    await adapter(
      cfg({ url: 'https://nvr.seydx.dev/api/x', method: 'post', data: new Uint8Array([1]).buffer, headers: AxiosHeaders.from({ 'Content-Type': 'application/x-tar' }) }),
    );

    expect(request.mock.calls[0]![0]).toMatchObject({ dataType: 'file', data: 'AQ==', headers: { 'Content-Type': 'application/x-tar' } });
  });

  it('round-trips a large binary body through base64 without loss', async () => {
    const { request, adapter } = capture();
    const original = new Uint8Array(3 * 1024 * 1024 + 7);
    for (let i = 0; i < original.length; i++) original[i] = (i * 7) & 0xff;

    await adapter(cfg({ url: 'https://nvr.seydx.dev/api/x', method: 'post', data: original.buffer }));

    const init = request.mock.calls[0]![0];
    expect(init.dataType).toBe('file');
    expect(typeof init.data).toBe('string');
    expect(Buffer.compare(Buffer.from(init.data as string, 'base64'), Buffer.from(original))).toBe(0);
  });

  it('leaves JSON and string bodies on the plain path without a dataType', async () => {
    const { request, adapter } = capture();

    await adapter(cfg({ url: 'https://nvr.seydx.dev/api/x', method: 'post', data: '{"a":1}', headers: AxiosHeaders.from({ 'Content-Type': 'application/json' }) }));

    expect(request.mock.calls[0]![0].dataType).toBeUndefined();
    expect(request.mock.calls[0]![0].data).toEqual({ a: 1 });
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

  it('keeps excluded hostnames on the fallback even when they look public', async () => {
    const native = vi.fn<NativeHttpRequest>(async () => ({ data: '{}', status: 200, headers: {} }));
    const fallback = vi.fn(async (config: InternalAxiosRequestConfig) => ({
      data: 'fallback',
      status: 200,
      statusText: '',
      headers: new AxiosHeaders(),
      config,
      request: null,
    }));
    const exclude = vi.fn((url: string) => new URL(url).hostname === 'nas.fritz.box');

    const client = axios.create();
    client.defaults.adapter = fallback;
    applyNativeHttp(client, { enabled: true, request: native, exclude });

    await client.get('https://nas.fritz.box:3443/api/instances');
    expect(native).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(exclude).toHaveBeenCalledWith('https://nas.fritz.box:3443/api/instances');

    await client.get('https://nvr.seydx.dev/api/instances');
    expect(native).toHaveBeenCalledTimes(1);
  });
});

describe('shouldUseNativeHttp with exclude', () => {
  it('rejects excluded URLs and keeps the default without one', () => {
    const config = cfg({ baseURL: 'https://nas.fritz.box/api', url: '/instances' });
    expect(shouldUseNativeHttp(config)).toBe(true);
    expect(shouldUseNativeHttp(config, () => true)).toBe(false);
    expect(shouldUseNativeHttp(config, () => false)).toBe(true);
  });
});
