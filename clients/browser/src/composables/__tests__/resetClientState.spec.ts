import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, effectScope, ref, shallowRef } from 'vue';

import { CAMERA_UI_INJECTION_KEY } from '../../plugin.js';
import { resetClientState } from '../resetClientState.js';
import { clearPluginIdCache } from '../resolvePluginId.js';
import { clearOAuthCache, useOAuth } from '../useOAuth.js';

import type { RPCClient } from '@camera.ui/rpc';
import type { OAuthState } from '@camera.ui/sdk';
import type { CameraUiContext } from '../../types.js';

function fakeOAuthClient(status: OAuthState['status']): { client: RPCClient; polls: () => number } {
  let polls = 0;
  const client = {
    createProxy: (ns: string) => {
      if (ns === 'coreManager.rpc') {
        return { getPlugin: async (name: string) => ({ id: 'id-1', name }) };
      }
      return {
        getOAuthState: async () => {
          polls++;
          return { status } as OAuthState;
        },
        getOAuthMetadata: async () => ({}),
      };
    },
  } as unknown as RPCClient;
  return { client, polls: () => polls };
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

describe('resetClientState', () => {
  it('drops the OAuth state of the previous instance and stops its polling', async () => {
    const previous = fakeOAuthClient('connected');
    const oldView = inContext(previous.client, () => useOAuth('oauth-plugin'));
    await flush();
    expect(oldView.result.state.value.status).toBe('connected');

    resetClientState();
    const pollsAtSwitch = previous.polls();

    const next = fakeOAuthClient('disconnected');
    const newView = inContext(next.client, () => useOAuth('oauth-plugin'));
    expect(newView.result.state.value.status).toBe('disconnected');

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(previous.polls()).toBe(pollsAtSwitch);

    oldView.stop();
    newView.stop();
  });
});
