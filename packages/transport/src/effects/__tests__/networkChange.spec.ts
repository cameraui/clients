import { describe, expect, it, vi } from 'vitest';

import { createKernel } from '../../core/kernel.js';
import { attachNetworkChange } from '../networkChange.js';

import type { ReducerContext, TransportSpec } from '../../core/types.js';

const SPECS: ReadonlyMap<string, TransportSpec> = new Map([['http', { id: 'http', kind: 'request', phaseGating: false }]]);

function makeCtx(): ReducerContext {
  return { specs: SPECS, now: () => Date.now() };
}

describe('attachNetworkChange', () => {
  it('fires onChange when source dispatches a "change" event', () => {
    const source = new EventTarget();
    const kernel = createKernel({ context: makeCtx() });
    const onChange = vi.fn();
    attachNetworkChange({ kernel, source, onChange });

    source.dispatchEvent(new Event('change'));

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith(kernel, expect.any(Event));
  });

  it('passes the original Event so callbacks can inspect detail', () => {
    const source = new EventTarget();
    const kernel = createKernel({ context: makeCtx() });
    const onChange = vi.fn();
    attachNetworkChange({ kernel, source, onChange });

    const event = new CustomEvent('change', { detail: { connectionType: 'wifi' } });
    source.dispatchEvent(event);

    expect(onChange).toHaveBeenCalledWith(kernel, event);
    const received = onChange.mock.calls[0]![1] as CustomEvent<{ connectionType: string }>;
    expect(received.detail).toEqual({ connectionType: 'wifi' });
  });

  it('does not fire for unrelated events', () => {
    const source = new EventTarget();
    const kernel = createKernel({ context: makeCtx() });
    const onChange = vi.fn();
    attachNetworkChange({ kernel, source, onChange });

    source.dispatchEvent(new Event('online'));
    source.dispatchEvent(new Event('offline'));
    source.dispatchEvent(new Event('visibilitychange'));

    expect(onChange).not.toHaveBeenCalled();
  });

  it('stops firing after detach', () => {
    const source = new EventTarget();
    const kernel = createKernel({ context: makeCtx() });
    const onChange = vi.fn();
    const detach = attachNetworkChange({ kernel, source, onChange });

    source.dispatchEvent(new Event('change'));
    expect(onChange).toHaveBeenCalledOnce();

    detach();
    source.dispatchEvent(new Event('change'));
    expect(onChange).toHaveBeenCalledOnce(); // still 1
  });

  it('allows the handler to dispatch on the kernel (common pattern)', () => {
    const source = new EventTarget();
    const kernel = createKernel({
      context: makeCtx(),
      initial: { kind: 'offline', instanceId: 'a', lastError: 'lost', nextRetryAt: Date.now() + 60_000 },
    });
    attachNetworkChange({
      kernel,
      source,
      onChange: (k) => {
        if (k.phase.kind === 'offline') k.dispatch({ type: 'USER_RETRY' });
      },
    });

    source.dispatchEvent(new Event('change'));

    expect(kernel.phase.kind).toBe('discovering');
  });
});
