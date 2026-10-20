import { describe, expect, it, vi } from 'vitest';

import { createKernel } from '../../core/kernel.js';
import { attachPersistence } from '../persistence.js';
import { attachProbeLoop, makeProbeFailure } from '../probeLoop.js';

import type { ConnectionPhase, Endpoint, ReducerContext, Tokens } from '../../core/types.js';
import type { ProbeContext } from '../probeLoop.js';

type ProbeFn = (ctx: ProbeContext) => Promise<Tokens>;

const LAN: Endpoint = { url: 'https://nvr.local', mode: 'direct-lan', priority: 0 };
const WAN: Endpoint = { url: 'https://nvr.example.com', mode: 'direct-wan', priority: 1 };
const TOKENS: Tokens = { access: 'at' };

function makeCtx(): ReducerContext {
  return { now: () => Date.now() };
}

function discoveringPhase(instanceId = 'a'): ConnectionPhase {
  return { kind: 'discovering', instanceId };
}

describe('attachProbeLoop — race semantics', () => {
  it('first probe to resolve wins; remaining probes get aborted', async () => {
    let lanResolve: ((t: Tokens) => void) | undefined;
    let wanAborted = false;
    const probe = vi.fn<ProbeFn>(async (ctx) => {
      if (ctx.endpoint.url === LAN.url) {
        return new Promise((res) => {
          lanResolve = res;
        });
      }
      // WAN settles only via abort
      return new Promise((_, rej) => {
        ctx.signal.addEventListener('abort', () => {
          wanAborted = true;
          rej(new Error('aborted'));
        });
      });
    });
    const discover = vi.fn(async () => [LAN, WAN]);

    const kernel = createKernel({ context: makeCtx(), initial: discoveringPhase() });
    const detach = attachProbeLoop({ kernel, discover, probe });

    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
    lanResolve!(TOKENS);
    await vi.waitFor(() => expect(kernel.phase.kind).toBe('online'));

    if (kernel.phase.kind === 'online') {
      expect(kernel.phase.target.endpoint).toEqual(LAN);
    }
    expect(wanAborted).toBe(true);
    detach();
  });

  it('starts all probes in parallel (not sequential)', async () => {
    let parallelObserved = 0;
    let peak = 0;
    const probe = vi.fn<ProbeFn>(async () => {
      parallelObserved++;
      peak = Math.max(peak, parallelObserved);
      await new Promise((r) => setTimeout(r, 5));
      parallelObserved--;
      return TOKENS;
    });
    const discover = vi.fn(async () => [LAN, WAN]);

    const kernel = createKernel({ context: makeCtx(), initial: discoveringPhase() });
    const detach = attachProbeLoop({ kernel, discover, probe });

    await vi.waitFor(() => expect(kernel.phase.kind).toBe('online'));
    expect(peak).toBe(2);
    detach();
  });
});

describe('attachProbeLoop — per-mode timeout', () => {
  it('per-probe timeout aborts the probe and surfaces as transient', async () => {
    let lanGotTimeoutAbort = false;
    const probe = vi.fn<ProbeFn>(async (ctx) => {
      // settles only via the per-probe timeout
      return new Promise((_, rej) => {
        ctx.signal.addEventListener('abort', () => {
          if (ctx.endpoint.url === LAN.url) lanGotTimeoutAbort = true;
          rej(new Error('aborted'));
        });
      });
    });
    const discover = vi.fn(async () => [LAN]);

    const kernel = createKernel({ context: makeCtx(), initial: discoveringPhase() });
    const onProbeError = vi.fn();
    const detach = attachProbeLoop({
      kernel,
      discover,
      probe,
      onProbeError,
      timeoutByMode: () => 20,
    });

    await vi.waitFor(() => expect(kernel.phase.kind).toBe('offline'));
    expect(lanGotTimeoutAbort).toBe(true);
    if (kernel.phase.kind === 'offline') {
      expect(kernel.phase.lastError).toContain('timeout');
    }
    const firstErr = onProbeError.mock.calls[0]![1] as { kind?: string };
    expect(firstErr.kind).toBe('transient');
    detach();
  });

  it('LAN times out faster than WAN — all-failed waits for the slowest', async () => {
    const probe = vi.fn<ProbeFn>(async (ctx) => {
      return new Promise((_, rej) => {
        ctx.signal.addEventListener('abort', () => rej(new Error('aborted')));
      });
    });
    const discover = vi.fn(async () => [LAN, WAN]);
    const kernel = createKernel({ context: makeCtx(), initial: discoveringPhase() });

    const detach = attachProbeLoop({
      kernel,
      discover,
      probe,
      timeoutByMode: (mode) => (mode === 'direct-lan' ? 20 : 60),
    });

    const start = Date.now();
    await vi.waitFor(() => expect(kernel.phase.kind).toBe('offline'), { timeout: 1_000 });
    const elapsed = Date.now() - start;
    // waited for WAN's timeout, not only LAN's
    expect(elapsed).toBeGreaterThanOrEqual(50);
    detach();
  });
});

describe('attachProbeLoop — failure semantics', () => {
  it('all-transient → PROBE_FAILED_ALL with reason from a typed error', async () => {
    const probe = vi.fn<ProbeFn>(async () => {
      throw makeProbeFailure('transient', 'unreachable');
    });
    const discover = vi.fn(async () => [LAN, WAN]);
    const kernel = createKernel({ context: makeCtx(), initial: discoveringPhase() });
    const detach = attachProbeLoop({ kernel, discover, probe });

    await vi.waitFor(() => expect(kernel.phase.kind).toBe('offline'));
    if (kernel.phase.kind === 'offline') {
      expect(kernel.phase.lastError).toBe('unreachable');
    }
    detach();
  });

  it('first needs-auth short-circuits the race', async () => {
    let lanResolved = false;
    const probe = vi.fn<ProbeFn>(async (ctx) => {
      if (ctx.endpoint.url === LAN.url) {
        throw makeProbeFailure('needs-auth', 'token expired');
      }
      return new Promise((_, rej) => {
        ctx.signal.addEventListener('abort', () => {
          lanResolved = true;
          rej(new Error('aborted'));
        });
      });
    });
    const discover = vi.fn(async () => [LAN, WAN]);
    const kernel = createKernel({ context: makeCtx(), initial: discoveringPhase() });
    const detach = attachProbeLoop({ kernel, discover, probe });

    await vi.waitFor(() => expect(kernel.phase.kind).toBe('needs-auth'));
    if (kernel.phase.kind === 'needs-auth') {
      expect(kernel.phase.reason).toBe('needs-auth');
    }
    expect(lanResolved).toBe(true); // WAN was aborted
    detach();
  });

  it('reports empty pool as failure', async () => {
    const discover = vi.fn(async () => []);
    const probe = vi.fn();

    const kernel = createKernel({ context: makeCtx(), initial: discoveringPhase() });
    const detach = attachProbeLoop({ kernel, discover, probe });
    await vi.waitFor(() => expect(kernel.phase.kind).toBe('offline'));
    expect(probe).not.toHaveBeenCalled();
    if (kernel.phase.kind === 'offline') {
      expect(kernel.phase.lastError).toContain('empty');
    }
    detach();
  });

  it('surfaces discover() errors as failure', async () => {
    const discover = vi.fn(async () => {
      throw new Error('tunnel/check failed');
    });
    const probe = vi.fn();

    const kernel = createKernel({ context: makeCtx(), initial: discoveringPhase() });
    const detach = attachProbeLoop({ kernel, discover, probe });
    await vi.waitFor(() => expect(kernel.phase.kind).toBe('offline'));
    expect(probe).not.toHaveBeenCalled();
    if (kernel.phase.kind === 'offline') {
      expect(kernel.phase.lastError).toContain('tunnel/check failed');
    }
    detach();
  });
});

describe('attachProbeLoop — cancellation-shaped failures', () => {
  it('a canceled endpoint does not short-circuit — a healthy candidate still wins', async () => {
    const probe = vi.fn<ProbeFn>(async (ctx) => {
      if (ctx.endpoint.url === LAN.url) throw makeProbeFailure('aborted', 'request canceled');
      await new Promise((r) => setTimeout(r, 20));
      return TOKENS;
    });
    const discover = vi.fn(async () => [LAN, WAN]);
    const kernel = createKernel({ context: makeCtx(), initial: discoveringPhase() });
    const detach = attachProbeLoop({ kernel, discover, probe });

    await vi.waitFor(() => expect(kernel.phase.kind).toBe('online'));
    if (kernel.phase.kind === 'online') {
      expect(kernel.phase.target.endpoint).toEqual(WAN);
    }
    detach();
  });

  it('canceled + transient → offline with the transient reason, no quick re-run', async () => {
    const probe = vi.fn<ProbeFn>(async (ctx) => {
      if (ctx.endpoint.url === LAN.url) throw makeProbeFailure('aborted', 'request canceled');
      throw makeProbeFailure('transient', 'server down');
    });
    const discover = vi.fn(async () => [LAN, WAN]);
    const kernel = createKernel({ context: makeCtx(), initial: discoveringPhase() });
    const detach = attachProbeLoop({ kernel, discover, probe });

    await vi.waitFor(() => expect(kernel.phase.kind).toBe('offline'));
    if (kernel.phase.kind === 'offline') {
      expect(kernel.phase.lastError).toBe('server down');
    }
    await new Promise((r) => setTimeout(r, 250));
    expect(discover).toHaveBeenCalledTimes(1);
    detach();
  });

  it('all canceled → quick re-run instead of offline', async () => {
    const probe = vi.fn<ProbeFn>(async () => {
      throw makeProbeFailure('aborted', 'request canceled');
    });
    const discover = vi.fn(async () => [LAN, WAN]);
    const kernel = createKernel({ context: makeCtx(), initial: discoveringPhase() });
    const detach = attachProbeLoop({ kernel, discover, probe });

    await vi.waitFor(() => expect(discover.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 2_000 });
    expect(kernel.phase.kind).toBe('discovering');
    detach();
  });

  it('goes offline after three rounds in which every probe was canceled', async () => {
    vi.useFakeTimers();
    try {
      const probe = vi.fn<ProbeFn>(async () => {
        throw makeProbeFailure('aborted', 'request canceled');
      });
      const discover = vi.fn(async () => [LAN, WAN]);
      const onAllFailed = vi.fn();
      const kernel = createKernel({ context: makeCtx(), initial: discoveringPhase() });
      const detach = attachProbeLoop({ kernel, discover, probe, onAllFailed });

      await vi.advanceTimersByTimeAsync(5_000);
      expect(kernel.phase.kind).toBe('offline');
      expect(discover).toHaveBeenCalledTimes(3);
      expect(onAllFailed).toHaveBeenCalledTimes(1);
      expect(kernel.phase.kind === 'offline' && kernel.phase.lastError).toContain('request canceled');
      detach();
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts canceled rounds again after the phase changed', async () => {
    vi.useFakeTimers();
    try {
      const probe = vi.fn<ProbeFn>(async () => {
        throw makeProbeFailure('aborted', 'request canceled');
      });
      const discover = vi.fn(async () => [LAN]);
      const kernel = createKernel({ context: makeCtx(), initial: discoveringPhase() });
      const detach = attachProbeLoop({ kernel, discover, probe });

      await vi.advanceTimersByTimeAsync(5_000);
      expect(kernel.phase.kind).toBe('offline');

      kernel.dispatch({ type: 'USER_RETRY' });
      await vi.advanceTimersByTimeAsync(250);
      expect(kernel.phase.kind).toBe('discovering');
      await vi.advanceTimersByTimeAsync(5_000);
      expect(kernel.phase.kind).toBe('offline');
      expect(discover).toHaveBeenCalledTimes(6);
      detach();
    } finally {
      vi.useRealTimers();
    }
  });

  it('detach cancels a pending re-run of a canceled round', async () => {
    vi.useFakeTimers();
    try {
      const discover = vi.fn(async () => [LAN]);
      const kernel = createKernel({ context: makeCtx(), initial: discoveringPhase() });
      const detach = attachProbeLoop({
        kernel,
        discover,
        probe: async () => {
          throw makeProbeFailure('aborted', 'request canceled');
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      detach();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('attachProbeLoop — re-entry + abort', () => {
  it('re-runs discover when phase re-enters discovering via USER_RETRY', async () => {
    const discover = vi.fn(async () => [LAN]);
    const probe = vi.fn<ProbeFn>(async () => {
      throw makeProbeFailure('transient', 'down');
    });

    const kernel = createKernel({ context: makeCtx(), initial: discoveringPhase() });
    const detach = attachProbeLoop({ kernel, discover, probe });

    await vi.waitFor(() => expect(kernel.phase.kind).toBe('offline'));
    expect(discover).toHaveBeenCalledTimes(1);

    kernel.dispatch({ type: 'USER_RETRY' });
    await vi.waitFor(() => expect(discover).toHaveBeenCalledTimes(2));
    detach();
  });

  it('aborts an in-flight discover when kernel resets', async () => {
    let aborted = false;
    const discover = vi.fn(async (signal: AbortSignal) => {
      return new Promise<readonly Endpoint[]>((_, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      });
    });
    const probe = vi.fn();

    const kernel = createKernel({ context: makeCtx(), initial: discoveringPhase() });
    const detach = attachProbeLoop({ kernel, discover, probe });
    expect(aborted).toBe(false);

    kernel.dispatch({ type: 'RESET' });
    await vi.waitFor(() => expect(aborted).toBe(true));
    expect(probe).not.toHaveBeenCalled();
    detach();
  });

  it('does not dispatch PROBE_SUCCEEDED if phase changed during probe', async () => {
    let probeStarted = false;
    let resolveProbe: ((t: Tokens) => void) | undefined;
    const discover = vi.fn(async () => [LAN]);
    const probe = vi.fn<ProbeFn>(async () => {
      probeStarted = true;
      return new Promise<Tokens>((resolve) => {
        resolveProbe = resolve;
      });
    });

    const kernel = createKernel({ context: makeCtx(), initial: discoveringPhase() });
    const detach = attachProbeLoop({ kernel, discover, probe });
    await vi.waitFor(() => expect(probeStarted).toBe(true));

    kernel.dispatch({ type: 'RESET' });
    resolveProbe?.(TOKENS);

    await new Promise((r) => setTimeout(r, 10));
    expect(kernel.phase.kind).toBe('idle');
    detach();
  });
});

describe('attachProbeLoop — lastTarget tokens', () => {
  it('passes lastTokens to probe on first call', async () => {
    const discover = vi.fn(async () => [LAN]);
    const probe = vi.fn<ProbeFn>(async () => TOKENS);
    const lastTokens: Tokens = { access: 'old-token', refresh: 'r' };

    const kernel = createKernel({ context: makeCtx(), initial: discoveringPhase() });
    const detach = attachProbeLoop({
      kernel,
      discover,
      probe,
      lastTarget: () => ({ endpoint: LAN, tokens: lastTokens }),
    });

    await vi.waitFor(() => expect(kernel.phase.kind).toBe('online'));
    expect(probe.mock.calls[0]![0].lastTokens).toEqual(lastTokens);
    detach();
  });

  it('waits for a slow storage restore before reading lastTarget', async () => {
    const stored: Tokens = { access: 'at-stored', refresh: 'rt-stored' };
    const storage = {
      get: () => new Promise<string>((resolve) => setTimeout(() => resolve(JSON.stringify({ endpoint: LAN, tokens: stored, savedAt: 0, version: 1 })), 5)),
      set: () => {},
      del: () => {},
    };
    const kernel = createKernel({ context: makeCtx() });
    const persistence = attachPersistence({ kernel, storage });
    const probe = vi.fn<ProbeFn>(async (ctx) => {
      if (!ctx.lastTokens) throw makeProbeFailure('needs-auth', 'no stored tokens');
      return ctx.lastTokens;
    });
    const detach = attachProbeLoop({
      kernel,
      discover: async () => [LAN],
      probe,
      lastTarget: () => persistence.peek(),
      ready: () => persistence.ready,
    });

    kernel.dispatch({ type: 'BOOT', instanceId: 'a' });

    await vi.waitFor(() => expect(kernel.phase.kind).toBe('online'));
    expect(probe.mock.calls[0]![0].lastTokens).toEqual(stored);
    detach();
    persistence.detach();
  });
});

describe('attachProbeLoop: tokens refreshed during the round', () => {
  it('keeps them when the probe only confirmed the old ones', async () => {
    const lastTokens: Tokens = { access: 'at-1', refresh: 'rt-1' };
    const refreshed: Tokens = { access: 'at-2', refresh: 'rt-2' };
    let confirm: (() => void) | undefined;
    const kernel = createKernel({ context: makeCtx(), initial: discoveringPhase() });
    const detach = attachProbeLoop({
      kernel,
      discover: async () => [LAN],
      probe: (ctx) => new Promise<Tokens>((resolve) => (confirm = () => resolve(ctx.lastTokens!))),
      lastTarget: () => ({ endpoint: LAN, tokens: lastTokens }),
    });
    await vi.waitFor(() => expect(confirm).toBeDefined());

    kernel.dispatch({ type: 'TOKENS_REFRESHED', tokens: refreshed });
    confirm!();

    await vi.waitFor(() => expect(kernel.phase.kind).toBe('online'));
    expect(kernel.phase.kind === 'online' && kernel.phase.target.tokens).toBe(refreshed);
    detach();
  });

  it('takes the tokens a probe refreshed itself', async () => {
    const probeRefreshed: Tokens = { access: 'at-3', refresh: 'rt-3' };
    let finish: (() => void) | undefined;
    const kernel = createKernel({ context: makeCtx(), initial: discoveringPhase() });
    const detach = attachProbeLoop({
      kernel,
      discover: async () => [LAN],
      probe: () => new Promise<Tokens>((resolve) => (finish = () => resolve(probeRefreshed))),
      lastTarget: () => ({ endpoint: LAN, tokens: { access: 'at-1' } }),
    });
    await vi.waitFor(() => expect(finish).toBeDefined());

    kernel.dispatch({ type: 'TOKENS_REFRESHED', tokens: { access: 'at-2' } });
    finish!();

    await vi.waitFor(() => expect(kernel.phase.kind).toBe('online'));
    expect(kernel.phase.kind === 'online' && kernel.phase.target.tokens).toBe(probeRefreshed);
    detach();
  });

  it('keeps tokens seeded while offline over a refresh of the old session', async () => {
    const seeded: Tokens = { access: 'at-login', refresh: 'rt-login' };
    const kernel = createKernel({
      context: makeCtx(),
      initial: { kind: 'offline', instanceId: 'a', lastError: 'down', nextRetryAt: 0, pendingTokens: { access: 'at-2', refresh: 'rt-2' } },
    });
    const detach = attachProbeLoop({
      kernel,
      discover: async () => [LAN],
      probe: async (ctx) => ctx.lastTokens!,
      lastTarget: () => ({ endpoint: LAN, tokens: seeded }),
    });

    kernel.dispatch({ type: 'USER_RETRY' });

    await vi.waitFor(() => expect(kernel.phase.kind).toBe('online'));
    expect(kernel.phase.kind === 'online' && kernel.phase.target.tokens).toBe(seeded);
    detach();
  });
});
