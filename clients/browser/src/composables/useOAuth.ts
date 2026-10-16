import { isNoRespondersError } from '@camera.ui/rpc';
import { tryOnScopeDispose } from '@vueuse/core';
import { ref } from 'vue';

import { NamespaceManager } from '../server/index.js';
import { forgetPluginId, resolvePluginId } from './resolvePluginId.js';
import { useCameraUi } from './useCameraUi.js';
import { rpcCall } from './useRpc.js';

import type { RPCClient } from '@camera.ui/rpc';
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
  apply: (next: OAuthState) => void;
  retain: () => void;
  release: () => void;
  stop: () => void;
}

const oauthStates = new Map<string, OAuthStateEntry>();

export function clearOAuthCache(): void {
  for (const entry of oauthStates.values()) entry.stop();
  oauthStates.clear();
}

function createOAuthState(pluginName: string): OAuthStateEntry {
  const ctx = useCameraUi();
  const state = ref<OAuthState>({ status: 'disconnected' });
  const metadata = ref<OAuthMetadata | null>(null);
  let timer: ReturnType<typeof setInterval> | undefined;
  let timerMs = 0;
  let users = 0;
  let polling = false;
  let seq = 0;
  let appliedSeq = 0;

  function proxyFor(rpc: RPCClient, id: string): OAuthProxy {
    return rpc.createProxy<OAuthProxy>(NamespaceManager.pluginNamespaces(id).pluginChildRpc);
  }

  const call = <T>(fn: (proxy: OAuthProxy) => Promise<T>): Promise<T> =>
    rpcCall(ctx.rpc, async (rpc) => {
      const id = await resolvePluginId(ctx.rpc, pluginName);
      if (!id) throw new Error(`Plugin "${pluginName}" not found`);
      try {
        return await fn(proxyFor(rpc, id));
      } catch (err) {
        if (!isNoRespondersError(err)) throw err;
        // a reinstalled plugin answers under a new id, nobody received the call under the old one
        forgetPluginId(pluginName);
        const freshId = await resolvePluginId(ctx.rpc, pluginName);
        if (!freshId || freshId === id) throw err;
        return fn(proxyFor(rpc, freshId));
      }
    });

  function apply(next: OAuthState, at = ++seq): void {
    if (at < appliedSeq) return;
    appliedSeq = at;
    state.value = next;
    schedule();
  }

  async function refresh(): Promise<void> {
    const at = ++seq;
    const next = await call((proxy) => proxy.getOAuthState());
    apply(next, at);
    if (!metadata.value) {
      metadata.value = await call((proxy) => proxy.getOAuthMetadata());
    }
  }

  function poll(): void {
    if (polling) return;
    polling = true;
    refresh()
      .catch(() => undefined)
      .finally(() => {
        polling = false;
      });
  }

  function schedule(): void {
    const { status } = state.value;
    const active = status === 'awaiting_user' || status === 'polling';
    const ms = users === 0 ? 0 : active ? POLL_ACTIVE_MS : POLL_IDLE_MS;
    if (ms === timerMs) return;
    clearInterval(timer);
    timer = ms ? setInterval(poll, ms) : undefined;
    timerMs = ms;
  }

  function retain(): void {
    if (users++ > 0) return;
    schedule();
    poll();
  }

  function release(): void {
    if (users === 0) return;
    users--;
    schedule();
  }

  function stop(): void {
    users = 0;
    schedule();
  }

  return { state, metadata, call, refresh, apply, retain, release, stop };
}

export function useOAuth(pluginName: string): UseOAuthReturn {
  if (!oauthStates.has(pluginName)) {
    oauthStates.set(pluginName, createOAuthState(pluginName));
  }
  const entry = oauthStates.get(pluginName)!;
  const { state, metadata, call, refresh, apply } = entry;

  entry.retain();
  tryOnScopeDispose(entry.release);

  async function startDeviceFlow(scope: string[]): Promise<void> {
    apply(await call((proxy) => proxy.startDeviceFlow!(scope)));
  }

  async function startAuthCodeFlow(scope: string[]): Promise<void> {
    apply(await call((proxy) => proxy.startAuthCodeFlow!(scope)));
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
