import { describe, expect, it } from 'vitest';

import { reducer } from '../reducer.js';

import type { ConnectionPhase, Endpoint, ReducerContext, Tokens } from '../types.js';

const LAN: Endpoint = { url: 'https://192.168.1.10:3443', mode: 'direct-lan' };
const WAN: Endpoint = { url: 'https://nvr.example.com', mode: 'direct-wan' };
const TOKENS: Tokens = { access: 'at', refresh: 'rt' };

function makeCtx(overrides: Partial<ReducerContext> = {}): ReducerContext {
  return {
    now: () => 1_000_000,
    ...overrides,
  };
}

const IDLE: ConnectionPhase = { kind: 'idle' };

function onlinePhase(): ConnectionPhase {
  return {
    kind: 'online',
    instanceId: 'a',
    target: { endpoint: LAN, tokens: TOKENS },
  };
}

describe('reducer — RESET', () => {
  it('returns idle from any phase', () => {
    const ctx = makeCtx();
    expect(reducer(onlinePhase(), { type: 'RESET' }, ctx)).toEqual({ kind: 'idle' });
  });

  it('idle stays the same reference', () => {
    const ctx = makeCtx();
    expect(reducer(IDLE, { type: 'RESET' }, ctx)).toBe(IDLE);
  });
});

describe('reducer — BOOT', () => {
  it('idle → discovering', () => {
    const ctx = makeCtx();
    const next = reducer(IDLE, { type: 'BOOT', instanceId: 'a' }, ctx);
    expect(next).toEqual({ kind: 'discovering', instanceId: 'a' });
  });

  it('offline → discovering', () => {
    const ctx = makeCtx();
    const offline: ConnectionPhase = { kind: 'offline', instanceId: 'a', lastError: 'e', nextRetryAt: 0 };
    const next = reducer(offline, { type: 'BOOT', instanceId: 'a' }, ctx);
    expect(next.kind).toBe('discovering');
  });

  it('needs-auth → discovering', () => {
    const ctx = makeCtx();
    const needsAuth: ConnectionPhase = { kind: 'needs-auth', instanceId: 'a', reason: 'r' };
    const next = reducer(needsAuth, { type: 'BOOT', instanceId: 'a' }, ctx);
    expect(next.kind).toBe('discovering');
  });

  it('ignored when already online', () => {
    const ctx = makeCtx();
    const online = onlinePhase();
    expect(reducer(online, { type: 'BOOT', instanceId: 'a' }, ctx)).toBe(online);
  });

  it('ignored when already discovering', () => {
    const ctx = makeCtx();
    const discovering: ConnectionPhase = { kind: 'discovering', instanceId: 'a' };
    expect(reducer(discovering, { type: 'BOOT', instanceId: 'b' }, ctx)).toBe(discovering);
  });
});

describe('reducer — PROBE_SUCCEEDED', () => {
  it('discovering → online with target', () => {
    const ctx = makeCtx();
    const discovering: ConnectionPhase = { kind: 'discovering', instanceId: 'a' };
    const next = reducer(discovering, { type: 'PROBE_SUCCEEDED', endpoint: LAN, tokens: TOKENS }, ctx);
    expect(next).toEqual({
      kind: 'online',
      instanceId: 'a',
      target: { endpoint: LAN, tokens: TOKENS },
    });
  });

  it('ignored in idle', () => {
    const ctx = makeCtx();
    expect(reducer(IDLE, { type: 'PROBE_SUCCEEDED', endpoint: LAN, tokens: TOKENS }, ctx)).toBe(IDLE);
  });

  it('ignored when already online', () => {
    const ctx = makeCtx();
    const online = onlinePhase();
    expect(reducer(online, { type: 'PROBE_SUCCEEDED', endpoint: WAN, tokens: TOKENS }, ctx)).toBe(online);
  });
});

describe('reducer — PROBE_FAILED_ALL', () => {
  it('discovering → offline with default backoff', () => {
    const ctx = makeCtx({ now: () => 1000 });
    const discovering: ConnectionPhase = { kind: 'discovering', instanceId: 'a' };
    const next = reducer(discovering, { type: 'PROBE_FAILED_ALL', error: 'all dead' }, ctx);
    expect(next).toEqual({
      kind: 'offline',
      instanceId: 'a',
      lastError: 'all dead',
      nextRetryAt: 6000,
    });
  });

  it('online → offline (degraded-recovery escalation)', () => {
    const ctx = makeCtx({ now: () => 1000 });
    const next = reducer(onlinePhase(), { type: 'PROBE_FAILED_ALL', error: 'endpoint unreachable' }, ctx);
    expect(next).toEqual({
      kind: 'offline',
      instanceId: 'a',
      lastError: 'endpoint unreachable',
      nextRetryAt: 6000,
    });
  });

  it('needs-auth error short-circuits from discovering', () => {
    const ctx = makeCtx();
    const discovering: ConnectionPhase = { kind: 'discovering', instanceId: 'a' };
    const next = reducer(discovering, { type: 'PROBE_FAILED_ALL', error: 'needs-auth' }, ctx);
    expect(next).toEqual({ kind: 'needs-auth', instanceId: 'a', reason: 'needs-auth' });
  });

  it('needs-auth error short-circuits from online', () => {
    const ctx = makeCtx();
    const next = reducer(onlinePhase(), { type: 'PROBE_FAILED_ALL', error: 'needs-auth' }, ctx);
    expect(next).toEqual({ kind: 'needs-auth', instanceId: 'a', reason: 'needs-auth' });
  });

  it('ignored in idle / offline / needs-auth', () => {
    const ctx = makeCtx();
    expect(reducer(IDLE, { type: 'PROBE_FAILED_ALL', error: 'x' }, ctx)).toBe(IDLE);
    const offline: ConnectionPhase = { kind: 'offline', instanceId: 'a', lastError: 'e', nextRetryAt: 0 };
    expect(reducer(offline, { type: 'PROBE_FAILED_ALL', error: 'x' }, ctx)).toBe(offline);
    const needsAuth: ConnectionPhase = { kind: 'needs-auth', instanceId: 'a', reason: 'r' };
    expect(reducer(needsAuth, { type: 'PROBE_FAILED_ALL', error: 'x' }, ctx)).toBe(needsAuth);
  });
});

describe('reducer — USER_RETRY', () => {
  it('offline → discovering', () => {
    const ctx = makeCtx();
    const offline: ConnectionPhase = { kind: 'offline', instanceId: 'a', lastError: 'e', nextRetryAt: 0 };
    const next = reducer(offline, { type: 'USER_RETRY' }, ctx);
    expect(next).toEqual({ kind: 'discovering', instanceId: 'a' });
  });

  it('needs-auth → discovering', () => {
    const ctx = makeCtx();
    const needsAuth: ConnectionPhase = { kind: 'needs-auth', instanceId: 'a', reason: 'r' };
    const next = reducer(needsAuth, { type: 'USER_RETRY' }, ctx);
    expect(next).toEqual({ kind: 'discovering', instanceId: 'a' });
  });

  it('null instanceId falls back to empty string', () => {
    const ctx = makeCtx();
    const offline: ConnectionPhase = { kind: 'offline', instanceId: null, lastError: 'e', nextRetryAt: 0 };
    const next = reducer(offline, { type: 'USER_RETRY' }, ctx);
    expect(next).toEqual({ kind: 'discovering', instanceId: '' });
  });

  it('no-op from online (silent background probing owns re-discovery)', () => {
    const ctx = makeCtx();
    const online = onlinePhase();
    expect(reducer(online, { type: 'USER_RETRY' }, ctx)).toBe(online);
  });

  it('no-op from idle and discovering', () => {
    const ctx = makeCtx();
    expect(reducer(IDLE, { type: 'USER_RETRY' }, ctx)).toBe(IDLE);
    const discovering: ConnectionPhase = { kind: 'discovering', instanceId: 'a' };
    expect(reducer(discovering, { type: 'USER_RETRY' }, ctx)).toBe(discovering);
  });
});

describe('reducer — TOKENS_REFRESHED', () => {
  it('online → online with new tokens, target identity is fresh object', () => {
    const ctx = makeCtx();
    const online = onlinePhase();
    const newTokens: Tokens = { access: 'at-2', refresh: 'rt-2', accessExpiresAt: 999 };
    const next = reducer(online, { type: 'TOKENS_REFRESHED', tokens: newTokens }, ctx);
    expect(next.kind).toBe('online');
    if (next.kind === 'online' && online.kind === 'online') {
      expect(next.target.tokens).toEqual(newTokens);
      expect(next.target.endpoint).toEqual(LAN);
      expect(next.target).not.toBe(online.target);
    }
  });

  it('ignored in idle / offline', () => {
    const ctx = makeCtx();
    expect(reducer(IDLE, { type: 'TOKENS_REFRESHED', tokens: TOKENS }, ctx)).toBe(IDLE);
    const offline: ConnectionPhase = { kind: 'offline', instanceId: 'a', lastError: 'x', nextRetryAt: 0 };
    expect(reducer(offline, { type: 'TOKENS_REFRESHED', tokens: TOKENS }, ctx)).toBe(offline);
  });

  it('online with identical tokens → returns same phase reference (idempotent)', () => {
    const ctx = makeCtx();
    const online = onlinePhase();
    const sameTokens: Tokens = { ...TOKENS };
    const next = reducer(online, { type: 'TOKENS_REFRESHED', tokens: sameTokens }, ctx);
    // Identity equality — kernel uses `after !== prev` to decide whether to
    // notify listeners. This guarantees no cross-tab/persistence ping-pong
    // when both sides converge on the same tokens.
    expect(next).toBe(online);
  });

  it('online — different expiresAt with same access counts as different (still updates)', () => {
    const ctx = makeCtx();
    const online: ConnectionPhase = {
      kind: 'online',
      instanceId: 'a',
      target: { endpoint: LAN, tokens: { access: 'at', accessExpiresAt: 1000 } },
    };
    const differentExpiry: Tokens = { access: 'at', accessExpiresAt: 2000 };
    const next = reducer(online, { type: 'TOKENS_REFRESHED', tokens: differentExpiry }, ctx);
    expect(next).not.toBe(online);
  });

  it('discovering carries pendingTokens on the phase', () => {
    const ctx = makeCtx();
    const discovering = reducer({ kind: 'idle' }, { type: 'BOOT', instanceId: 'a' }, ctx);
    const fresh: Tokens = { access: 'at-new', refresh: 'rt-new' };
    const next = reducer(discovering, { type: 'TOKENS_REFRESHED', tokens: fresh }, ctx);
    expect(next.kind).toBe('discovering');
    expect(next.kind === 'discovering' && next.pendingTokens).toBe(fresh);
  });

  it('discovering is idempotent for equal pending tokens', () => {
    const ctx = makeCtx();
    const discovering = reducer({ kind: 'idle' }, { type: 'BOOT', instanceId: 'a' }, ctx);
    const fresh: Tokens = { access: 'at-new' };
    const once = reducer(discovering, { type: 'TOKENS_REFRESHED', tokens: fresh }, ctx);
    const twice = reducer(once, { type: 'TOKENS_REFRESHED', tokens: { access: 'at-new' } }, ctx);
    expect(twice).toBe(once);
  });
});

describe('reducer — TOKENS_INVALID', () => {
  it('online → needs-auth on permanent failure (no retry until user action)', () => {
    const ctx = makeCtx({ now: () => 5000 });
    const next = reducer(onlinePhase(), { type: 'TOKENS_INVALID', reason: 'refresh-401' }, ctx);
    expect(next).toEqual({
      kind: 'needs-auth',
      instanceId: 'a',
      reason: 'tokens invalid: refresh-401',
    });
  });

  it('online → offline on transient failure (backoff retries with same tokens)', () => {
    const ctx = makeCtx({ now: () => 5000 });
    const next = reducer(onlinePhase(), { type: 'TOKENS_INVALID', reason: 'network', transient: true }, ctx);
    expect(next).toEqual({
      kind: 'offline',
      instanceId: 'a',
      lastError: 'tokens invalid: network',
      nextRetryAt: 10_000,
    });
  });

  it('ignored when not online', () => {
    const ctx = makeCtx();
    expect(reducer(IDLE, { type: 'TOKENS_INVALID', reason: 'r' }, ctx)).toBe(IDLE);
    const discovering: ConnectionPhase = { kind: 'discovering', instanceId: 'a' };
    expect(reducer(discovering, { type: 'TOKENS_INVALID', reason: 'r' }, ctx)).toBe(discovering);
  });
});

describe('reducer — ENDPOINT_SWAP', () => {
  it('swaps the online target in place without leaving online', () => {
    const ctx = makeCtx();
    const next = reducer(onlinePhase(), { type: 'ENDPOINT_SWAP', endpoint: WAN, tokens: { access: 'at-1' } }, ctx);
    expect(next.kind).toBe('online');
    expect(next.kind === 'online' && next.target.endpoint.url).toBe(WAN.url);
    expect(next.kind === 'online' && next.target.tokens.access).toBe('at-1');
  });

  it('same endpoint merges tokens and is idempotent for equal tokens', () => {
    const ctx = makeCtx();
    const merged = reducer(onlinePhase(), { type: 'ENDPOINT_SWAP', endpoint: LAN, tokens: { access: 'at-1' } }, ctx);
    expect(merged.kind === 'online' && merged.target.tokens.access).toBe('at-1');
    const again = reducer(merged, { type: 'ENDPOINT_SWAP', endpoint: LAN, tokens: { access: 'at-1' } }, ctx);
    expect(again).toBe(merged);
  });

  it('is ignored outside online', () => {
    const ctx = makeCtx();
    expect(reducer(IDLE, { type: 'ENDPOINT_SWAP', endpoint: LAN, tokens: { access: 'x' } }, ctx)).toBe(IDLE);
    const discovering: ConnectionPhase = { kind: 'discovering', instanceId: 'a' };
    expect(reducer(discovering, { type: 'ENDPOINT_SWAP', endpoint: LAN, tokens: { access: 'x' } }, ctx)).toBe(discovering);
  });
});

describe('reducer — BACKOFF_HINT', () => {
  it('offline + hint farther out → extends nextRetryAt + records hint', () => {
    const ctx = makeCtx({ now: () => 1_000 });
    const offline: ConnectionPhase = {
      kind: 'offline',
      instanceId: 'a',
      lastError: 'down',
      nextRetryAt: 6_000, // 5s from now
    };
    const next = reducer(offline, { type: 'BACKOFF_HINT', retryAfterMs: 30_000, source: 'tunnel-503' }, ctx);
    if (next.kind !== 'offline') throw new Error('expected offline');
    expect(next.nextRetryAt).toBe(31_000); // 1000 + 30000
    expect(next.backoffHint).toEqual({
      retryAfterMs: 30_000,
      setAt: 1_000,
      source: 'tunnel-503',
    });
  });

  it('offline + hint shorter than current → keeps phase unchanged (never shorten)', () => {
    const ctx = makeCtx({ now: () => 1_000 });
    const offline: ConnectionPhase = {
      kind: 'offline',
      instanceId: 'a',
      lastError: 'down',
      nextRetryAt: 61_000, // 60s out — beyond what the 30s hint would set
    };
    const next = reducer(offline, { type: 'BACKOFF_HINT', retryAfterMs: 30_000 }, ctx);
    expect(next).toBe(offline);
  });

  it('non-offline phase → no-op', () => {
    const ctx = makeCtx();
    const online = onlinePhase();
    expect(reducer(online, { type: 'BACKOFF_HINT', retryAfterMs: 30_000 }, ctx)).toBe(online);
    expect(reducer(IDLE, { type: 'BACKOFF_HINT', retryAfterMs: 30_000 }, ctx)).toBe(IDLE);
  });

  it('source field is optional', () => {
    const ctx = makeCtx({ now: () => 1_000 });
    const offline: ConnectionPhase = {
      kind: 'offline',
      instanceId: 'a',
      lastError: 'down',
      nextRetryAt: 2_000,
    };
    const next = reducer(offline, { type: 'BACKOFF_HINT', retryAfterMs: 30_000 }, ctx);
    if (next.kind !== 'offline') throw new Error('expected offline');
    expect(next.backoffHint?.source).toBeUndefined();
    expect(next.backoffHint?.retryAfterMs).toBe(30_000);
  });
});
