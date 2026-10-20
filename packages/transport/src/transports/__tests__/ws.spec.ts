import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWsTransport } from '../ws.js';

import type { ConnectionTarget } from '../../core/types.js';

const T1: ConnectionTarget = {
  endpoint: { url: 'https://nvr.local:3443', mode: 'direct-lan' },
  tokens: { access: 'at-1' },
};
const T1_TOKEN2: ConnectionTarget = {
  endpoint: { url: 'https://nvr.local:3443', mode: 'direct-lan' },
  tokens: { access: 'at-2' },
};
const T2: ConnectionTarget = {
  endpoint: { url: 'https://nvr.example.com', mode: 'direct-wan' },
  tokens: { access: 'at-1', proxySession: 'ps-1' },
};

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readyState = 0;
  binaryType: 'arraybuffer' | 'blob' = 'blob';
  onopen: ((this: WebSocket, ev: Event) => unknown) | null = null;
  onclose: ((this: WebSocket, ev: CloseEvent) => unknown) | null = null;
  onmessage: ((this: WebSocket, ev: MessageEvent) => unknown) | null = null;
  onerror: ((this: WebSocket, ev: Event) => unknown) | null = null;
  sent: unknown[] = [];

  constructor(
    public readonly url: string,
    public readonly protocols?: string | string[],
  ) {
    MockWebSocket.instances.push(this);
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.call(this as unknown as WebSocket, { code, reason, wasClean: true } as CloseEvent);
  }

  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.call(this as unknown as WebSocket, new Event('open'));
  }

  simulateMessage(payload: unknown): void {
    this.onmessage?.call(this as unknown as WebSocket, { data: payload } as MessageEvent);
  }

  simulateError(): void {
    this.onerror?.call(this as unknown as WebSocket, new Event('error'));
  }

  simulateServerClose(code = 1006, reason = 'lost'): void {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.call(this as unknown as WebSocket, { code, reason, wasClean: false } as CloseEvent);
  }
}

function setup() {
  MockWebSocket.instances = [];
  const t = createWsTransport({ webSocketCtor: MockWebSocket as unknown as typeof WebSocket });
  return { t, instances: () => MockWebSocket.instances };
}

describe('createWsTransport — apply lifecycle', () => {
  it('starts with health.up = false and 0 handles', () => {
    const { t } = setup();
    expect(t.health().up).toBe(false);
    expect(t.handleCount).toBe(0);
  });

  it('open() before apply() registers handle but does not create a socket', () => {
    const { t, instances } = setup();
    t.open({ path: '/api/stream' });
    expect(t.handleCount).toBe(1);
    expect(instances()).toHaveLength(0);
  });

  it('apply(target) after open() creates the socket with token query', async () => {
    const { t, instances } = setup();
    t.open({ path: '/api/stream', query: { src: 'cam-1' } });
    await t.apply(T1);
    expect(instances()).toHaveLength(1);
    const url = new URL(instances()[0]!.url);
    expect(url.protocol).toBe('wss:');
    expect(url.hostname).toBe('nvr.local');
    expect(url.pathname).toBe('/api/stream');
    expect(url.searchParams.get('src')).toBe('cam-1');
    expect(url.searchParams.get('token')).toBe('at-1');
  });

  it('open() after apply(target) creates the socket immediately', async () => {
    const { t, instances } = setup();
    await t.apply(T1);
    t.open({ path: '/api/stream' });
    expect(instances()).toHaveLength(1);
  });

  it('keeps the cloud proxy session out of the stream URL', async () => {
    const { t, instances } = setup();
    await t.apply(T2);
    t.open({ path: '/api/stream' });
    const url = new URL(instances()[0]!.url);
    expect(url.searchParams.has('session')).toBe(false);
    expect(url.searchParams.get('token')).toBe('at-1');
  });

  it('emits "up" when the first handle opens', async () => {
    const { t, instances } = setup();
    const up = vi.fn();
    t.on('up', up);
    await t.apply(T1);
    t.open({ path: '/s' });
    expect(up).not.toHaveBeenCalled();
    instances()[0]!.simulateOpen();
    expect(up).toHaveBeenCalledOnce();
  });

  it('endpoint change closes existing sockets and reopens with new URL', async () => {
    const { t, instances } = setup();
    await t.apply(T1);
    t.open({ path: '/s' });
    const first = instances()[0]!;
    first.simulateOpen();

    await t.apply(T2);
    expect(instances()).toHaveLength(2);
    expect(first.readyState).toBe(MockWebSocket.CLOSED);
    const second = instances()[1]!;
    expect(new URL(second.url).hostname).toBe('nvr.example.com');
  });

  it('token-only change leaves live sockets alone (handshake-auth is one-shot)', async () => {
    const { t, instances } = setup();
    await t.apply(T1);
    t.open({ path: '/s' });
    const first = instances()[0]!;
    first.simulateOpen();

    await t.apply(T1_TOKEN2);
    expect(instances()).toHaveLength(1);
    expect(first.readyState).toBe(MockWebSocket.OPEN);
  });

  it('a 4401 close names the token the socket dialed with', async () => {
    const { t, instances } = setup();
    const authError = vi.fn();
    t.on('auth-error', authError);
    await t.apply(T1);
    t.open({ path: '/s' });
    instances()[0]!.simulateOpen();
    await t.apply(T1_TOKEN2);

    instances()[0]!.simulateServerClose(4401, 'unauthorized');

    expect(authError).toHaveBeenCalledWith(expect.objectContaining({ access: 'at-1' }));
  });

  it('token-only change: subsequent open() uses the fresh token', async () => {
    const { t, instances } = setup();
    await t.apply(T1);
    await t.apply(T1_TOKEN2);
    t.open({ path: '/s' });
    expect(instances()).toHaveLength(1);
    expect(new URL(instances()[0]!.url).searchParams.get('token')).toBe('at-2');
  });

  it('apply(null) closes all sockets and emits down', async () => {
    const { t, instances } = setup();
    await t.apply(T1);
    t.open({ path: '/s' });
    const sock = instances()[0]!;
    sock.simulateOpen();

    const down = vi.fn();
    t.on('down', down);
    await t.apply(null);

    expect(sock.readyState).toBe(MockWebSocket.CLOSED);
    expect(down).toHaveBeenCalledWith({ reason: 'detached' });
  });

  it('handle.close() closes the socket and fires the close listener', async () => {
    const { t, instances } = setup();
    await t.apply(T1);
    const handle = t.open({ path: '/s' });
    instances()[0]!.simulateOpen();

    const onClose = vi.fn();
    handle.on('close', onClose);
    handle.close(1000, 'bye');

    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ code: 1000, reason: 'bye' }));
    expect(instances()[0]!.readyState).toBe(MockWebSocket.CLOSED);
  });

  it('handle.dispose() removes it from the transport', async () => {
    const { t, instances } = setup();
    await t.apply(T1);
    const handle = t.open({ path: '/s' });
    expect(t.handleCount).toBe(1);

    handle.dispose();
    expect(t.handleCount).toBe(0);
    expect(instances()[0]!.readyState).toBe(MockWebSocket.CLOSED);

    await t.apply(T2);
    // disposed handle must not be reopened against the new target
    expect(instances()).toHaveLength(1);
  });

  it('handle.send() throws when the socket is not OPEN', async () => {
    const { t } = setup();
    await t.apply(T1);
    const handle = t.open({ path: '/s' });
    expect(() => handle.send('x')).toThrow(/not open/);
  });

  it('handle.send() works once the socket is open', async () => {
    const { t, instances } = setup();
    await t.apply(T1);
    const handle = t.open({ path: '/s' });
    instances()[0]!.simulateOpen();
    handle.send('hello');
    expect(instances()[0]!.sent).toEqual(['hello']);
  });

  it('forwards messages from socket to handle listener', async () => {
    const { t, instances } = setup();
    await t.apply(T1);
    const handle = t.open({ path: '/s' });
    instances()[0]!.simulateOpen();

    const onMsg = vi.fn();
    handle.on('message', onMsg);
    instances()[0]!.simulateMessage({ foo: 1 });
    expect(onMsg).toHaveBeenCalledWith(expect.objectContaining({ data: { foo: 1 } }));
  });

  it('forwards errors from socket to handle listener', async () => {
    const { t, instances } = setup();
    await t.apply(T1);
    const handle = t.open({ path: '/s' });
    instances()[0]!.simulateOpen();

    const onErr = vi.fn();
    handle.on('error', onErr);
    instances()[0]!.simulateError();
    expect(onErr).toHaveBeenCalledOnce();
  });

  it('dispose() closes all sockets and prevents further open()', async () => {
    const { t, instances } = setup();
    await t.apply(T1);
    t.open({ path: '/s' });
    await t.dispose();
    expect(instances()[0]!.readyState).toBe(MockWebSocket.CLOSED);
    expect(() => t.open({ path: '/x' })).toThrow(/disposed/);
  });

  it('binaryType option is forwarded to the socket', async () => {
    const { t, instances } = setup();
    await t.apply(T1);
    t.open({ path: '/s', binaryType: 'arraybuffer' });
    expect(instances()[0]!.binaryType).toBe('arraybuffer');
  });

  it('disposing a handle from within its close callback does not crash recycle', async () => {
    const { t, instances } = setup();
    await t.apply(T1);
    const handle = t.open({ path: '/s' });
    instances()[0]!.simulateOpen();
    handle.on('close', () => handle.dispose());

    await t.apply(T2);
    // the handle was disposed mid-recycle, only the original socket exists
    expect(instances()).toHaveLength(1);
    expect(t.handleCount).toBe(0);
  });
});

describe('createWsTransport — resolveUrl', () => {
  async function flush(): Promise<void> {
    await new Promise((r) => setTimeout(r, 0));
  }

  it('opens the socket on the resolved URL', async () => {
    MockWebSocket.instances = [];
    const resolveUrl = vi.fn(async ({ defaultUrl }: { defaultUrl: string }) => `${defaultUrl}&authSig=sig`);
    const t = createWsTransport({ webSocketCtor: MockWebSocket as unknown as typeof WebSocket, resolveUrl });
    t.open({ path: '/api/stream', query: { src: 'cam-1' } });
    await t.apply(T1);
    await flush();
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0]!.url).toContain('authSig=sig');
    expect(resolveUrl.mock.calls[0]![0]).toMatchObject({ target: T1, spec: { path: '/api/stream' } });
  });

  it('drops a resolved URL when the handle was closed meanwhile', async () => {
    MockWebSocket.instances = [];
    let release: (url: string) => void = () => {};
    const resolveUrl = () => new Promise<string>((r) => (release = r));
    const t = createWsTransport({ webSocketCtor: MockWebSocket as unknown as typeof WebSocket, resolveUrl });
    const h = t.open({ path: '/api/stream' });
    await t.apply(T1);
    h.dispose();
    release('wss://late');
    await flush();
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it('delivers a synthetic close when resolving fails', async () => {
    MockWebSocket.instances = [];
    const t = createWsTransport({
      webSocketCtor: MockWebSocket as unknown as typeof WebSocket,
      resolveUrl: async () => {
        throw new Error('no sign');
      },
    });
    const h = t.open({ path: '/api/stream' });
    const close = vi.fn();
    h.on('close', close);
    await t.apply(T1);
    await flush();
    expect(MockWebSocket.instances).toHaveLength(0);
    expect(close).toHaveBeenCalledWith({ code: 4003, reason: 'resolve-failed', wasClean: false });
  });

  describe('with a resolver that hangs', () => {
    function pendingResolver() {
      const calls: { target: ConnectionTarget; release: (url: string) => void }[] = [];
      const resolveUrl = ({ target }: { target: ConnectionTarget }) =>
        new Promise<string>((release) => {
          calls.push({ target, release });
        });
      return { resolveUrl, calls };
    }

    function make(resolveUrl: (ctx: { target: ConnectionTarget }) => Promise<string>) {
      MockWebSocket.instances = [];
      return createWsTransport({ webSocketCtor: MockWebSocket as unknown as typeof WebSocket, resolveUrl });
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    it('closes the handle with resolve-timeout when the resolver never answers', async () => {
      vi.useFakeTimers();
      const t = make(() => new Promise<string>(() => {}));
      const h = t.open({ path: '/api/stream' });
      const close = vi.fn();
      h.on('close', close);
      await t.apply(T1);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(close).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledWith({ code: 4003, reason: 'resolve-timeout', wasClean: false });
      expect(MockWebSocket.instances).toHaveLength(0);
      await t.dispose();
    });

    it('drops a URL that arrives after the timeout', async () => {
      vi.useFakeTimers();
      const { resolveUrl, calls } = pendingResolver();
      const t = make(resolveUrl);
      const h = t.open({ path: '/api/stream' });
      const close = vi.fn();
      h.on('close', close);
      await t.apply(T1);
      await vi.advanceTimersByTimeAsync(10_000);
      calls[0]!.release('wss://late');
      await vi.advanceTimersByTimeAsync(0);
      expect(MockWebSocket.instances).toHaveLength(0);
      expect(close).toHaveBeenCalledTimes(1);
      await t.dispose();
    });

    it('leaves no timer once the URL resolved', async () => {
      vi.useFakeTimers();
      const { resolveUrl, calls } = pendingResolver();
      const t = make(resolveUrl);
      t.open({ path: '/api/stream' });
      await t.apply(T1);
      calls[0]!.release('wss://signed');
      await vi.advanceTimersByTimeAsync(0);
      expect(MockWebSocket.instances).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
      await t.dispose();
    });

    it('closes only once and leaves no timer when the resolver rejects', async () => {
      vi.useFakeTimers();
      const t = make(async () => {
        throw new Error('no sign');
      });
      const h = t.open({ path: '/api/stream' });
      const close = vi.fn();
      h.on('close', close);
      await t.apply(T1);
      await vi.advanceTimersByTimeAsync(0);
      expect(close).toHaveBeenCalledWith({ code: 4003, reason: 'resolve-failed', wasClean: false });
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(close).toHaveBeenCalledTimes(1);
      await t.dispose();
    });

    it('leaves no timer when the handle is disposed while resolving', async () => {
      vi.useFakeTimers();
      const t = make(pendingResolver().resolveUrl);
      const h = t.open({ path: '/api/stream' });
      await t.apply(T1);
      expect(vi.getTimerCount()).toBe(1);
      h.dispose();
      expect(vi.getTimerCount()).toBe(0);
      await t.dispose();
    });

    it('leaves no timer when the transport is disposed while resolving', async () => {
      vi.useFakeTimers();
      const t = make(pendingResolver().resolveUrl);
      t.open({ path: '/api/stream' });
      await t.apply(T1);
      await t.dispose();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('resolves again for the new token when the token changes while resolving', async () => {
      vi.useFakeTimers();
      const { resolveUrl, calls } = pendingResolver();
      const t = make(resolveUrl);
      const h = t.open({ path: '/api/stream' });
      const close = vi.fn();
      h.on('close', close);
      await t.apply(T1);
      await t.apply(T1_TOKEN2);
      calls[0]!.release('wss://signed-for-at-1');
      await vi.advanceTimersByTimeAsync(0);
      expect(MockWebSocket.instances).toHaveLength(0);
      expect(calls).toHaveLength(2);
      expect(calls[1]!.target).toBe(T1_TOKEN2);
      calls[1]!.release('wss://signed-for-at-2');
      await vi.advanceTimersByTimeAsync(0);
      expect(MockWebSocket.instances.map((ws) => ws.url)).toEqual(['wss://signed-for-at-2']);
      expect(close).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      await t.dispose();
    });
  });
});
