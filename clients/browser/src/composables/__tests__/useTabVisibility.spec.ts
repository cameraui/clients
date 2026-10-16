import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeDocument {
  visibilityState: 'visible' | 'hidden' = 'visible';

  private listeners = new Map<string, Set<() => void>>();

  // vue's DOM runtime probes for a template element on import
  createElement(): object {
    return {};
  }

  addEventListener(type: string, listener: () => void): void {
    const set = this.listeners.get(type) ?? new Set();
    this.listeners.set(type, set);
    set.add(listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
  }

  hide(): void {
    this.visibilityState = 'hidden';
    this.dispatch('visibilitychange');
  }

  show(): void {
    this.visibilityState = 'visible';
    this.dispatch('visibilitychange');
  }
}

let doc: FakeDocument;

// the module keeps its listeners in module state, every test gets a fresh copy bound to a fresh document
async function load() {
  const { useTabVisibility } = await import('../useTabVisibility.js');
  return useTabVisibility();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  doc = new FakeDocument();
  vi.stubGlobal('document', doc);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useTabVisibility', () => {
  it('waits out the grace period before pausing and skips it when the page returns in time', async () => {
    const { onTabPaused } = await load();
    const paused = vi.fn();
    onTabPaused(paused, { delayMs: 30_000 });

    doc.hide();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(paused).not.toHaveBeenCalled();
    doc.show();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(paused).not.toHaveBeenCalled();

    doc.hide();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(paused).toHaveBeenCalledTimes(1);
  });

  it('pauses a zero-delay listener before the hidden page can be suspended', async () => {
    const { onTabPaused } = await load();
    const paused = vi.fn();
    onTabPaused(paused, { delayMs: 0 });

    doc.hide();

    expect(paused).toHaveBeenCalledTimes(1);
  });

  it('runs pending pauses when the page freezes, since its timers would not', async () => {
    const { onTabPaused } = await load();
    const paused = vi.fn();
    onTabPaused(paused);

    doc.hide();
    expect(paused).not.toHaveBeenCalled();
    doc.dispatch('freeze');
    expect(paused).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(paused).toHaveBeenCalledTimes(1);
  });

  it('tells visible listeners how long the page was hidden', async () => {
    const { onTabVisible } = await load();
    const visible = vi.fn();
    onTabVisible(visible);

    doc.hide();
    await vi.advanceTimersByTimeAsync(45_000);
    doc.show();

    expect(visible).toHaveBeenCalledWith({ hiddenMs: 45_000 });
  });
});
