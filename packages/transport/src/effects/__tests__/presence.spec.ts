import { describe, expect, it, vi } from 'vitest';

import { createKernel } from '../../core/kernel.js';
import { attachPresence } from '../presence.js';

import type { ConnectionPhase, Endpoint, ReducerContext, TransportSpec } from '../../core/types.js';

const LAN: Endpoint = { url: 'https://nvr.local', mode: 'direct-lan' };

const SPECS: ReadonlyMap<string, TransportSpec> = new Map([['http', { id: 'http', kind: 'request', phaseGating: false }]]);

function makeCtx(): ReducerContext {
  return { specs: SPECS, now: () => Date.now() };
}

function offlinePhase(): ConnectionPhase {
  return { kind: 'offline', instanceId: 'a', lastError: 'test', nextRetryAt: Date.now() + 60_000 };
}

class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible';
}

describe('attachPresence — network events', () => {
  it('defaults onOnline: dispatch USER_RETRY when phase is offline', () => {
    const kernel = createKernel({ context: makeCtx(), initial: offlinePhase() });
    const win = new EventTarget();
    const dispatchSpy = vi.spyOn(kernel, 'dispatch');

    attachPresence({ kernel, networkSource: win });
    win.dispatchEvent(new Event('online'));

    expect(dispatchSpy).toHaveBeenCalledWith({ type: 'USER_RETRY' });
  });

  it('defaults onOnline: no-op when phase is online', () => {
    const kernel = createKernel({
      context: makeCtx(),
      initial: { kind: 'online', instanceId: 'a', target: { endpoint: LAN, tokens: { access: 'x' } }, transports: new Map() },
    });
    const win = new EventTarget();
    const dispatchSpy = vi.spyOn(kernel, 'dispatch');

    attachPresence({ kernel, networkSource: win });
    win.dispatchEvent(new Event('online'));

    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('defaults onOnline: no-op when phase is idle', () => {
    const kernel = createKernel({ context: makeCtx() });
    const win = new EventTarget();
    const dispatchSpy = vi.spyOn(kernel, 'dispatch');

    attachPresence({ kernel, networkSource: win });
    win.dispatchEvent(new Event('online'));

    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('custom onOnline overrides the default', () => {
    const kernel = createKernel({ context: makeCtx(), initial: offlinePhase() });
    const win = new EventTarget();
    const dispatchSpy = vi.spyOn(kernel, 'dispatch');
    const custom = vi.fn();

    attachPresence({ kernel, networkSource: win, onOnline: custom });
    win.dispatchEvent(new Event('online'));

    expect(custom).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('onOffline fires when offline event arrives', () => {
    const kernel = createKernel({ context: makeCtx() });
    const win = new EventTarget();
    const onOffline = vi.fn();

    attachPresence({ kernel, networkSource: win, onOffline });
    win.dispatchEvent(new Event('offline'));

    expect(onOffline).toHaveBeenCalledTimes(1);
  });

  it('no listeners attached when networkSource is null', () => {
    const kernel = createKernel({ context: makeCtx(), initial: offlinePhase() });
    const dispatchSpy = vi.spyOn(kernel, 'dispatch');

    attachPresence({ kernel, networkSource: null });
    // No way to fire an online event without a window — just confirm no crash.
    expect(dispatchSpy).not.toHaveBeenCalled();
  });
});

describe('attachPresence — visibility events', () => {
  it('fires onVisibilityHidden when visibilityState becomes hidden', () => {
    const kernel = createKernel({ context: makeCtx() });
    const doc = new FakeDocument();
    const onHidden = vi.fn();

    attachPresence({ kernel, visibilitySource: doc, onVisibilityHidden: onHidden });
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));

    expect(onHidden).toHaveBeenCalledTimes(1);
  });

  it('fires onVisibilityVisible when visibilityState returns to visible', () => {
    const kernel = createKernel({ context: makeCtx() });
    const doc = new FakeDocument();
    const onVisible = vi.fn();
    const onHidden = vi.fn();

    attachPresence({ kernel, visibilitySource: doc, onVisibilityVisible: onVisible, onVisibilityHidden: onHidden });

    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(onHidden).toHaveBeenCalledTimes(1);

    doc.visibilityState = 'visible';
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(onVisible).toHaveBeenCalledTimes(1);
  });

  it('skips visibility listener entirely when no callbacks are provided', () => {
    const kernel = createKernel({ context: makeCtx() });
    const doc = new FakeDocument();
    const addSpy = vi.spyOn(doc, 'addEventListener');

    attachPresence({ kernel, visibilitySource: doc });

    expect(addSpy).not.toHaveBeenCalled();
  });
});

describe('attachPresence — detach', () => {
  it('removes all listeners on detach', () => {
    const kernel = createKernel({ context: makeCtx(), initial: offlinePhase() });
    const win = new EventTarget();
    const doc = new FakeDocument();
    const dispatchSpy = vi.spyOn(kernel, 'dispatch');
    const onHidden = vi.fn();

    const detach = attachPresence({
      kernel,
      networkSource: win,
      visibilitySource: doc,
      onVisibilityHidden: onHidden,
    });
    detach();

    win.dispatchEvent(new Event('online'));
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(onHidden).not.toHaveBeenCalled();
  });
});
