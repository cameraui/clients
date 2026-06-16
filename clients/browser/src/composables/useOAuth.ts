import { ref, watch } from 'vue';

import { NamespaceManager } from '../server/index.js';
import { resolvePluginId } from './resolvePluginId.js';
import { useCameraUi } from './useCameraUi.js';
import { rpcCall } from './useRpc.js';

import type { OAuthAuthCodeFlowCapable, OAuthCapable, OAuthDeviceFlowCapable, OAuthMetadata, OAuthState } from '@camera.ui/sdk';
import type { Ref } from 'vue';

type OAuthProxy = OAuthCapable & Partial<OAuthDeviceFlowCapable & OAuthAuthCodeFlowCapable>;

export interface UseOAuthReturn {
  readonly state: Ref<OAuthState>;
  readonly metadata: Ref<OAuthMetadata | null>;
  startDeviceFlow(scope: string[]): Promise<void>;
  startAuthCodeFlow(scope: string[]): Promise<void>;
  cancel(): Promise<void>;
  disconnect(): Promise<void>;
  refresh(): Promise<void>;
}

const POLL_ACTIVE_MS = 1_500;
const POLL_IDLE_MS = 30_000;

interface OAuthStateEntry {
  state: Ref<OAuthState>;
  metadata: Ref<OAuthMetadata | null>;
  call: <T>(fn: (proxy: OAuthProxy) => Promise<T>) => Promise<T>;
  refresh: () => Promise<void>;
}

const oauthStates = new Map<string, OAuthStateEntry>();

export function clearOAuthCache(): void {
  oauthStates.clear();
}

function createOAuthState(pluginName: string): OAuthStateEntry {
  const ctx = useCameraUi();
  const state = ref<OAuthState>({ status: 'disconnected' });
  const metadata = ref<OAuthMetadata | null>(null);
  let timer: ReturnType<typeof setInterval> | null = null;

  const call = <T>(fn: (proxy: OAuthProxy) => Promise<T>): Promise<T> =>
    rpcCall(ctx.rpc, async (rpc) => {
      const id = await resolvePluginId(ctx.rpc, pluginName);
      if (!id) throw new Error(`Plugin "${pluginName}" not found`);
      return fn(rpc.createProxy<OAuthProxy>(NamespaceManager.pluginNamespaces(id).pluginChildRpc));
    });

  async function refresh(): Promise<void> {
    state.value = await call((proxy) => proxy.getOAuthState());
    if (!metadata.value) {
      metadata.value = await call((proxy) => proxy.getOAuthMetadata());
    }
  }

  function startPolling(intervalMs: number): void {
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      // A poll failure (plugin restarting, reconnecting) must not kill the
      // loop — the next tick recovers.
      refresh().catch(() => undefined);
    }, intervalMs);
  }

  watch(
    () => state.value.status,
    (status) => {
      startPolling(status === 'awaiting_user' || status === 'polling' ? POLL_ACTIVE_MS : POLL_IDLE_MS);
    },
    { immediate: true },
  );

  refresh().catch(() => undefined);

  return { state, metadata, call, refresh };
}

export function useOAuth(pluginName: string): UseOAuthReturn {
  if (!oauthStates.has(pluginName)) {
    oauthStates.set(pluginName, createOAuthState(pluginName));
  }
  const entry = oauthStates.get(pluginName)!;
  const { state, metadata, call, refresh } = entry;

  async function startDeviceFlow(scope: string[]): Promise<void> {
    state.value = await call((proxy) => proxy.startDeviceFlow!(scope));
  }

  async function startAuthCodeFlow(scope: string[]): Promise<void> {
    state.value = await call((proxy) => proxy.startAuthCodeFlow!(scope));
  }

  async function cancel(): Promise<void> {
    if (state.value.status === 'awaiting_user' || state.value.status === 'polling') {
      await call((proxy) => proxy.cancelDeviceFlow?.() ?? proxy.cancelAuthCodeFlow?.() ?? Promise.resolve());
    }
    await refresh();
  }

  async function disconnect(): Promise<void> {
    await call((proxy) => proxy.disconnect());
    await refresh();
  }

  return { state, metadata, startDeviceFlow, startAuthCodeFlow, cancel, disconnect, refresh };
}
