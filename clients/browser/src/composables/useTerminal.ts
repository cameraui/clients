import { tryOnScopeDispose } from '@vueuse/core';
import { readonly, ref, shallowRef } from 'vue';

import { NamespaceManager } from '../server/index.js';
import { useCameraUi } from './useCameraUi.js';
import { rpcCall } from './useRpc.js';

import type { RPCClient } from '@camera.ui/rpc';
import type { Ref, ShallowRef } from 'vue';
import type { TerminalManagerInterface, TerminalOptions, TerminalSessionInfo, TerminalSessionUpdate } from '../server/index.js';

export interface UseTerminalOptions extends TerminalOptions {
  sessionId?: string;
  onData?: (data: Uint8Array) => void;
  onReplay?: () => void;
  onSession?: (session: TerminalSessionInfo) => void;
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
  persistent: Readonly<Ref<boolean>>;

  connect: (options?: UseTerminalOptions) => Promise<void>;
  write: (data: string) => Promise<void>;
  resize: (dimensions: { cols: number; rows: number }) => Promise<void>;
  setPersistent: (persistent: boolean) => Promise<void>;
  rename: (name: string) => Promise<void>;
  close: () => Promise<void>;
  terminate: () => Promise<void>;
}

export interface UseTerminalSessionsReturn {
  list: () => Promise<TerminalSessionInfo[]>;
}

type TerminalProxy = ReturnType<typeof terminalProxy>;

export function useTerminal(): UseTerminalReturn {
  const cameraUi = useCameraUi();
  const { rpc, isConnected: isClientConnected } = cameraUi;

  const sessionId = shallowRef<string | undefined>();
  const isConnected = ref(false);
  const isConnecting = ref(false);
  const error = ref<Error | undefined>();
  const dimensions = ref({ cols: 80, rows: 24 });
  const persistent = ref(false);

  let streamAbortController: AbortController | undefined;
  let currentOptions: UseTerminalOptions | undefined;
  let streamGen = 0;
  let stream: AsyncGenerator<Uint8Array> | undefined;
  let streamClient: RPCClient | undefined;
  let wentOffline = false;
  let keptAcrossBlip = false;

  async function connect(options?: UseTerminalOptions): Promise<void> {
    if (isConnecting.value || isConnected.value) return;

    isConnecting.value = true;
    error.value = undefined;
    currentOptions = options;

    try {
      const { session, attached } = await openSession(options);

      sessionId.value = session.sessionId;
      dimensions.value = session.dimensions;
      persistent.value = session.persistent;
      isConnected.value = true;
      options?.onSession?.(session);

      streamAbortController = new AbortController();
      wentOffline = false;
      keptAcrossBlip = false;
      const gen = ++streamGen;
      if (attached) options?.onReplay?.();
      consumeOutputStream(session.sessionId, options, gen);
      if (attached && options?.cols && options.rows) resize({ cols: options.cols, rows: options.rows });
    } catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err));
      options?.onError?.(error.value);
    } finally {
      isConnecting.value = false;
    }
  }

  async function openSession(options?: UseTerminalOptions): Promise<{ session: TerminalSessionInfo; attached: boolean }> {
    if (options?.sessionId) {
      const kept = await rpcCall(rpc, (r) => terminalProxy(r).listSessions());
      const session = kept.find((candidate) => candidate.sessionId === options.sessionId);
      if (session) return { session, attached: true };
    }

    // a lost reply may still have started a shell, a retry would start a second one
    const session = await rpcCall(
      rpc,
      (r) =>
        terminalProxy(r).createSession({
          cols: options?.cols ?? 80,
          rows: options?.rows ?? 24,
          cwd: options?.cwd,
          shell: options?.shell,
          env: options?.env,
          name: options?.name,
          persistent: options?.persistent,
        }),
      { maxRetries: 0 },
    );
    return { session, attached: false };
  }

  async function consumeOutputStream(sid: string, options: UseTerminalOptions | undefined, gen: number): Promise<void> {
    try {
      // the stream stays on the client it started on, rpcCall does not apply to it
      const current = rpc.value;
      if (!current) return;

      const output = terminalProxy(current).generateOutput(sid);
      stream = output;
      streamClient = current;
      for await (const chunk of output) {
        if (gen !== streamGen || streamAbortController?.signal.aborted) break;
        options?.onData?.(chunk);
      }
    } catch (err) {
      if (gen === streamGen && !streamAbortController?.signal.aborted) {
        if (keptAcrossBlip) {
          restart();
          return;
        }
        error.value = err instanceof Error ? err : new Error(String(err));
        options?.onError?.(error.value);
      }
    } finally {
      // a stale finalizer would clear isConnected after recovery set it on the new client
      if (gen === streamGen && !streamAbortController?.signal.aborted) {
        isConnected.value = false;
        if (!persistent.value) closeRemote(sid);
        options?.onClose?.();
      }
    }
  }

  async function write(data: string): Promise<void> {
    await callSession((api, sid) => api.writeInput(sid, data));
  }

  async function resize(dims: { cols: number; rows: number }): Promise<void> {
    if (await callSession((api, sid) => api.resize(sid, dims))) {
      dimensions.value = dims;
    }
  }

  async function setPersistent(value: boolean): Promise<void> {
    persistent.value = value;
    await update({ persistent: value });
  }

  async function rename(name: string): Promise<void> {
    await update({ name });
  }

  function update(change: TerminalSessionUpdate): Promise<boolean> {
    return callSession((api, sid) => api.updateSession(sid, change));
  }

  async function callSession(call: (api: TerminalProxy, sid: string) => Promise<void>): Promise<boolean> {
    const sid = sessionId.value;
    if (!sid || !isConnected.value) return false;
    try {
      await rpcCall(rpc, (r) => call(terminalProxy(r), sid));
      return true;
    } catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err));
      currentOptions?.onError?.(error.value);
      return false;
    }
  }

  async function close(): Promise<void> {
    stopStream();

    // a kept session stays on the server for the next attach
    if (sessionId.value && !persistent.value) {
      await closeRemote(sessionId.value);
    }

    sessionId.value = undefined;
    isConnected.value = false;
    currentOptions = undefined;
  }

  async function terminate(): Promise<void> {
    persistent.value = false;
    await close();
  }

  function stopStream(): void {
    streamAbortController?.abort();
    streamGen++;
    stream?.return(undefined).catch(() => undefined);
    stream = undefined;
    streamClient = undefined;
    keptAcrossBlip = false;
  }

  function closeRemote(sid: string): Promise<void> {
    return rpcCall(rpc, (r) => terminalProxy(r).closeSession(sid), { awaitConnect: false, maxRetries: 0 }).catch(() => undefined);
  }

  function restart(): void {
    const savedOptions = currentOptions;
    const sid = sessionId.value;
    const keep = persistent.value;
    stopStream();
    if (sid && !keep) closeRemote(sid);
    sessionId.value = undefined;
    isConnected.value = false;
    currentOptions = undefined;
    savedOptions?.onClose?.();
    if (savedOptions) {
      connect({ ...savedOptions, sessionId: keep ? sid : undefined, persistent: keep });
    }
  }

  function handleReconnected(): void {
    if (!sessionId.value && !isConnected.value) return;
    // under the down debounce the client stays and the nats lib re-subscribes the stream itself
    if (isConnected.value && !wentOffline && rpc.value === streamClient) {
      keptAcrossBlip = true;
      return;
    }
    restart();
  }

  function handleDisconnected(): void {
    wentOffline = true;
  }

  cameraUi.on('reconnected', handleReconnected);
  cameraUi.on('disconnected', handleDisconnected);

  tryOnScopeDispose(() => {
    cameraUi.off('reconnected', handleReconnected);
    cameraUi.off('disconnected', handleDisconnected);
    close();
  });

  return {
    sessionId: readonly(sessionId),
    isConnected: readonly(isConnected),
    isConnecting: readonly(isConnecting),
    isClientConnected: readonly(isClientConnected),
    error: readonly(error),
    dimensions: readonly(dimensions),
    persistent: readonly(persistent),
    connect,
    write,
    resize,
    setPersistent,
    rename,
    close,
    terminate,
  };
}

export function useTerminalSessions(): UseTerminalSessionsReturn {
  const { rpc } = useCameraUi();

  return {
    list: () => rpcCall(rpc, (r) => terminalProxy(r).listSessions()),
  };
}

function terminalProxy(r: RPCClient) {
  return r.createProxy<TerminalManagerInterface>(NamespaceManager.terminalManagerNamespaces().terminalManagerRpc);
}
