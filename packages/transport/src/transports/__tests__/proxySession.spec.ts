import { describe, expect, it, vi } from 'vitest';

import { createNatsTransport } from '../nats.js';
import { createSocketioTransport } from '../socketio.js';

import type { ConnectionTarget } from '../../core/types.js';

const lib = vi.hoisted(() => {
  class FakeSocket {
    auth: unknown;
    connected = false;

    constructor(opts?: { auth?: unknown }) {
      this.auth = opts?.auth;
    }

    on(): this {
      return this;
    }

    off(): this {
      return this;
    }

    connect(): this {
      return this;
    }

    disconnect(): this {
      return this;
    }

    removeAllListeners(): this {
      return this;
    }
  }

  class FakeManager {
    static last: FakeManager | null = null;
    readonly sockets: FakeSocket[] = [];

    constructor(
      readonly uri: string,
      readonly opts: { query?: Record<string, string> },
    ) {
      FakeManager.last = this;
    }

    on(): this {
      return this;
    }

    socket(_nsp: string, opts?: { auth?: unknown }): FakeSocket {
      const sock = new FakeSocket(opts);
      this.sockets.push(sock);
      return sock;
    }

    _close(): void {}
  }

  return { FakeManager };
});

vi.mock('socket.io-client', () => ({ Manager: lib.FakeManager }));

const VIA_CLOUD: ConnectionTarget = {
  endpoint: { url: 'https://home.example.com:3443', mode: 'direct-wan' },
  tokens: { access: 'at-1', proxySession: 'ps-1' },
};

describe('transports keep the cloud proxy session off direct connections', () => {
  it('nats leaves it out of the proxy URL', async () => {
    let servers: readonly string[] = [];
    const t = createNatsTransport({
      resolveServers: ({ defaultServers }) => {
        servers = defaultServers;
        throw new Error('stop before dialing');
      },
    });

    const applying = t.apply(VIA_CLOUD);
    await vi.waitFor(() => expect(servers).toHaveLength(1));
    const url = new URL(servers[0]!);
    expect(url.searchParams.get('token')).toBe('at-1');
    expect(url.searchParams.has('session')).toBe(false);
    await t.dispose();
    await applying;
  });

  it('socket.io leaves it out of the handshake query and auth', async () => {
    const t = createSocketioTransport();

    await t.apply(VIA_CLOUD);

    const manager = lib.FakeManager.last!;
    expect(manager.opts.query ?? {}).not.toHaveProperty('session');
    expect(manager.sockets[0]!.auth).toEqual({ token: 'Bearer at-1' });
    await t.dispose();
  });
});
