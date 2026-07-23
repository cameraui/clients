import { describe, expect, it, vi } from 'vitest';

import { isEndpointChange, isSameTarget, TransportEmitter } from '../contract.js';

import type { ConnectionTarget } from '../../core/types.js';

const T_A: ConnectionTarget = {
  endpoint: { url: 'https://a', mode: 'direct-lan' },
  tokens: { access: 'tok-1' },
};
const T_A_TOKEN2: ConnectionTarget = {
  endpoint: { url: 'https://a', mode: 'direct-lan' },
  tokens: { access: 'tok-2' },
};
const T_B: ConnectionTarget = {
  endpoint: { url: 'https://b', mode: 'direct-wan' },
  tokens: { access: 'tok-1' },
};
const T_A_PROXY: ConnectionTarget = {
  endpoint: { url: 'https://a', mode: 'direct-lan' },
  tokens: { access: 'tok-1', proxySession: 'ps-1' },
};

describe('isSameTarget', () => {
  it('same reference is same', () => {
    expect(isSameTarget(T_A, T_A)).toBe(true);
  });
  it('null vs target', () => {
    expect(isSameTarget(null, T_A)).toBe(false);
    expect(isSameTarget(T_A, null)).toBe(false);
    expect(isSameTarget(null, null)).toBe(true);
  });
  it('detects token change', () => {
    expect(isSameTarget(T_A, T_A_TOKEN2)).toBe(false);
  });
  it('detects proxySession change', () => {
    expect(isSameTarget(T_A, T_A_PROXY)).toBe(false);
  });
  it('detects endpoint change', () => {
    expect(isSameTarget(T_A, T_B)).toBe(false);
  });
});

describe('isEndpointChange', () => {
  it('endpoint change is reported', () => {
    expect(isEndpointChange(T_A, T_B)).toBe(true);
  });
  it('token-only change is reported', () => {
    expect(isEndpointChange(T_A, T_A_TOKEN2)).toBe(false);
  });
  it('no change reports both false', () => {
    expect(isEndpointChange(T_A, T_A)).toBe(false);
  });
  it('null-to-target counts as endpoint change, not token-only', () => {
    expect(isEndpointChange(null, T_A)).toBe(true);
  });
});

describe('TransportEmitter', () => {
  it('emit calls listeners with payload', () => {
    const e = new TransportEmitter();
    const onDown = vi.fn();
    e.on('down', onDown);
    e.emit('down', { reason: 'flap' });
    expect(onDown).toHaveBeenCalledWith({ reason: 'flap' });
  });

  it('off stops further notifications', () => {
    const e = new TransportEmitter();
    const fn = vi.fn();
    const off = e.on('up', fn);
    off();
    e.emit('up', undefined);
    expect(fn).not.toHaveBeenCalled();
  });

  it('multiple listeners receive the same event', () => {
    const e = new TransportEmitter();
    const a = vi.fn();
    const b = vi.fn();
    e.on('up', a);
    e.on('up', b);
    e.emit('up', undefined);
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  it('clear() removes everything', () => {
    const e = new TransportEmitter();
    const fn = vi.fn();
    e.on('down', fn);
    e.clear();
    e.emit('down', { reason: 'x' });
    expect(fn).not.toHaveBeenCalled();
  });
});
