import { describe, expect, it, vi } from 'vitest';

import { createKernel } from '../../core/kernel.js';
import { createBackgroundProbe } from '../backgroundProbe.js';

import type { ConnectionPhase, Endpoint, ReducerContext, Tokens } from '../../core/types.js';

const WAN: Endpoint = { url: 'https://wan.example', mode: 'direct-wan' };
const LAN: Endpoint = { url: 'https://lan.local', mode: 'direct-lan' };
const LAN_V6: Endpoint = { url: 'https://[fd00::10]', mode: 'direct-lan' };
const WAN_2: Endpoint = { url: 'https://wan-2.example', mode: 'direct-wan' };
const TOKENS: Tokens = { access: 'at-0' };

function makeCtx(): ReducerContext {
  return { now: () => Date.now() };
}

function onlinePhase(endpoint: Endpoint): ConnectionPhase {
  return { kind: 'online', instanceId: 'a', target: { endpoint, tokens: TOKENS } };
}

describe('createBackgroundProbe', () => {
  it('swaps the target in place when a preferred endpoint wins', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlinePhase(WAN) });
    const onResult = vi.fn();
    const bg = createBackgroundProbe({
      kernel,
      discover: async () => [WAN, LAN],
      probe: async ({ endpoint }) => ({ access: `at-${endpoint.mode}` }),
      prefer: (ep) => ep.mode === 'direct-lan',
      onResult,
    });

    await expect(bg.run()).resolves.toBe('swap');

    expect(kernel.phase.kind).toBe('online');
    expect(kernel.phase.kind === 'online' && kernel.phase.target.endpoint.url).toBe(LAN.url);
    expect(onResult).toHaveBeenCalledWith('swap', LAN.url);
  });

  it('reports same when the current endpoint wins again', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlinePhase(WAN) });
    const onResult = vi.fn();
    const bg = createBackgroundProbe({
      kernel,
      discover: async () => [WAN],
      probe: async () => TOKENS,
      onResult,
    });

    await expect(bg.run()).resolves.toBe('same');
    expect(kernel.phase.kind === 'online' && kernel.phase.target.endpoint.url).toBe(WAN.url);
    expect(onResult).toHaveBeenCalledWith('same', WAN.url);
  });

  it('keeps a healthy preferred target when only a non-preferred endpoint wins', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlinePhase(LAN) });
    const onResult = vi.fn();
    const bg = createBackgroundProbe({
      kernel,
      discover: async () => [WAN, LAN],
      probe: async ({ endpoint }) => {
        if (endpoint.mode === 'direct-lan') throw new Error('interface still settling');
        return TOKENS;
      },
      prefer: (ep) => ep.mode === 'direct-lan',
      isCurrentHealthy: () => true,
      onResult,
    });

    await expect(bg.run()).resolves.toBe('kept');
    expect(kernel.phase.kind === 'online' && kernel.phase.target.endpoint.url).toBe(LAN.url);
    expect(onResult).toHaveBeenCalledWith('kept', LAN.url);
  });

  it('keeps a healthy target when an endpoint of the same class answers first', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlinePhase(LAN) });
    const before = kernel.phase;
    const onResult = vi.fn();
    const bg = createBackgroundProbe({
      kernel,
      discover: async () => [LAN, LAN_V6],
      probe: async ({ endpoint, lastTokens }) => {
        await new Promise((r) => setTimeout(r, endpoint === LAN_V6 ? 1 : 15));
        return lastTokens!;
      },
      lastTarget: () => (kernel.phase.kind === 'online' ? kernel.phase.target : null),
      prefer: (ep) => ep.mode === 'direct-lan',
      preferGraceMs: 1_000,
      isCurrentHealthy: () => true,
      onResult,
    });

    await expect(bg.run()).resolves.toBe('kept');
    expect(kernel.phase).toBe(before);
    expect(onResult).toHaveBeenCalledWith('kept', expect.stringContaining(LAN_V6.url));
  });

  it('keeps a healthy WAN target when another WAN endpoint wins', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlinePhase(WAN) });
    const bg = createBackgroundProbe({
      kernel,
      discover: async () => [WAN_2],
      probe: async () => TOKENS,
      prefer: (ep) => ep.mode === 'direct-lan',
      isCurrentHealthy: () => true,
    });

    await expect(bg.run()).resolves.toBe('kept');
    expect(kernel.phase.kind === 'online' && kernel.phase.target.endpoint.url).toBe(WAN.url);
  });

  it('still upgrades a healthy WAN target to LAN', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlinePhase(WAN) });
    const bg = createBackgroundProbe({
      kernel,
      discover: async () => [WAN, LAN],
      probe: async () => TOKENS,
      prefer: (ep) => ep.mode === 'direct-lan',
      isCurrentHealthy: () => true,
    });

    await expect(bg.run()).resolves.toBe('swap');
    expect(kernel.phase.kind === 'online' && kernel.phase.target.endpoint.url).toBe(LAN.url);
  });

  it('keeps the tokens a probe refreshed when it keeps the endpoint', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlinePhase(LAN) });
    const refreshed: Tokens = { access: 'at-1', refresh: 'rt-1' };
    const bg = createBackgroundProbe({
      kernel,
      discover: async () => [LAN_V6],
      probe: async () => refreshed,
      lastTarget: () => (kernel.phase.kind === 'online' ? kernel.phase.target : null),
      prefer: (ep) => ep.mode === 'direct-lan',
      isCurrentHealthy: () => true,
    });

    await expect(bg.run()).resolves.toBe('kept');
    expect(kernel.phase.kind === 'online' && kernel.phase.target.endpoint.url).toBe(LAN.url);
    expect(kernel.phase.kind === 'online' && kernel.phase.target.tokens).toBe(refreshed);
  });

  it('downgrades when the current preferred target is unhealthy', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlinePhase(LAN) });
    const bg = createBackgroundProbe({
      kernel,
      discover: async () => [WAN, LAN],
      probe: async ({ endpoint }) => {
        if (endpoint.mode === 'direct-lan') throw new Error('unreachable');
        return TOKENS;
      },
      prefer: (ep) => ep.mode === 'direct-lan',
      isCurrentHealthy: () => false,
    });

    await expect(bg.run()).resolves.toBe('swap');
    expect(kernel.phase.kind === 'online' && kernel.phase.target.endpoint.url).toBe(WAN.url);
  });

  it('downgrades without a health check (legacy behavior)', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlinePhase(LAN) });
    const bg = createBackgroundProbe({
      kernel,
      discover: async () => [WAN, LAN],
      probe: async ({ endpoint }) => {
        if (endpoint.mode === 'direct-lan') throw new Error('unreachable');
        return TOKENS;
      },
      prefer: (ep) => ep.mode === 'direct-lan',
    });

    await expect(bg.run()).resolves.toBe('swap');
    expect(kernel.phase.kind === 'online' && kernel.phase.target.endpoint.url).toBe(WAN.url);
  });

  it('a failed round changes nothing', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlinePhase(WAN) });
    const before = kernel.phase;
    const onResult = vi.fn();
    const bg = createBackgroundProbe({
      kernel,
      discover: async () => [LAN],
      probe: async () => {
        throw new Error('nope');
      },
      onResult,
    });

    await expect(bg.run()).resolves.toBe('failed');
    expect(kernel.phase).toBe(before);
    expect(onResult).toHaveBeenCalledWith('failed', expect.any(String));
  });

  it('skips outside online', async () => {
    const kernel = createKernel({ context: makeCtx() });
    const discover = vi.fn();
    const onResult = vi.fn();
    const bg = createBackgroundProbe({ kernel, discover, probe: async () => TOKENS, onResult });

    await expect(bg.run()).resolves.toBe('skipped');
    expect(discover).not.toHaveBeenCalled();
    expect(onResult).toHaveBeenCalledWith('skipped', 'phase=idle');
  });

  it('waits for ready before reading lastTarget', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlinePhase(WAN) });
    let restored: Tokens | null = null;
    const ready = new Promise<void>((resolve) =>
      setTimeout(() => {
        restored = { access: 'at-restored' };
        resolve();
      }, 5),
    );
    const probe = vi.fn(async ({ lastTokens }: { lastTokens?: Tokens }) => lastTokens ?? TOKENS);
    const bg = createBackgroundProbe({
      kernel,
      discover: async () => [WAN],
      probe,
      lastTarget: () => (restored ? { endpoint: WAN, tokens: restored } : null),
      ready: () => ready,
    });

    await bg.run();
    expect(probe.mock.calls[0]![0].lastTokens).toEqual({ access: 'at-restored' });
  });

  it('is single-flight', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlinePhase(WAN) });
    let discovers = 0;
    const bg = createBackgroundProbe({
      kernel,
      discover: async () => {
        discovers++;
        await new Promise((r) => setTimeout(r, 20));
        return [WAN];
      },
      probe: async () => TOKENS,
    });

    const outcomes = await Promise.all([bg.run(), bg.run(), bg.run()]);
    expect(outcomes).toEqual(['same', 'same', 'same']);
    expect(discovers).toBe(1);
  });
});

describe('createBackgroundProbe: tokens refreshed during the round', () => {
  it('keeps them when the probe only confirmed the old ones', async () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlinePhase(WAN) });
    const refreshed: Tokens = { access: 'at-1', refresh: 'rt-1' };
    let confirm: (() => void) | undefined;
    const bg = createBackgroundProbe({
      kernel,
      discover: async () => [LAN],
      probe: (ctx) => new Promise<Tokens>((resolve) => (confirm = () => resolve(ctx.lastTokens!))),
      lastTarget: () => (kernel.phase.kind === 'online' ? kernel.phase.target : null),
    });

    const round = bg.run();
    await vi.waitFor(() => expect(confirm).toBeDefined());
    kernel.dispatch({ type: 'TOKENS_REFRESHED', tokens: refreshed });
    confirm!();

    await expect(round).resolves.toBe('swap');
    expect(kernel.phase.kind === 'online' && kernel.phase.target.endpoint.url).toBe(LAN.url);
    expect(kernel.phase.kind === 'online' && kernel.phase.target.tokens).toBe(refreshed);
  });
});
