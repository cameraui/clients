import { Logger } from '@camera.ui/logger';
import { computed, markRaw, readonly, ref, shallowRef } from 'vue';

import { refreshClientStates, refreshClientSubscriptions } from './composables/resetClientState.js';
import { markLinkRestored } from './composables/useRpc.js';

import type { RPCClient } from '@camera.ui/rpc';
import type { ConnectionTarget } from '@camera.ui/transport';
import type { NatsTransport } from '@camera.ui/transport/transports/nats';
import type { WsTransport } from '@camera.ui/transport/transports/ws';
import type { InjectionKey, Ref, ShallowRef } from 'vue';
import type { CameraUiContext, CameraUiEventCallback, CameraUiEventType } from './types.js';

export const CAMERA_UI_INJECTION_KEY: InjectionKey<CameraUiContext> = Symbol('camera-ui');

const log = new Logger('plugin');

export interface CameraUiPluginInput {
  natsTransport: NatsTransport;
  bulkTransport?: NatsTransport;
  target: Ref<ConnectionTarget | null>;
  wsTransport?: WsTransport;
}

function isContext(input: CameraUiContext | CameraUiPluginInput): input is CameraUiContext {
  return 'rpc' in input && 'isConnected' in input;
}

const DOWN_DEBOUNCE_MS = 4_000;

function makeContextFromTransport(input: CameraUiPluginInput): CameraUiContext {
  const { natsTransport, bulkTransport, target, wsTransport } = input;

  let hasBeenConnected = natsTransport.getClient() !== null;
  let lastClient: RPCClient | null = natsTransport.getClient();
  let downTimer: ReturnType<typeof setTimeout> | null = null;
  let sawDrop = false;

  const rpc = shallowRef<RPCClient | undefined>(natsTransport.getClient() ?? undefined);
  const isConnected = ref(natsTransport.getClient()?.isConnected ?? false);
  const error = ref<Error | undefined>(undefined);

  const endpoint = computed(() => target.value?.endpoint.url);
  const token = computed(() => target.value?.tokens.access);
  const extraProxyQuery = computed<Record<string, string> | undefined>(() => undefined);

  const listeners = new Map<CameraUiEventType, Set<CameraUiEventCallback>>();

  function on(event: CameraUiEventType, cb: CameraUiEventCallback): void {
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    set.add(cb);
  }

  function off(event: CameraUiEventType, cb: CameraUiEventCallback): void {
    listeners.get(event)?.delete(cb);
  }

  function emit(event: CameraUiEventType): void {
    const set = listeners.get(event);
    if (!set) return;
    for (const cb of set) {
      try {
        cb();
      } catch (err) {
        log.warn('context listener threw:', err);
      }
    }
  }

  natsTransport.subscribeClient((next) => {
    if (next) {
      if (downTimer !== null) {
        clearTimeout(downTimer);
        downTimer = null;
      }
      const wasConnected = isConnected.value;
      const clientChanged = next !== lastClient;
      lastClient = next;
      rpc.value = next;
      isConnected.value = true;
      error.value = undefined;
      // a blip shorter than the debounce with the SAME client keeps its plugin
      // proxies (the nats lib re-issues its subscriptions itself) — a new
      // client always needs the full refresh, its server-side state is
      // connId-fresh. NATS core is at-most-once though: messages published
      // during ANY gap are gone, so even the blip must emit 'reconnected' for
      // data consumers to backfill.
      if (hasBeenConnected && (!wasConnected || clientChanged || sawDrop)) markLinkRestored(rpc);
      if (!wasConnected || clientChanged) {
        refreshClientSubscriptions();
        if (hasBeenConnected) emit('reconnected');
        hasBeenConnected = true;
      } else if (sawDrop && hasBeenConnected) {
        refreshClientStates();
        emit('reconnected');
      }
      sawDrop = false;
    } else {
      sawDrop = true;
      rpc.value = undefined;
      if (downTimer !== null || !isConnected.value) return;
      downTimer = setTimeout(() => {
        downTimer = null;
        isConnected.value = false;
        // No wipe — NATS drop is a transient transport event, the cached data
        // (snapshots, events, etc.) is still valid for the next reconnect.
        // resetClientState() is reserved for identity-level changes (instance
        // switch, logout).
        emit('disconnected');
      }, DOWN_DEBOUNCE_MS);
    }
  });

  natsTransport.on('auth-error', (payload) => {
    error.value = new Error(payload.message ?? 'auth-error');
  });

  natsTransport.on('down', (payload) => {
    if (!error.value) {
      error.value = new Error(payload.reason);
    }
  });

  natsTransport.on('up', () => {
    error.value = undefined;
  });

  let bulkRpc: ShallowRef<RPCClient | undefined> | undefined;
  if (bulkTransport) {
    const lane = shallowRef<RPCClient | undefined>();
    bulkTransport.subscribeClient((next) => {
      lane.value = next ?? undefined;
    });
    bulkRpc = lane;
  }

  return markRaw({
    rpc,
    bulkRpc,
    target: readonly(target) as Readonly<Ref<ConnectionTarget | null>>,
    isConnected: readonly(isConnected),
    endpoint,
    token,
    extraProxyQuery,
    error: readonly(error),
    wsTransport,
    on,
    off,
  });
}

export function createCameraUiPlugin(input: CameraUiContext | CameraUiPluginInput) {
  return {
    install(app: { provide: (key: symbol, value: unknown) => void }): void {
      const ctx = isContext(input) ? input : makeContextFromTransport(input);
      app.provide(CAMERA_UI_INJECTION_KEY, ctx);
    },
  };
}

export type CameraUiPlugin = ReturnType<typeof createCameraUiPlugin>;
