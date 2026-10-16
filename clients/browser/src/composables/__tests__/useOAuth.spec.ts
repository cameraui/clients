import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, effectScope, ref, shallowRef } from 'vue';

import { CAMERA_UI_INJECTION_KEY } from '../../plugin.js';
import { clearPluginIdCache } from '../resolvePluginId.js';
import { clearOAuthCache, useOAuth } from '../useOAuth.js';

import type { RPCClient } from '@camera.ui/rpc';
import type { OAuthState } from '@camera.ui/sdk';
import type { Mock } from 'vitest';
import type { CameraUiContext } from '../../types.js';

interface FakeOAuth {
  client: RPCClient;
  polls: () => number;
  getOAuthState: Mock<(ns: string) => Promise<OAuthState>>;
  pluginIds: string[];
}

function fakeOAuth(initial: OAuthState['status'] = 'disconnected'): FakeOAuth {
  let status = initial;
  const pluginIds = ['id-1'];
  const getOAuthState = vi.fn(async (_ns: string): Promise<OAuthState> => ({ status }) as OAuthState);

  const client = {
    createProxy: (ns: string) => {
      if (ns === 'coreManager.rpc') {
        return { getPlugin: async (name: string) => ({ id: pluginIds[0], name }) };
      }
      return {
        getOAuthState: () => getOAuthState(ns),
        getOAuthMetadata: async () => ({}),
        startDeviceFlow: async () => {
          status = 'awaiting_user';
          return { status };
        },
        disconnect: async () => {
          status = 'disconnected';
        },
      };
    },
  } as unknown as RPCClient;

  return { client, polls: () => getOAuthState.mock.calls.length, getOAuthState, pluginIds };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function inContext<T>(rpc: RPCClient, fn: () => T): { result: T; stop: () => void } {
  const app = createApp({});
  app.provide(CAMERA_UI_INJECTION_KEY, { rpc: shallowRef(rpc), isConnected: ref(true), on: () => {}, off: () => {} } as unknown as CameraUiContext);
  const scope = effectScope();
  const result = app.runWithContext(() => scope.run(fn)!);
  return { result, stop: () => scope.stop() };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  clearOAuthCache();
  clearPluginIdCache();
  vi.useRealTimers();
});

describe('useOAuth', () => {
  it('stops polling once its last user is gone', async () => {
    const fake = fakeOAuth();
    const first = inContext(fake.client, () => useOAuth('stop-plugin'));
    const second = inContext(fake.client, () => useOAuth('stop-plugin'));
    await flush();

    first.stop();
    const before = fake.polls();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.polls()).toBeGreaterThan(before);

    second.stop();
    const after = fake.polls();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fake.polls()).toBe(after);
  });

  it('polls fast during a device flow started after the first user left', async () => {
    const fake = fakeOAuth();
    const first = inContext(fake.client, () => useOAuth('flow-plugin'));
    await flush();
    first.stop();

    const second = inContext(fake.client, () => useOAuth('flow-plugin'));
    await second.result.startDeviceFlow(['scope']);
    await flush();
    const before = fake.polls();

    await vi.advanceTimersByTimeAsync(15_000);

    expect(fake.polls() - before).toBeGreaterThanOrEqual(9);
    second.stop();
  });

  it('never stacks polls while one is still out', async () => {
    const fake = fakeOAuth('awaiting_user');
    const view = inContext(fake.client, () => useOAuth('slow-plugin'));
    await flush();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(view.result.state.value.status).toBe('awaiting_user');

    fake.getOAuthState.mockImplementation(() => new Promise(() => {}));
    const before = fake.polls();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(fake.polls() - before).toBe(1);
    view.stop();
  });

  it('keeps a newer state over the reply of an older poll', async () => {
    const fake = fakeOAuth();
    const view = inContext(fake.client, () => useOAuth('race-plugin'));
    await flush();

    let answer!: (state: OAuthState) => void;
    fake.getOAuthState.mockImplementationOnce(() => new Promise<OAuthState>((resolve) => (answer = resolve)));
    const poll = view.result.refresh();

    await view.result.startDeviceFlow(['scope']);
    answer({ status: 'disconnected' } as OAuthState);
    await poll;

    expect(view.result.state.value.status).toBe('awaiting_user');
    view.stop();
  });

  it('shows the state after a disconnect when an older poll answers first', async () => {
    const fake = fakeOAuth('connected');
    const view = inContext(fake.client, () => useOAuth('overlap-plugin'));
    await flush();
    expect(view.result.state.value.status).toBe('connected');

    const read = fake.getOAuthState.getMockImplementation()!;
    const replies: (() => void)[] = [];
    fake.getOAuthState.mockImplementation((ns: string) => {
      const reply = read(ns);
      return new Promise<OAuthState>((resolve) => replies.push(() => resolve(reply)));
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(replies).toHaveLength(1);

    const done = view.result.disconnect();
    await flush();
    expect(replies).toHaveLength(2);
    replies[0]!();
    await flush();
    replies[1]!();
    await done;

    expect(view.result.state.value.status).toBe('disconnected');
    view.stop();
  });

  it('stops polling when the cache is cleared', async () => {
    const fake = fakeOAuth();
    const view = inContext(fake.client, () => useOAuth('clear-plugin'));
    await flush();

    clearOAuthCache();
    const before = fake.polls();
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(fake.polls()).toBe(before);
    view.stop();
  });

  it('reaches a reinstalled plugin under its new id', async () => {
    const fake = fakeOAuth('connected');
    fake.getOAuthState.mockImplementation(async (ns: string) => {
      if (ns.includes('id-1')) throw new Error(`no responders: '${ns}'`);
      return { status: 'connected' } as OAuthState;
    });

    const first = inContext(fake.client, () => useOAuth('moved-plugin'));
    await flush();
    first.stop();

    fake.pluginIds[0] = 'id-2';
    const view = inContext(fake.client, () => useOAuth('moved-plugin'));
    await view.result.refresh();

    expect(view.result.state.value.status).toBe('connected');
    expect(fake.getOAuthState).toHaveBeenLastCalledWith('plugin.id-2.child.rpc');
    view.stop();
  });
});
