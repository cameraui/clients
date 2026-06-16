import { describe, expect, it } from 'vitest';

import { reducer } from '../reducer.js';

import type { ConnectionPhase, Endpoint, ReducerContext, Tokens, TransportSpec } from '../types.js';

const LAN: Endpoint = { url: 'https://192.168.1.10:3443', mode: 'direct-lan' };
const WAN: Endpoint = { url: 'https://nvr.example.com', mode: 'direct-wan' };
const TOKENS: Tokens = { access: 'at', refresh: 'rt' };

const SPECS: ReadonlyMap<string, TransportSpec> = new Map([
  ['http', { id: 'http', kind: 'request', phaseGating: false }],
  ['socketio', { id: 'socketio', kind: 'persistent', phaseGating: true, graceMs: 4000 }],
  ['nats', { id: 'nats', kind: 'persistent', phaseGating: false }],
  ['ws', { id: 'ws', kind: 'per-resource', phaseGating: false }],
]);

function makeCtx(overrides: Partial<ReducerContext> = {}): ReducerContext {
  return {
    specs: SPECS,
    now: () => 1_000_000,
    ...overrides,
  };
}

const IDLE: ConnectionPhase = { kind: 'idle' };

describe('reducer — RESET', () => {
  it('returns idle from any phase', () => {
    const ctx = makeCtx();
    const online: ConnectionPhase = {
      kind: 'online',
      instanceId: 'a',
      target: { endpoint: LAN, tokens: TOKENS },
      transports: new Map(),
    };
    expect(reducer(online, { type: 'RESET' }, ctx)).toEqual({ kind: 'idle' });
  });
});

describe('reducer — BOOT', () => {
  it('idle → discovering', () => {
    const ctx = makeCtx();
    const next = reducer(IDLE, { type: 'BOOT', instanceId: 'a' }, ctx);
    expect(next).toEqual({ kind: 'discovering', instanceId: 'a', attempt: 1 });
  });

  it('offline → discovering', () => {
    const ctx = makeCtx();
    const offline: ConnectionPhase = { kind: 'offline', instanceId: 'a', lastError: 'e', nextRetryAt: 0 };
    const next = reducer(offline, { type: 'BOOT', instanceId: 'a' }, ctx);
    expect(next.kind).toBe('discovering');
  });

  it('ignored when already online', () => {
    const ctx = makeCtx();
    const online: ConnectionPhase = {
      kind: 'online',
      instanceId: 'a',
      target: { endpoint: LAN, tokens: TOKENS },
      transports: new Map(),
    };
    expect(reducer(online, { type: 'BOOT', instanceId: 'a' }, ctx)).toBe(online);
  });
});

describe('reducer — PROBE_SUCCEEDED', () => {
  it('discovering → online with target', () => {
    const ctx = makeCtx();
    const discovering: ConnectionPhase = { kind: 'discovering', instanceId: 'a', attempt: 1 };
    const next = reducer(discovering, { type: 'PROBE_SUCCEEDED', endpoint: LAN, tokens: TOKENS }, ctx);
    expect(next).toMatchObject({
      kind: 'online',
      instanceId: 'a',
      target: { endpoint: LAN, tokens: TOKENS },
    });
  });

  it('reconnecting → online preserves transports map', () => {
    const ctx = makeCtx();
    const transports = new Map([['nats', { up: true }]]);
    const reconnecting: ConnectionPhase = {
      kind: 'reconnecting',
      instanceId: 'a',
      lastTarget: null,
      cause: 'transport-down',
      since: 0,
      transports,
    };
    const next = reducer(reconnecting, { type: 'PROBE_SUCCEEDED', endpoint: WAN, tokens: TOKENS }, ctx);
    expect(next.kind).toBe('online');
    if (next.kind === 'online') {
      expect(next.target.endpoint).toEqual(WAN);
      expect(next.transports).toBe(transports);
    }
  });

  it('ignored in idle', () => {
    const ctx = makeCtx();
    expect(reducer(IDLE, { type: 'PROBE_SUCCEEDED', endpoint: LAN, tokens: TOKENS }, ctx)).toBe(IDLE);
  });
});

describe('reducer — PROBE_FAILED_ALL', () => {
  it('discovering → offline with default backoff', () => {
    const ctx = makeCtx({ now: () => 1000 });
    const discovering: ConnectionPhase = { kind: 'discovering', instanceId: 'a', attempt: 1 };
    const next = reducer(discovering, { type: 'PROBE_FAILED_ALL', error: 'all dead' }, ctx);
    expect(next).toEqual({
      kind: 'offline',
      instanceId: 'a',
      lastError: 'all dead',
      nextRetryAt: 6000,
    });
  });

  it('honors custom backoff function', () => {
    const ctx = makeCtx({ now: () => 1000, retryBackoffMs: (n) => n * 1000 });
    const discovering: ConnectionPhase = { kind: 'discovering', instanceId: 'a', attempt: 3 };
    const next = reducer(discovering, { type: 'PROBE_FAILED_ALL', error: 'e' }, ctx);
    if (next.kind === 'offline') {
      expect(next.nextRetryAt).toBe(4000);
    } else {
      expect.fail('expected offline');
    }
  });
});

describe('reducer — TRANSPORT_DOWN_CONFIRMED', () => {
  it('online → reconnecting when phase-gating transport down', () => {
    const ctx = makeCtx({ now: () => 2000 });
    const online: ConnectionPhase = {
      kind: 'online',
      instanceId: 'a',
      target: { endpoint: LAN, tokens: TOKENS },
      transports: new Map(),
    };
    const next = reducer(online, { type: 'TRANSPORT_DOWN_CONFIRMED', id: 'socketio' }, ctx);
    expect(next.kind).toBe('reconnecting');
    if (next.kind === 'reconnecting') {
      expect(next.lastTarget).toEqual({ endpoint: LAN, tokens: TOKENS });
      expect(next.cause).toBe('transport-down');
      expect(next.since).toBe(2000);
    }
  });

  it('ignored for non-phase-gating transport (nats)', () => {
    const ctx = makeCtx();
    const online: ConnectionPhase = {
      kind: 'online',
      instanceId: 'a',
      target: { endpoint: LAN, tokens: TOKENS },
      transports: new Map(),
    };
    const next = reducer(online, { type: 'TRANSPORT_DOWN_CONFIRMED', id: 'nats' }, ctx);
    expect(next).toBe(online);
  });

  it('ignored when not online', () => {
    const ctx = makeCtx();
    expect(reducer(IDLE, { type: 'TRANSPORT_DOWN_CONFIRMED', id: 'socketio' }, ctx)).toBe(IDLE);
  });
});

describe('reducer — TRANSPORT_UP / TRANSPORT_DOWN status tracking', () => {
  it('records status changes in online phase without flipping kind', () => {
    const ctx = makeCtx({ now: () => 500 });
    const online: ConnectionPhase = {
      kind: 'online',
      instanceId: 'a',
      target: { endpoint: LAN, tokens: TOKENS },
      transports: new Map(),
    };
    const downed = reducer(online, { type: 'TRANSPORT_DOWN', id: 'nats', reason: 'flap' }, ctx);
    expect(downed.kind).toBe('online');
    if (downed.kind === 'online') {
      expect(downed.transports.get('nats')).toEqual({ up: false, lastError: 'flap', downSince: 500 });
    }
    const upped = reducer(downed, { type: 'TRANSPORT_UP', id: 'nats' }, ctx);
    if (upped.kind === 'online') {
      expect(upped.transports.get('nats')).toEqual({ up: true });
    }
  });

  it('reconnecting → online when phase-gating transport comes back up', () => {
    const ctx = makeCtx({ now: () => 2000 });
    const reconnecting: ConnectionPhase = {
      kind: 'reconnecting',
      instanceId: 'a',
      lastTarget: { endpoint: LAN, tokens: TOKENS },
      cause: 'transport-down',
      since: 1000,
      transports: new Map([['socketio', { up: false, downSince: 1000 }]]),
    };
    const next = reducer(reconnecting, { type: 'TRANSPORT_UP', id: 'socketio' }, ctx);
    expect(next.kind).toBe('online');
    if (next.kind === 'online') {
      expect(next.target.endpoint).toEqual(LAN);
    }
  });

  it('reconnecting stays reconnecting when phase-gating still missing', () => {
    const specs: ReadonlyMap<string, TransportSpec> = new Map([
      ['a', { id: 'a', kind: 'persistent', phaseGating: true }],
      ['b', { id: 'b', kind: 'persistent', phaseGating: true }],
    ]);
    const ctx = makeCtx({ specs });
    const reconnecting: ConnectionPhase = {
      kind: 'reconnecting',
      instanceId: 'i',
      lastTarget: { endpoint: LAN, tokens: TOKENS },
      cause: 'transport-down',
      since: 0,
      transports: new Map(),
    };
    const next = reducer(reconnecting, { type: 'TRANSPORT_UP', id: 'a' }, ctx);
    expect(next.kind).toBe('reconnecting');
  });
});

describe('reducer — USER_RETRY', () => {
  it('offline → discovering', () => {
    const ctx = makeCtx();
    const offline: ConnectionPhase = { kind: 'offline', instanceId: 'a', lastError: 'e', nextRetryAt: 0 };
    const next = reducer(offline, { type: 'USER_RETRY' }, ctx);
    expect(next.kind).toBe('discovering');
  });

  it('reconnecting → discovering', () => {
    const ctx = makeCtx();
    const reconnecting: ConnectionPhase = {
      kind: 'reconnecting',
      instanceId: 'a',
      lastTarget: null,
      cause: 'transport-down',
      since: 0,
      transports: new Map(),
    };
    const next = reducer(reconnecting, { type: 'USER_RETRY' }, ctx);
    expect(next.kind).toBe('discovering');
  });

  it('ignored when idle', () => {
    const ctx = makeCtx();
    expect(reducer(IDLE, { type: 'USER_RETRY' }, ctx)).toBe(IDLE);
  });
});

describe('reducer — TOKENS_REFRESHED', () => {
  it('online → online with new tokens, target identity is fresh object', () => {
    const ctx = makeCtx();
    const online: ConnectionPhase = {
      kind: 'online',
      instanceId: 'a',
      target: { endpoint: LAN, tokens: TOKENS },
      transports: new Map(),
    };
    const newTokens: Tokens = { access: 'at-2', refresh: 'rt-2', accessExpiresAt: 999 };
    const next = reducer(online, { type: 'TOKENS_REFRESHED', tokens: newTokens }, ctx);
    expect(next.kind).toBe('online');
    if (next.kind === 'online') {
      expect(next.target.tokens).toEqual(newTokens);
      expect(next.target.endpoint).toEqual(LAN);
      expect(next.target).not.toBe(online.target);
    }
  });

  it('reconnecting with lastTarget → updates lastTarget.tokens', () => {
    const ctx = makeCtx();
    const reconnecting: ConnectionPhase = {
      kind: 'reconnecting',
      instanceId: 'a',
      lastTarget: { endpoint: LAN, tokens: TOKENS },
      cause: 'transport-down',
      since: 0,
      transports: new Map(),
    };
    const newTokens: Tokens = { access: 'at-2' };
    const next = reducer(reconnecting, { type: 'TOKENS_REFRESHED', tokens: newTokens }, ctx);
    if (next.kind === 'reconnecting') {
      expect(next.lastTarget?.tokens).toEqual(newTokens);
    } else {
      expect.fail('expected reconnecting');
    }
  });

  it('ignored in idle / discovering / offline', () => {
    const ctx = makeCtx();
    expect(reducer(IDLE, { type: 'TOKENS_REFRESHED', tokens: TOKENS }, ctx)).toBe(IDLE);
    const offline: ConnectionPhase = { kind: 'offline', instanceId: 'a', lastError: 'x', nextRetryAt: 0 };
    expect(reducer(offline, { type: 'TOKENS_REFRESHED', tokens: TOKENS }, ctx)).toBe(offline);
  });

  it('online with identical tokens → returns same phase reference (idempotent)', () => {
    const ctx = makeCtx();
    const online: ConnectionPhase = {
      kind: 'online',
      instanceId: 'a',
      target: { endpoint: LAN, tokens: TOKENS },
      transports: new Map(),
    };
    const sameTokens: Tokens = { ...TOKENS };
    const next = reducer(online, { type: 'TOKENS_REFRESHED', tokens: sameTokens }, ctx);
    // Identity equality — kernel uses `after !== prev` to decide whether to
    // notify listeners. This guarantees no cross-tab/persistence ping-pong
    // when both sides converge on the same tokens.
    expect(next).toBe(online);
  });

  it('reconnecting with identical tokens → returns same phase reference', () => {
    const ctx = makeCtx();
    const reconnecting: ConnectionPhase = {
      kind: 'reconnecting',
      instanceId: 'a',
      lastTarget: { endpoint: LAN, tokens: TOKENS },
      cause: 'transport-down',
      since: 0,
      transports: new Map(),
    };
    const sameTokens: Tokens = { ...TOKENS };
    const next = reducer(reconnecting, { type: 'TOKENS_REFRESHED', tokens: sameTokens }, ctx);
    expect(next).toBe(reconnecting);
  });

  it('online — different expiresAt with same access counts as different (still updates)', () => {
    const ctx = makeCtx();
    const online: ConnectionPhase = {
      kind: 'online',
      instanceId: 'a',
      target: { endpoint: LAN, tokens: { access: 'at', accessExpiresAt: 1000 } },
      transports: new Map(),
    };
    const differentExpiry: Tokens = { access: 'at', accessExpiresAt: 2000 };
    const next = reducer(online, { type: 'TOKENS_REFRESHED', tokens: differentExpiry }, ctx);
    expect(next).not.toBe(online);
  });
});

describe('reducer — TOKENS_INVALID', () => {
  it('online → needs-auth (no retry until user action)', () => {
    const ctx = makeCtx({ now: () => 5000, retryBackoffMs: () => 2000 });
    const online: ConnectionPhase = {
      kind: 'online',
      instanceId: 'a',
      target: { endpoint: LAN, tokens: TOKENS },
      transports: new Map(),
    };
    const next = reducer(online, { type: 'TOKENS_INVALID', reason: 'refresh-401' }, ctx);
    expect(next).toEqual({
      kind: 'needs-auth',
      instanceId: 'a',
      reason: 'tokens invalid: refresh-401',
    });
  });

  it('reconnecting → needs-auth', () => {
    const ctx = makeCtx({ now: () => 5000 });
    const reconnecting: ConnectionPhase = {
      kind: 'reconnecting',
      instanceId: 'a',
      lastTarget: null,
      cause: 'transport-down',
      since: 0,
      transports: new Map(),
    };
    const next = reducer(reconnecting, { type: 'TOKENS_INVALID', reason: 'r' }, ctx);
    expect(next.kind).toBe('needs-auth');
  });

  it('ignored when idle', () => {
    const ctx = makeCtx();
    expect(reducer(IDLE, { type: 'TOKENS_INVALID', reason: 'r' }, ctx)).toBe(IDLE);
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
    const online: ConnectionPhase = {
      kind: 'online',
      instanceId: 'a',
      target: { endpoint: LAN, tokens: TOKENS },
      transports: new Map(),
    };
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

describe('reducer — immutability', () => {
  it('does not mutate the original transports map', () => {
    const ctx = makeCtx();
    const original = new Map([['nats', { up: true }]]);
    const online: ConnectionPhase = {
      kind: 'online',
      instanceId: 'a',
      target: { endpoint: LAN, tokens: TOKENS },
      transports: original,
    };
    reducer(online, { type: 'TRANSPORT_DOWN', id: 'nats', reason: 'r' }, ctx);
    expect(original.get('nats')).toEqual({ up: true });
  });
});
