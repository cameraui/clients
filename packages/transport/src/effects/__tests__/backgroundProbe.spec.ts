import { describe, expect, it, vi } from 'vitest';

import { createKernel } from '../../core/kernel.js';
import { createBackgroundProbe } from '../backgroundProbe.js';

import type { ConnectionPhase, Endpoint, ReducerContext, Tokens } from '../../core/types.js';

const WAN: Endpoint = { url: 'https://wan.example', mode: 'direct-wan' };
const LAN: Endpoint = { url: 'https://lan.local', mode: 'direct-lan' };
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
