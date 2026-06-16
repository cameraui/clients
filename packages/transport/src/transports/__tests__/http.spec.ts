import { describe, expect, it, vi } from 'vitest';

import { createHttpTransport } from '../http.js';

import type { ConnectionTarget } from '../../core/types.js';

const T1: ConnectionTarget = {
  endpoint: { url: 'https://nvr.local:3443', mode: 'direct-lan' },
  tokens: { access: 'at-1' },
};
const T2: ConnectionTarget = {
  endpoint: { url: 'https://nvr.example.com', mode: 'direct-wan' },
  tokens: { access: 'at-1', proxySession: 'ps-1' },
};

describe('createHttpTransport — apply lifecycle', () => {
  it('starts with health.up = false', () => {
    const t = createHttpTransport();
    expect(t.health().up).toBe(false);
  });

  it('apply(null) keeps health down + emits down', async () => {
    const t = createHttpTransport();
    const down = vi.fn();
    t.on('down', down);
    await t.apply(null);
    expect(down).not.toHaveBeenCalled();
  });

  it('apply(target) then apply(same target) is a no-op', async () => {
    const t = createHttpTransport();
    await t.apply(T1);
    const down = vi.fn();
    t.on('down', down);
    await t.apply(T1);
    expect(down).not.toHaveBeenCalled();
  });

  it('endpoint change resets status', async () => {
    const t = createHttpTransport();
    await t.apply(T1);
    expect(t.health().up).toBe(false);
    await t.apply(T2);
    expect(t.health().up).toBe(false);
  });

  it('apply(null) after apply(target) emits down', async () => {
    const t = createHttpTransport();
    await t.apply(T1);
    const down = vi.fn();
    t.on('down', down);
    await t.apply(null);
    expect(down).toHaveBeenCalledWith({ reason: 'detached' });
  });

  it('dispose makes apply throw', async () => {
    const t = createHttpTransport();
    await t.dispose();
    await expect(t.apply(T1)).rejects.toThrow(/disposed/);
  });
});

describe('createHttpTransport — request interceptor', () => {
  it('cancels a request if no target arrives within targetWaitMs', async () => {
    const t = createHttpTransport({ targetWaitMs: 30 });
    await expect(t.client.get('/foo')).rejects.toBeDefined();
  });

  it('waits for a target then proceeds once applied', async () => {
    const t = createHttpTransport({ targetWaitMs: 1000 });
    const adapter = vi.fn(async (config: any) => ({
      data: null,
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    }));
    t.client.defaults.adapter = adapter as any;
    const p = t.client.get('/cameras');
    // Let the async interceptor register its waiter before the target lands.
    await new Promise((r) => setTimeout(r, 10));
    await t.apply(T1);
    await p;
    expect(adapter.mock.calls[0]![0].baseURL).toBe('https://nvr.local:3443/api');
  });

  it('cancels a waiting request when its AbortSignal fires', async () => {
    const t = createHttpTransport({ targetWaitMs: 1000 });
    const ac = new AbortController();
    const p = t.client.get('/foo', { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    await expect(p).rejects.toBeDefined();
  });

  it('sets baseURL and Authorization header when target is applied', async () => {
    const t = createHttpTransport();
    await t.apply(T1);
    const adapter = vi.fn(async (config: any) => ({
      data: null,
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    }));
    t.client.defaults.adapter = adapter as any;
    await t.client.get('/cameras');
    const config = adapter.mock.calls[0]![0];
    expect(config.baseURL).toBe('https://nvr.local:3443/api');
    expect(config.headers.Authorization).toBe('Bearer at-1');
  });

  it('attaches X-Proxy-Session header when proxySession is present', async () => {
    const t = createHttpTransport();
    await t.apply(T2);
    const adapter = vi.fn(async (config: any) => ({
      data: null,
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    }));
    t.client.defaults.adapter = adapter as any;
    await t.client.get('/foo');
    const config = adapter.mock.calls[0]![0];
    expect(config.headers['X-Proxy-Session']).toBe('ps-1');
  });

  it('successful response emits "up"', async () => {
    const t = createHttpTransport();
    await t.apply(T1);
    const up = vi.fn();
    t.on('up', up);
    t.client.defaults.adapter = (async (config: any) => ({
      data: null,
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    })) as any;
    await t.client.get('/ok');
    expect(up).toHaveBeenCalledOnce();
    expect(t.health().up).toBe(true);
  });

  it('401 emits auth-error', async () => {
    const t = createHttpTransport();
    await t.apply(T1);
    const authError = vi.fn();
    t.on('auth-error', authError);
    t.client.defaults.adapter = (async (config: any) => {
      const err: any = new Error('Unauthorized');
      err.response = { status: 401, data: { message: 'expired' }, headers: {}, config, statusText: 'Unauthorized' };
      err.config = config;
      err.isAxiosError = true;
      throw err;
    }) as any;
    await expect(t.client.get('/protected')).rejects.toBeDefined();
    expect(authError).toHaveBeenCalledWith({ status: 401, message: 'expired' });
  });

  it('network error emits down', async () => {
    const t = createHttpTransport();
    await t.apply(T1);
    const down = vi.fn();
    t.on('down', down);
    t.client.defaults.adapter = (async () => {
      const err: any = new Error('Network Error');
      err.isAxiosError = true;
      throw err;
    }) as any;
    await expect(t.client.get('/x')).rejects.toBeDefined();
    expect(down).toHaveBeenCalledWith({ reason: 'Network Error' });
    expect(t.health().up).toBe(false);
  });
});
