import { describe, expect, it, vi } from 'vitest';

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

  it('proxy session is appended as `session` query param', async () => {
    const { t, instances } = setup();
    await t.apply(T2);
    t.open({ path: '/api/stream' });
    const url = new URL(instances()[0]!.url);
    expect(url.searchParams.get('session')).toBe('ps-1');
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
    // handle was disposed mid-recycle — only the original socket exists
    expect(instances()).toHaveLength(1);
    expect(t.handleCount).toBe(0);
  });
});
