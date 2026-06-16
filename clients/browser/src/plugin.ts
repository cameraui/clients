import { computed, markRaw, readonly, ref, shallowRef } from 'vue';

import { refreshClientSubscriptions } from './composables/resetClientState.js';

import type { RPCClient } from '@camera.ui/rpc';
import type { ConnectionTarget } from '@camera.ui/transport';
import type { NatsTransport } from '@camera.ui/transport/transports/nats';
import type { WsTransport } from '@camera.ui/transport/transports/ws';
import type { InjectionKey, Ref } from 'vue';
import type { CameraUiContext, CameraUiEventCallback, CameraUiEventType } from './types.js';

export const CAMERA_UI_INJECTION_KEY: InjectionKey<CameraUiContext> = Symbol('camera-ui');

export interface CameraUiPluginInput {
  natsTransport: NatsTransport;
  target: Ref<ConnectionTarget | null>;
  wsTransport?: WsTransport;
}

function isContext(input: CameraUiContext | CameraUiPluginInput): input is CameraUiContext {
  return 'rpc' in input && 'isConnected' in input;
}

function makeContextFromTransport(input: CameraUiPluginInput): CameraUiContext {
  const { natsTransport, target, wsTransport } = input;

  let hasBeenConnected = false;

  const rpc = shallowRef<RPCClient | undefined>(natsTransport.getClient() ?? undefined);
  const isConnected = ref(natsTransport.getClient()?.isConnected ?? false);
  const error = ref<Error | undefined>(undefined);

  const endpoint = computed(() => target.value?.endpoint.url);
  const token = computed(() => target.value?.tokens.access);
  const extraProxyQuery = computed<Record<string, string> | undefined>(() => {
    const t = target.value;
    if (!t?.tokens.proxySession) return undefined;
    return { session: t.tokens.proxySession };
  });

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
        console.warn('[camera.ui] context listener threw:', err);
      }
    }
  }

  natsTransport.subscribeClient((next) => {
    const wasConnected = isConnected.value;
    if (next) {
      rpc.value = next;
      isConnected.value = true;
      error.value = undefined;
      if (!wasConnected) {
        refreshClientSubscriptions();
        if (hasBeenConnected) emit('reconnected');
        hasBeenConnected = true;
      }
    } else {
      rpc.value = undefined;
      isConnected.value = false;
      if (wasConnected) {
        // No wipe — NATS drop is a transient transport event, the cached data
        // (snapshots, events, etc.) is still valid for the next reconnect.
        // resetClientState() is reserved for identity-level changes (instance
        // switch, logout).
        emit('disconnected');
      }
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

  return markRaw({
    rpc,
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
