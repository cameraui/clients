import { describe, expect, it, vi } from 'vitest';

import { createKernel } from '../../core/kernel.js';
import { attachTokenLifecycle } from '../../effects/tokenLifecycle.js';
import { attachTransportSync } from '../../effects/transportSync.js';
import { createHttpTransport } from '../http.js';

import type { ConnectionTarget, Tokens } from '../../core/types.js';

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
    // let the async interceptor register its waiter first
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

  it('keeps the cloud proxy session out of direct requests', async () => {
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
    expect(config.headers['X-Proxy-Session']).toBeUndefined();
    expect(config.headers.Authorization).toBe('Bearer at-1');
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
    const t = createHttpTransport({ authRetryWaitMs: 30 });
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
    expect(authError).toHaveBeenCalledWith(expect.objectContaining({ status: 401, message: 'expired' }));
  });

  function rejectWith401(t: ReturnType<typeof createHttpTransport>, message: string): void {
    t.client.defaults.adapter = (async (config: any) => {
      const err: any = new Error('Request failed with status code 401');
      err.response = { status: 401, data: { statusCode: 401, message }, headers: {}, config, statusText: 'Unauthorized' };
      err.config = config;
      err.isAxiosError = true;
      throw err;
    }) as any;
  }

  it('a 401 from the token check names the token the request carried', async () => {
    const t = createHttpTransport({ authRetryWaitMs: 30 });
    await t.apply(T1);
    const authError = vi.fn();
    t.on('auth-error', authError);
    rejectWith401(t, 'Token revoked');

    await expect(t.client.get('/protected')).rejects.toBeDefined();

    expect(authError).toHaveBeenCalledWith(expect.objectContaining({ access: 'at-1' }));
  });

  it('a 401 for a wrong code does not name the token', async () => {
    const t = createHttpTransport({ authRetryWaitMs: 30 });
    await t.apply(T1);
    const authError = vi.fn();
    t.on('auth-error', authError);
    rejectWith401(t, 'Invalid code');

    await expect(t.client.post('/auth/2fa/enable', { code: '000000' })).rejects.toBeDefined();

    expect(authError).toHaveBeenCalledWith(expect.not.objectContaining({ access: expect.anything() }));
  });

  it('a 401 does not name the token when an authorize hook built the header', async () => {
    const t = createHttpTransport({
      authRetryWaitMs: 30,
      authorize: (config) => {
        config.headers.set('Authorization', 'Bearer ha-token');
      },
    });
    await t.apply(T1);
    const authError = vi.fn();
    t.on('auth-error', authError);
    rejectWith401(t, 'Token expired');

    await expect(t.client.get('/protected')).rejects.toBeDefined();

    expect(authError).toHaveBeenCalled();
    expect(authError).not.toHaveBeenCalledWith(expect.objectContaining({ access: expect.anything() }));
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

describe('createHttpTransport — authorize hook', () => {
  it('replaces the default Bearer header', async () => {
    const authorize = vi.fn((config: { headers: { set: (k: string, v: string) => void } }) => {
      config.headers.set('Authorization', 'Bearer ha-token');
    });
    const t = createHttpTransport({ authorize });
    await t.apply(T2);
    const adapter = vi.fn(async (config: { headers: Record<string, unknown>; baseURL?: string }) => ({
      data: {},
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    }));
    await t.client.get('/cameras', { adapter: adapter as never });
    expect(authorize).toHaveBeenCalledTimes(1);
    const config = adapter.mock.calls[0]![0];
    expect(config.baseURL).toBe('https://nvr.example.com/api');
    expect(String(config.headers.Authorization)).toBe('Bearer ha-token');
    expect(config.headers['X-Proxy-Session']).toBeUndefined();
  });
});

describe('createHttpTransport — 401 retry after token refresh', () => {
  const T1b: ConnectionTarget = { ...T1, tokens: { access: 'at-2' } };

  function adapterRejecting(access: string) {
    return vi.fn(async (config: any) => {
      if (String(config.headers.Authorization) === `Bearer ${access}`) {
        const err: any = new Error('Request failed with status code 401');
        err.config = config;
        err.response = { status: 401, data: { message: 'Token expired' }, headers: {}, config };
        err.isAxiosError = true;
        throw err;
      }
      return { data: { ok: true }, status: 200, statusText: 'OK', headers: {}, config };
    });
  }

  it('waits for the refreshed target and retries once', async () => {
    const t = createHttpTransport({ authRetryWaitMs: 1000 });
    await t.apply(T1);
    const adapter = adapterRejecting('at-1');
    t.client.defaults.adapter = adapter as any;
    const authError = vi.fn();
    t.on('auth-error', authError);

    const p = t.client.get('/cameras');
    await new Promise((r) => setTimeout(r, 10));
    expect(authError).toHaveBeenCalledWith(expect.objectContaining({ status: 401, message: 'Token expired' }));
    await t.apply(T1b);

    const res = await p;
    expect(res.data).toEqual({ ok: true });
    expect(adapter).toHaveBeenCalledTimes(2);
    expect(String(adapter.mock.calls[1]![0].headers.Authorization)).toBe('Bearer at-2');
  });

  it('retries right away when the token rotated while the request was in flight', async () => {
    const t = createHttpTransport({ authRetryWaitMs: 1000 });
    await t.apply(T1);
    const adapter = adapterRejecting('at-1');
    t.client.defaults.adapter = vi.fn(async (config: any) => {
      // rotation lands between send and response
      await t.apply(T1b);
      return adapter(config);
    }) as any;

    const res = await t.client.get('/cameras');
    expect(res.data).toEqual({ ok: true });
    expect(adapter).toHaveBeenCalledTimes(2);
  });

  it('rejects with the original 401 when no fresh token arrives in time', async () => {
    const t = createHttpTransport({ authRetryWaitMs: 30 });
    await t.apply(T1);
    const adapter = adapterRejecting('at-1');
    t.client.defaults.adapter = adapter as any;

    await expect(t.client.get('/cameras')).rejects.toMatchObject({ response: { status: 401 } });
    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it('gives up when the target is detached during the wait', async () => {
    const t = createHttpTransport({ authRetryWaitMs: 1000 });
    await t.apply(T1);
    const adapter = adapterRejecting('at-1');
    t.client.defaults.adapter = adapter as any;

    const p = t.client.get('/cameras');
    await new Promise((r) => setTimeout(r, 10));
    await t.apply(null);
    await expect(p).rejects.toMatchObject({ response: { status: 401 } });
    expect(adapter).toHaveBeenCalledTimes(1);
  });
});

describe('createHttpTransport: 401 hold follows the token refresh', () => {
  const T1b: ConnectionTarget = { ...T1, tokens: { access: 'at-2' } };

  function unauthorized(config: any, message = 'Invalid code'): never {
    const err: any = new Error('Request failed with status code 401');
    err.config = config;
    err.response = { status: 401, data: { message }, headers: {}, config };
    err.isAxiosError = true;
    throw err;
  }

  it('rejects right away when the refresh reports that no new token is coming', async () => {
    const t = createHttpTransport();
    await t.apply(T1);
    const adapter = vi.fn(async (config: any) => unauthorized(config));
    t.client.defaults.adapter = adapter as any;
    t.on('auth-error', (event) => event.holdFor?.(Promise.resolve(false)));

    const started = Date.now();
    await expect(t.client.post('/auth/2fa/enable', { code: '000000' })).rejects.toMatchObject({ response: { status: 401 } });
    expect(Date.now() - started).toBeLessThan(500);
    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it('holds while the refresh runs and retries with the new token', async () => {
    const t = createHttpTransport();
    await t.apply(T1);
    const adapter = vi.fn(async (config: any) => {
      if (String(config.headers.Authorization) === 'Bearer at-1') unauthorized(config, 'Token expired');
      return { data: { ok: true }, status: 200, statusText: 'OK', headers: {}, config };
    });
    t.client.defaults.adapter = adapter as any;
    t.on('auth-error', (event) =>
      event.holdFor?.(
        new Promise<boolean>((resolve) =>
          setTimeout(() => {
            t.apply(T1b);
            resolve(true);
          }, 20),
        ),
      ),
    );

    const res = await t.client.get('/cameras');
    expect(res.data).toEqual({ ok: true });
    expect(adapter).toHaveBeenCalledTimes(2);
    expect(String(adapter.mock.calls[1]![0].headers.Authorization)).toBe('Bearer at-2');
  });

  it('retries once right away through the authorize hook when no new token is coming', async () => {
    let haToken = 'ha-1';
    const authorize = vi.fn((config: { headers: { set: (k: string, v: string) => void } }) => {
      config.headers.set('Authorization', `Bearer ${haToken}`);
    });
    const t = createHttpTransport({ authorize });
    await t.apply(T1);
    const adapter = vi.fn(async (config: any) => {
      if (String(config.headers.Authorization) === 'Bearer ha-1') {
        haToken = 'ha-2';
        unauthorized(config, 'Unauthorized');
      }
      return { data: { ok: true }, status: 200, statusText: 'OK', headers: {}, config };
    });
    t.client.defaults.adapter = adapter as any;
    t.on('auth-error', (event) => event.holdFor?.(Promise.resolve(false)));

    const started = Date.now();
    const res = await t.client.get('/cameras');
    expect(Date.now() - started).toBeLessThan(500);
    expect(res.data).toEqual({ ok: true });
    expect(adapter).toHaveBeenCalledTimes(2);
    expect(authorize).toHaveBeenCalledTimes(2);
  });

  it('retries once right away through the authorize hook without a token lifecycle', async () => {
    const authorize = vi.fn((config: { headers: { set: (k: string, v: string) => void } }) => {
      config.headers.set('Authorization', 'Bearer ha');
    });
    const t = createHttpTransport({ authorize });
    await t.apply(T1);
    const adapter = vi.fn(async (config: any) => unauthorized(config, 'Unauthorized'));
    t.client.defaults.adapter = adapter as any;

    const started = Date.now();
    await expect(t.client.get('/cameras')).rejects.toMatchObject({ response: { status: 401 } });
    expect(Date.now() - started).toBeLessThan(500);
    expect(adapter).toHaveBeenCalledTimes(2);
  });

  it('does not retry an aborted request after the refresh settles', async () => {
    const t = createHttpTransport();
    await t.apply(T1);
    const adapter = vi.fn(async (config: any) => unauthorized(config, 'Token expired'));
    t.client.defaults.adapter = adapter as any;
    const ac = new AbortController();
    t.on('auth-error', (event) =>
      event.holdFor?.(
        new Promise<boolean>((resolve) =>
          setTimeout(() => {
            ac.abort();
            t.apply(T1b);
            resolve(true);
          }, 10),
        ),
      ),
    );

    await expect(t.client.get('/cameras', { signal: ac.signal })).rejects.toBeDefined();
    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it('rejects an aborted request right away while the refresh is still running', async () => {
    const t = createHttpTransport();
    await t.apply(T1);
    const adapter = vi.fn(async (config: any) => unauthorized(config, 'Token expired'));
    t.client.defaults.adapter = adapter as any;
    t.on('auth-error', (event) => event.holdFor?.(new Promise<boolean>(() => {})));
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);

    const started = Date.now();
    await expect(t.client.get('/cameras', { signal: ac.signal })).rejects.toBeDefined();
    expect(Date.now() - started).toBeLessThan(500);
    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it('gives up after authRetryWaitMs when the refresh takes longer', async () => {
    const t = createHttpTransport({ authRetryWaitMs: 100 });
    await t.apply(T1);
    const adapter = vi.fn(async (config: any) => unauthorized(config, 'Token expired'));
    t.client.defaults.adapter = adapter as any;
    t.on('auth-error', (event) => event.holdFor?.(new Promise<boolean>(() => {})));

    const started = Date.now();
    await expect(t.client.get('/cameras')).rejects.toMatchObject({ response: { status: 401 } });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(600);
    expect(adapter).toHaveBeenCalledTimes(1);
  });
});

describe('createHttpTransport with the token lifecycle', () => {
  async function wrongTwoFactorCode(accessTtlMs: number) {
    const kernel = createKernel({ context: { now: () => Date.now() } });
    const http = createHttpTransport();
    const adapter = vi.fn(async (config: any) => {
      const err: any = new Error('Request failed with status code 401');
      err.isAxiosError = true;
      err.config = config;
      err.response = { status: 401, data: { statusCode: 401, message: 'Invalid code' }, headers: {}, config };
      throw err;
    });
    http.client.defaults.adapter = adapter as any;
    const tokens: Tokens = { access: 'a1', accessExpiresAt: Date.now() + accessTtlMs, refresh: 'r1' };
    let persisted = tokens;
    const refresh = vi.fn(async (): Promise<Tokens> => {
      persisted = { access: `a${refresh.mock.calls.length + 1}`, accessExpiresAt: Date.now() + 900_000, refresh: 'r2' };
      return persisted;
    });
    const detachSync = attachTransportSync({ kernel, transports: [http] });
    const lifecycle = attachTokenLifecycle({ kernel, transports: [http], graceMs: 5_000, getLatestTokens: () => persisted, refresh });
    kernel.dispatch({ type: 'BOOT', instanceId: 'x' });
    kernel.dispatch({ type: 'PROBE_SUCCEEDED', endpoint: { url: 'http://127.0.0.1:1', mode: 'direct-lan' }, tokens });

    const started = Date.now();
    const error = await http.client.post('/auth/2fa/enable', { code: '000000' }).catch((e: unknown) => e);
    const elapsed = Date.now() - started;

    lifecycle.detach();
    detachSync();
    await http.dispose();
    return {
      error: error as { response?: { status: number; data: { message: string } } },
      elapsed,
      requests: adapter.mock.calls.length,
      refreshes: refresh.mock.calls.length,
    };
  }

  it('rejects a 401 that is not about the token without waiting for a refresh', async () => {
    const run = await wrongTwoFactorCode(14 * 60_000);

    expect(run.error.response?.status).toBe(401);
    expect(run.error.response?.data.message).toBe('Invalid code');
    expect(run.elapsed).toBeLessThan(500);
    expect(run.requests).toBe(1);
    expect(run.refreshes).toBe(0);
  });

  it('refreshes a token near expiry and retries once', async () => {
    const run = await wrongTwoFactorCode(3_000);

    expect(run.error.response?.status).toBe(401);
    expect(run.elapsed).toBeLessThan(500);
    expect(run.requests).toBe(2);
    expect(run.refreshes).toBe(1);
  });

  it('asks for a login when the server revoked a token that still looks fresh', async () => {
    const kernel = createKernel({ context: { now: () => Date.now() } });
    const http = createHttpTransport();
    http.client.defaults.adapter = (async (config: any) => {
      const err: any = new Error('Request failed with status code 401');
      err.isAxiosError = true;
      err.config = config;
      err.response = { status: 401, data: { statusCode: 401, message: 'Token revoked' }, headers: {}, config };
      throw err;
    }) as any;
    const tokens: Tokens = { access: 'a1', accessExpiresAt: Date.now() + 14 * 60_000, refresh: 'r1' };
    const refresh = vi.fn(async (): Promise<Tokens> => {
      throw new Error('Invalid refresh token');
    });
    const detachSync = attachTransportSync({ kernel, transports: [http] });
    const lifecycle = attachTokenLifecycle({ kernel, transports: [http], graceMs: 5_000, getLatestTokens: () => tokens, refresh });
    kernel.dispatch({ type: 'BOOT', instanceId: 'x' });
    kernel.dispatch({ type: 'PROBE_SUCCEEDED', endpoint: { url: 'http://127.0.0.1:1', mode: 'direct-lan' }, tokens });

    await http.client.get('/cameras').catch(() => {});

    expect(refresh).toHaveBeenCalledOnce();
    expect(kernel.phase.kind).toBe('needs-auth');
    lifecycle.detach();
    detachSync();
    await http.dispose();
  });
});
