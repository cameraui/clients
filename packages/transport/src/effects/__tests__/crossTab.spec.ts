import { describe, expect, it, vi } from 'vitest';

import { createKernel } from '../../core/kernel.js';
import { attachCrossTab } from '../crossTab.js';

import type { ConnectionPhase, ConnectionTarget, Endpoint, ReducerContext, Tokens } from '../../core/types.js';

const LAN: Endpoint = { url: 'https://nvr.local', mode: 'direct-lan', priority: 0 };
const WAN: Endpoint = { url: 'https://nvr.example.com', mode: 'direct-wan', priority: 1 };
const TOKENS_OLD: Tokens = { access: 'at-old', refresh: 'rt-old' };
const TOKENS_NEW: Tokens = { access: 'at-new', refresh: 'rt-new' };

function makeCtx(): ReducerContext {
  return { now: () => Date.now() };
}

const ONLINE_PHASE: ConnectionPhase = {
  kind: 'online',
  instanceId: 'a',
  target: { endpoint: LAN, tokens: TOKENS_OLD },
};

const IDLE_PHASE: ConnectionPhase = { kind: 'idle' };

function fireStorage(source: EventTarget, key: string, newValue: string | null): void {
  const event = new Event('storage') as Event & { key: string; newValue: string | null };
  (event as { key: string }).key = key;
  (event as { newValue: string | null }).newValue = newValue;
  source.dispatchEvent(event);
}

function jsonTarget(target: ConnectionTarget): string {
  return JSON.stringify({ endpoint: target.endpoint, tokens: target.tokens });
}

describe('attachCrossTab — TOKENS_REFRESHED forwarding', () => {
  it('dispatches TOKENS_REFRESHED when another tab persists new tokens', () => {
    const source = new EventTarget();
    const kernel = createKernel({ context: makeCtx(), initial: ONLINE_PHASE });
    const onTokensReceived = vi.fn();
    attachCrossTab({ kernel, source, onTokensReceived });

    fireStorage(source, 'camera.ui:transport:target', jsonTarget({ endpoint: LAN, tokens: TOKENS_NEW }));

    if (kernel.phase.kind !== 'online') throw new Error('expected online');
    expect(kernel.phase.target.tokens).toEqual(TOKENS_NEW);
    expect(onTokensReceived).toHaveBeenCalledWith(TOKENS_NEW);
  });

  it('keeps the endpoint as-is — only the tokens are pulled from the storage event', () => {
    const source = new EventTarget();
    const kernel = createKernel({ context: makeCtx(), initial: ONLINE_PHASE });
    attachCrossTab({ kernel, source });

    fireStorage(source, 'camera.ui:transport:target', jsonTarget({ endpoint: WAN, tokens: TOKENS_NEW }));

    if (kernel.phase.kind !== 'online') throw new Error('expected online');
    expect(kernel.phase.target.endpoint).toEqual(LAN);
    expect(kernel.phase.target.tokens).toEqual(TOKENS_NEW);
  });
});

describe('attachCrossTab — RESET on cleared storage', () => {
  it('dispatches RESET when another tab cleared storage and we are online', () => {
    const source = new EventTarget();
    const kernel = createKernel({ context: makeCtx(), initial: ONLINE_PHASE });
    const onResetReceived = vi.fn();
    attachCrossTab({ kernel, source, onResetReceived });

    fireStorage(source, 'camera.ui:transport:target', null);

    expect(kernel.phase.kind).toBe('idle');
    expect(onResetReceived).toHaveBeenCalledOnce();
  });

  it('ignores cleared-storage when we are idle (nothing to log out from)', () => {
    const source = new EventTarget();
    const kernel = createKernel({ context: makeCtx(), initial: IDLE_PHASE });
    const onResetReceived = vi.fn();
    attachCrossTab({ kernel, source, onResetReceived });

    fireStorage(source, 'camera.ui:transport:target', null);

    expect(onResetReceived).not.toHaveBeenCalled();
  });
});

describe('attachCrossTab — filtering + error handling', () => {
  it('ignores storage events for other keys', () => {
    const source = new EventTarget();
    const kernel = createKernel({ context: makeCtx(), initial: ONLINE_PHASE });
    const onTokensReceived = vi.fn();
    attachCrossTab({ kernel, source, onTokensReceived });

    fireStorage(source, 'unrelated:key', jsonTarget({ endpoint: LAN, tokens: TOKENS_NEW }));

    expect(onTokensReceived).not.toHaveBeenCalled();
    if (kernel.phase.kind !== 'online') throw new Error('expected online');
    expect(kernel.phase.target.tokens).toEqual(TOKENS_OLD);
  });

  it('honors a custom key', () => {
    const source = new EventTarget();
    const kernel = createKernel({ context: makeCtx(), initial: ONLINE_PHASE });
    attachCrossTab({ kernel, source, key: 'my:custom:key' });

    fireStorage(source, 'my:custom:key', jsonTarget({ endpoint: LAN, tokens: TOKENS_NEW }));

    if (kernel.phase.kind !== 'online') throw new Error('expected online');
    expect(kernel.phase.target.tokens).toEqual(TOKENS_NEW);
  });

  it('drops malformed JSON and calls onError("parse")', () => {
    const source = new EventTarget();
    const kernel = createKernel({ context: makeCtx(), initial: ONLINE_PHASE });
    const onError = vi.fn();
    attachCrossTab({ kernel, source, onError });

    fireStorage(source, 'camera.ui:transport:target', '{not-json');

    expect(onError).toHaveBeenCalledWith('parse', expect.any(Error));
    if (kernel.phase.kind !== 'online') throw new Error('expected online');
    expect(kernel.phase.target.tokens).toEqual(TOKENS_OLD);
  });

  it('drops payloads without a token', () => {
    const source = new EventTarget();
    const kernel = createKernel({ context: makeCtx(), initial: ONLINE_PHASE });
    const onTokensReceived = vi.fn();
    attachCrossTab({ kernel, source, onTokensReceived });

    fireStorage(source, 'camera.ui:transport:target', '{"endpoint":{"url":"x","mode":"direct-lan"}}');

    expect(onTokensReceived).not.toHaveBeenCalled();
  });

  it('does not dispatch in idle / discovering / offline, but absorbs and notifies', () => {
    const source = new EventTarget();
    const kernel = createKernel({ context: makeCtx(), initial: IDLE_PHASE });
    const onTokensReceived = vi.fn();
    const absorb = vi.fn();
    attachCrossTab({ kernel, source, onTokensReceived, absorb });

    fireStorage(source, 'camera.ui:transport:target', jsonTarget({ endpoint: LAN, tokens: TOKENS_NEW }));

    expect(kernel.phase.kind).toBe('idle');
    expect(absorb).toHaveBeenCalledWith({ endpoint: LAN, tokens: TOKENS_NEW });
    expect(onTokensReceived).toHaveBeenCalledWith(TOKENS_NEW);
  });
});

describe('attachCrossTab: tokens of another instance', () => {
  const OTHER: Endpoint = { url: 'https://other-instance.example', mode: 'direct-wan' };

  function sameInstance(payload: { endpoint?: Endpoint }): boolean {
    return payload.endpoint?.url === LAN.url || payload.endpoint?.url === WAN.url;
  }

  it('keeps its own tokens when another tab stored a different instance', () => {
    const source = new EventTarget();
    const kernel = createKernel({ context: makeCtx(), initial: ONLINE_PHASE });
    const onTokensReceived = vi.fn();
    const onTokensIgnored = vi.fn();
    const accept = vi.fn(sameInstance);
    attachCrossTab({ kernel, source, accept, onTokensReceived, onTokensIgnored });

    fireStorage(source, 'camera.ui:transport:target', jsonTarget({ endpoint: OTHER, tokens: TOKENS_NEW }));

    if (kernel.phase.kind !== 'online') throw new Error('expected online');
    expect(kernel.phase.target.tokens).toEqual(TOKENS_OLD);
    expect(accept).toHaveBeenCalledWith({ endpoint: OTHER, tokens: TOKENS_NEW }, ONLINE_PHASE.target);
    expect(onTokensReceived).not.toHaveBeenCalled();
    expect(onTokensIgnored).toHaveBeenCalledWith({ endpoint: OTHER, tokens: TOKENS_NEW });
  });

  it('does not absorb tokens of another instance while not online', () => {
    const source = new EventTarget();
    const kernel = createKernel({ context: makeCtx(), initial: IDLE_PHASE });
    const onTokensReceived = vi.fn();
    const absorb = vi.fn();
    attachCrossTab({ kernel, source, accept: sameInstance, onTokensReceived, absorb });

    fireStorage(source, 'camera.ui:transport:target', jsonTarget({ endpoint: OTHER, tokens: TOKENS_NEW }));

    expect(absorb).not.toHaveBeenCalled();
    expect(onTokensReceived).not.toHaveBeenCalled();
  });

  it('still takes tokens of its own instance stored under another address', () => {
    const source = new EventTarget();
    const kernel = createKernel({ context: makeCtx(), initial: ONLINE_PHASE });
    attachCrossTab({ kernel, source, accept: sameInstance });

    fireStorage(source, 'camera.ui:transport:target', jsonTarget({ endpoint: WAN, tokens: TOKENS_NEW }));

    if (kernel.phase.kind !== 'online') throw new Error('expected online');
    expect(kernel.phase.target.tokens).toEqual(TOKENS_NEW);
  });
});

describe('attachCrossTab — detach', () => {
  it('stops reacting after detach', () => {
    const source = new EventTarget();
    const kernel = createKernel({ context: makeCtx(), initial: ONLINE_PHASE });
    const onTokensReceived = vi.fn();
    const detach = attachCrossTab({ kernel, source, onTokensReceived });

    detach();

    fireStorage(source, 'camera.ui:transport:target', jsonTarget({ endpoint: LAN, tokens: TOKENS_NEW }));

    expect(onTokensReceived).not.toHaveBeenCalled();
  });
});
