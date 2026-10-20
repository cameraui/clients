import { describe, expect, it, vi } from 'vitest';

import { createKernel } from '../../core/kernel.js';
import { attachWorkerBridge } from '../workerBridge.js';

import type { ConnectionPhase, Endpoint, ReducerContext, Tokens } from '../../core/types.js';
import type { KernelSyncMessage, WorkerHost, WorkerMessage } from '../../worker/protocol.js';

const LAN: Endpoint = { url: 'https://nvr.local', mode: 'direct-lan' };
const TOKENS: Tokens = { access: 'at-1' };

function makeCtx(): ReducerContext {
  return { now: () => Date.now() };
}

function onlinePhase(): ConnectionPhase {
  return {
    kind: 'online',
    instanceId: 'a',
    target: { endpoint: LAN, tokens: TOKENS },
  };
}

class FakeHost implements WorkerHost {
  readonly sent: WorkerMessage[] = [];
  private listeners = new Set<(event: MessageEvent<WorkerMessage>) => void>();
  postFails = false;

  postMessage(message: WorkerMessage): void {
    if (this.postFails) throw new Error('host closed');
    this.sent.push(message);
  }

  addEventListener(_type: 'message', listener: (event: MessageEvent<WorkerMessage>) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'message', listener: (event: MessageEvent<WorkerMessage>) => void): void {
    this.listeners.delete(listener);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  deliver(msg: WorkerMessage): void {
    const event = new MessageEvent<WorkerMessage>('message', { data: msg });
    for (const l of [...this.listeners]) l(event);
  }
}

describe('attachWorkerBridge', () => {
  it('broadcasts on every kernel phase change', () => {
    const kernel = createKernel({ context: makeCtx() });
    const host = new FakeHost();
    const bridge = attachWorkerBridge({ kernel, hosts: () => [host] });

    kernel.dispatch({ type: 'BOOT', instanceId: 'a' });
    expect(host.sent.length).toBe(1);
    expect((host.sent[0] as KernelSyncMessage).phase.kind).toBe('discovering');

    kernel.dispatch({ type: 'PROBE_SUCCEEDED', endpoint: LAN, tokens: TOKENS });
    expect(host.sent.length).toBe(2);
    expect((host.sent[1] as KernelSyncMessage).phase.kind).toBe('online');

    bridge.detach();
  });

  it('uses monotonic generations', () => {
    const kernel = createKernel({ context: makeCtx() });
    const host = new FakeHost();
    attachWorkerBridge({ kernel, hosts: () => [host] });

    kernel.dispatch({ type: 'BOOT', instanceId: 'a' });
    kernel.dispatch({ type: 'PROBE_SUCCEEDED', endpoint: LAN, tokens: TOKENS });

    const gens = host.sent.map((m) => (m as KernelSyncMessage).generation);
    expect(gens).toEqual([1, 2]);
  });

  it('broadcasts to ALL hosts on each change', () => {
    const kernel = createKernel({ context: makeCtx() });
    const a = new FakeHost();
    const b = new FakeHost();
    const c = new FakeHost();
    attachWorkerBridge({ kernel, hosts: () => [a, b, c] });

    kernel.dispatch({ type: 'BOOT', instanceId: 'a' });
    expect(a.sent.length).toBe(1);
    expect(b.sent.length).toBe(1);
    expect(c.sent.length).toBe(1);
    expect((a.sent[0] as KernelSyncMessage).generation).toBe(1);
    expect((b.sent[0] as KernelSyncMessage).generation).toBe(1);
    expect((c.sent[0] as KernelSyncMessage).generation).toBe(1);
  });

  it('honors a dynamic hosts() — newly added host gets next broadcast', () => {
    const kernel = createKernel({ context: makeCtx() });
    const hosts: FakeHost[] = [new FakeHost()];
    const bridge = attachWorkerBridge({ kernel, hosts: () => hosts });

    kernel.dispatch({ type: 'BOOT', instanceId: 'a' });
    expect(hosts[0]!.sent.length).toBe(1);

    const newHost = new FakeHost();
    hosts.push(newHost);

    kernel.dispatch({ type: 'PROBE_SUCCEEDED', endpoint: LAN, tokens: TOKENS });
    expect(hosts[0]!.sent.length).toBe(2);
    expect(newHost.sent.length).toBe(1); // only the second broadcast
    expect((newHost.sent[0] as KernelSyncMessage).phase.kind).toBe('online');

    bridge.detach();
  });

  it('syncHost(host) sends the current phase to one host immediately', () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlinePhase() });
    const host = new FakeHost();
    const bridge = attachWorkerBridge({ kernel, hosts: () => [host] });

    bridge.syncHost(host);

    expect(host.sent.length).toBe(1);
    expect((host.sent[0] as KernelSyncMessage).phase.kind).toBe('online');
  });

  it('syncAll() broadcasts the current phase to all hosts', () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlinePhase() });
    const a = new FakeHost();
    const b = new FakeHost();
    const bridge = attachWorkerBridge({ kernel, hosts: () => [a, b] });

    bridge.syncAll();
    expect(a.sent.length).toBe(1);
    expect(b.sent.length).toBe(1);
  });

  it('revalidateWorkers() broadcasts a stateless kernel-revalidate to all hosts', () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlinePhase() });
    const a = new FakeHost();
    const b = new FakeHost();
    const bridge = attachWorkerBridge({ kernel, hosts: () => [a, b] });

    bridge.revalidateWorkers();
    expect(a.sent).toEqual([{ type: 'kernel-revalidate' }]);
    expect(b.sent).toEqual([{ type: 'kernel-revalidate' }]);
    // not phase-gated, every call re-sends
    bridge.revalidateWorkers();
    expect(a.sent.length).toBe(2);

    bridge.detach();
  });

  it('survives a host that throws on postMessage', () => {
    const kernel = createKernel({ context: makeCtx() });
    const bad = new FakeHost();
    bad.postFails = true;
    const good = new FakeHost();
    attachWorkerBridge({ kernel, hosts: () => [bad, good] });

    expect(() => kernel.dispatch({ type: 'BOOT', instanceId: 'a' })).not.toThrow();
    expect(good.sent.length).toBe(1);
    expect(bad.sent.length).toBe(0);
  });

  it('responds to kernel-sync-request from worker when listenForResyncRequests=true', () => {
    const kernel = createKernel({ context: makeCtx(), initial: onlinePhase() });
    const host = new FakeHost();
    const bridge = attachWorkerBridge({ kernel, hosts: () => [host], listenForResyncRequests: true });

    // the first broadcast registers the host listener
    kernel.dispatch({ type: 'TOKENS_REFRESHED', tokens: { access: 'at-2' } });
    const initialCount = host.sent.length;

    host.deliver({ type: 'kernel-sync-request' });

    expect(host.sent.length).toBe(initialCount + 1);
    expect((host.sent[host.sent.length - 1] as KernelSyncMessage).phase.kind).toBe('online');

    bridge.detach();
  });

  it('does NOT subscribe to host messages when listenForResyncRequests is false (default)', () => {
    const kernel = createKernel({ context: makeCtx() });
    const host = new FakeHost();
    const addSpy = vi.spyOn(host, 'addEventListener');
    attachWorkerBridge({ kernel, hosts: () => [host] });

    kernel.dispatch({ type: 'BOOT', instanceId: 'a' });
    expect(addSpy).not.toHaveBeenCalled();
  });

  it('detach() stops broadcasts + removes host listeners', () => {
    const kernel = createKernel({ context: makeCtx() });
    const host = new FakeHost();
    const bridge = attachWorkerBridge({ kernel, hosts: () => [host], listenForResyncRequests: true });

    kernel.dispatch({ type: 'BOOT', instanceId: 'a' });
    expect(host.sent.length).toBe(1);

    bridge.detach();
    kernel.dispatch({ type: 'PROBE_SUCCEEDED', endpoint: LAN, tokens: TOKENS });
    expect(host.sent.length).toBe(1);

    host.deliver({ type: 'kernel-sync-request' });
    expect(host.sent.length).toBe(1); // listener detached
  });

  it('fires onBroadcast + onSyncHost callbacks', () => {
    const kernel = createKernel({ context: makeCtx() });
    const host = new FakeHost();
    const onBroadcast = vi.fn();
    const onSyncHost = vi.fn();
    const bridge = attachWorkerBridge({ kernel, hosts: () => [host], onBroadcast, onSyncHost });

    kernel.dispatch({ type: 'BOOT', instanceId: 'a' });
    expect(onBroadcast).toHaveBeenCalledWith(1, 1);

    bridge.syncHost(host);
    expect(onSyncHost).toHaveBeenCalledWith(2);
  });

  it('lets go of a host that left hosts() on the next broadcast', () => {
    const kernel = createKernel({ context: makeCtx() });
    const registry = new Set<FakeHost>();
    const bridge = attachWorkerBridge({ kernel, hosts: () => registry, listenForResyncRequests: true });
    const gone = new FakeHost();
    const kept = new FakeHost();
    registry.add(gone).add(kept);
    bridge.syncHost(gone);
    bridge.syncHost(kept);

    registry.delete(gone);
    kernel.dispatch({ type: 'BOOT', instanceId: 'a' });

    expect(gone.listenerCount).toBe(0);
    expect(kept.listenerCount).toBe(1);
    const sent = gone.sent.length;
    gone.deliver({ type: 'kernel-sync-request' });
    expect(gone.sent.length).toBe(sent);
  });

  it('lets go of a host that left hosts() on revalidate', () => {
    const kernel = createKernel({ context: makeCtx() });
    const registry = new Set<FakeHost>();
    const bridge = attachWorkerBridge({ kernel, hosts: () => registry, listenForResyncRequests: true });
    const gone = new FakeHost();
    registry.add(gone);
    bridge.syncHost(gone);

    registry.delete(gone);
    bridge.revalidateWorkers();

    expect(gone.listenerCount).toBe(0);
  });

  it('forgetHost drops the listener right away, a later sync wires it again', () => {
    const kernel = createKernel({ context: makeCtx() });
    const host = new FakeHost();
    const bridge = attachWorkerBridge({ kernel, hosts: () => [host], listenForResyncRequests: true });
    bridge.syncHost(host);

    bridge.forgetHost(host);
    expect(host.listenerCount).toBe(0);

    bridge.syncHost(host);
    expect(host.listenerCount).toBe(1);
  });
});

describe('attachWorkerBridge — resolve relay', () => {
  function online(): ReturnType<typeof createKernel> {
    const kernel = createKernel({ context: makeCtx() });
    kernel.dispatch({ type: 'BOOT', instanceId: 'a' });
    kernel.dispatch({ type: 'PROBE_SUCCEEDED', endpoint: LAN, tokens: TOKENS });
    return kernel;
  }

  async function flush(): Promise<void> {
    await new Promise((r) => setTimeout(r, 0));
  }

  it('answers with the resolver result using the kernel target', async () => {
    const kernel = online();
    const host = new FakeHost();
    const resolveServers = vi.fn(async () => ['wss://signed']);
    const bridge = attachWorkerBridge({ kernel, hosts: () => [host], resolveServers });
    bridge.syncHost(host);
    host.deliver({ type: 'kernel-resolve-request', id: 7, connId: 'c-1', defaultServers: ['wss://a'] });
    await flush();

    expect(resolveServers).toHaveBeenCalledWith({ target: { endpoint: LAN, tokens: TOKENS }, connId: 'c-1', defaultServers: ['wss://a'] });
    expect(host.sent.at(-1)).toEqual({ type: 'kernel-resolve-reply', id: 7, servers: ['wss://signed'] });
  });

  it('returns the defaults when no resolver is configured but resync listening is on', async () => {
    const kernel = online();
    const host = new FakeHost();
    const bridge = attachWorkerBridge({ kernel, hosts: () => [host], listenForResyncRequests: true });
    bridge.syncHost(host);
    host.deliver({ type: 'kernel-resolve-request', id: 1, connId: 'c-1', defaultServers: ['wss://a'] });
    await flush();
    expect(host.sent.at(-1)).toEqual({ type: 'kernel-resolve-reply', id: 1, servers: ['wss://a'] });
  });

  it('replies with an error while the kernel is offline or the resolver throws', async () => {
    const kernel = createKernel({ context: makeCtx() });
    const host = new FakeHost();
    const bridge = attachWorkerBridge({ kernel, hosts: () => [host], resolveServers: async () => ['x'] });
    kernel.dispatch({ type: 'BOOT', instanceId: 'a' });
    bridge.syncHost(host);
    host.deliver({ type: 'kernel-resolve-request', id: 1, connId: 'c-1', defaultServers: [] });
    await flush();
    expect(host.sent.at(-1)).toEqual({ type: 'kernel-resolve-reply', id: 1, error: 'kernel discovering' });

    kernel.dispatch({ type: 'PROBE_SUCCEEDED', endpoint: LAN, tokens: TOKENS });
    const failing = new FakeHost();
    const failingBridge = attachWorkerBridge({
      kernel,
      hosts: () => [failing],
      resolveServers: async () => {
        throw new Error('sign failed');
      },
    });
    failingBridge.syncHost(failing);
    failing.deliver({ type: 'kernel-resolve-request', id: 2, connId: 'c-1', defaultServers: [] });
    await flush();
    expect(failing.sent.at(-1)).toEqual({ type: 'kernel-resolve-reply', id: 2, error: 'sign failed' });
  });
});
