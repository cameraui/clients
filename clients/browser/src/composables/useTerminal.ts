import { tryOnScopeDispose } from '@vueuse/core';
import { readonly, ref, shallowRef } from 'vue';

import { NamespaceManager } from '../server/index.js';
import { useCameraUi } from './useCameraUi.js';
import { rpcCall } from './useRpc.js';

import type { RPCClient } from '@camera.ui/rpc';
import type { Ref, ShallowRef } from 'vue';
import type { TerminalManagerInterface, TerminalManagerNamespaces, TerminalOptions } from '../server/index.js';

export interface UseTerminalOptions extends TerminalOptions {
  onData?: (data: Uint8Array) => void;
  onClose?: () => void;
  onError?: (error: Error) => void;
}

export interface UseTerminalReturn {
  sessionId: Readonly<ShallowRef<string | undefined>>;
  isConnected: Readonly<Ref<boolean>>;
  isConnecting: Readonly<Ref<boolean>>;
  isClientConnected: Readonly<Ref<boolean>>;
  error: Readonly<Ref<Error | undefined>>;
  dimensions: Readonly<Ref<{ cols: number; rows: number }>>;

  connect: (options?: UseTerminalOptions) => Promise<void>;
  write: (data: string) => Promise<void>;
  resize: (dimensions: { cols: number; rows: number }) => Promise<void>;
  close: () => Promise<void>;
}

export function useTerminal(): UseTerminalReturn {
  const cameraUi = useCameraUi();
  const { rpc, isConnected: isClientConnected } = cameraUi;
  const namespaces: TerminalManagerNamespaces = NamespaceManager.terminalManagerNamespaces();

  const sessionId = shallowRef<string | undefined>();
  const isConnected = ref(false);
  const isConnecting = ref(false);
  const error = ref<Error | undefined>();
  const dimensions = ref({ cols: 80, rows: 24 });

  let streamAbortController: AbortController | undefined;
  let currentOptions: UseTerminalOptions | undefined;
  let streamGen = 0;

  const proxy = (r: RPCClient) => r.createProxy<TerminalManagerInterface>(namespaces.terminalManagerRpc);

  async function connect(options?: UseTerminalOptions): Promise<void> {
    if (isConnecting.value || isConnected.value) return;

    isConnecting.value = true;
    error.value = undefined;
    currentOptions = options;

    try {
      const session = await rpcCall(rpc, (r) =>
        proxy(r).createSession({
          cols: options?.cols ?? 80,
          rows: options?.rows ?? 24,
          cwd: options?.cwd,
          shell: options?.shell,
          env: options?.env,
        }),
      );

      sessionId.value = session.sessionId;
      dimensions.value = session.dimensions;
      isConnected.value = true;

      streamAbortController = new AbortController();
      const gen = ++streamGen;
      consumeOutputStream(session.sessionId, options, gen);
    } catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err));
      options?.onError?.(error.value);
    } finally {
      isConnecting.value = false;
    }
  }

  async function consumeOutputStream(sid: string, options: UseTerminalOptions | undefined, gen: number): Promise<void> {
    try {
      // Async iterator — pin to the rpc-snapshot active at stream-start.
      // A subsequent endpoint-swap bumps streamGen and the loop bails on the
      // next iteration; rpcCall doesn't apply here since this isn't one-shot.
      const current = rpc.value;
      if (!current) return;

      for await (const chunk of proxy(current).generateOutput(sid)) {
        if (gen !== streamGen || streamAbortController?.signal.aborted) break;
        options?.onData?.(chunk);
      }
    } catch (err) {
      if (gen === streamGen && !streamAbortController?.signal.aborted) {
        error.value = err instanceof Error ? err : new Error(String(err));
        options?.onError?.(error.value);
      }
    } finally {
      // Only flip state for the active generation. The endpoint-changed
      // handler bumps streamGen before recovery starts; a stale finalizer
      // here would otherwise set isConnected=false right after the
      // recovery path already set it to true on the new client.
      if (gen === streamGen && !streamAbortController?.signal.aborted) {
        isConnected.value = false;
        options?.onClose?.();
      }
    }
  }

  async function write(data: string): Promise<void> {
    if (!sessionId.value || !isConnected.value) return;
    try {
      await rpcCall(rpc, (r) => proxy(r).writeInput(sessionId.value!, data));
    } catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err));
      currentOptions?.onError?.(error.value);
    }
  }

  async function resize(dims: { cols: number; rows: number }): Promise<void> {
    if (!sessionId.value || !isConnected.value) return;
    try {
      await rpcCall(rpc, (r) => proxy(r).resize(sessionId.value!, dims));
      dimensions.value = dims;
    } catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err));
      currentOptions?.onError?.(error.value);
    }
  }

  async function close(): Promise<void> {
    streamAbortController?.abort();
    streamGen++;

    if (sessionId.value) {
      try {
        await rpcCall(rpc, (r) => proxy(r).closeSession(sessionId.value!), { awaitConnect: false, maxRetries: 0 });
      } catch {
        // Ignore — server may already have torn down the session
      }
    }

    sessionId.value = undefined;
    isConnected.value = false;
    currentOptions = undefined;
  }

  function handleReconnected(): void {
    if (!sessionId.value && !isConnected.value) return;
    const savedOptions = currentOptions;
    streamAbortController?.abort();
    streamGen++;
    sessionId.value = undefined;
    isConnected.value = false;
    currentOptions = undefined;
    savedOptions?.onClose?.();
    if (savedOptions) {
      connect(savedOptions);
    }
  }

  cameraUi.on('reconnected', handleReconnected);

  tryOnScopeDispose(() => {
    cameraUi.off('reconnected', handleReconnected);
    close();
  });

  return {
    sessionId: readonly(sessionId),
    isConnected: readonly(isConnected),
    isConnecting: readonly(isConnecting),
    isClientConnected: readonly(isClientConnected),
    error: readonly(error),
    dimensions: readonly(dimensions),
    connect,
    write,
    resize,
    close,
  };
}
