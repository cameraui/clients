import { describe, expect, it, vi } from 'vitest';

import { createKernel } from '../../core/kernel.js';
import { attachProbeLoop, makeProbeFailure } from '../probeLoop.js';

import type { ConnectionPhase, Endpoint, ReducerContext, Tokens, TransportSpec } from '../../core/types.js';
import type { ProbeContext } from '../probeLoop.js';

type ProbeFn = (ctx: ProbeContext) => Promise<Tokens>;

const LAN: Endpoint = { url: 'https://nvr.local', mode: 'direct-lan', priority: 0 };
const WAN: Endpoint = { url: 'https://nvr.example.com', mode: 'direct-wan', priority: 1 };
const TOKENS: Tokens = { access: 'at' };

const SPECS: ReadonlyMap<string, TransportSpec> = new Map([['http', { id: 'http', kind: 'request', phaseGating: false }]]);

function makeCtx(): ReducerContext {
  return { specs: SPECS, now: () => Date.now() };
}

function discoveringPhase(instanceId = 'a'): ConnectionPhase {
  return { kind: 'discovering', instanceId, attempt: 1 };
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
      // WAN never resolves on its own — only via abort
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
      // Never resolves; should be aborted by the per-probe timeout
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
      timeoutByMode: () => 20, // tight for the test
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
    // We waited for WAN's timeout, not just LAN's.
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
      // WAN — will be aborted before it returns
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
});
