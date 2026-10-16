import { createRPCClient } from '@camera.ui/rpc';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createNatsTransport } from '../nats.js';

import type { ConnectionTarget } from '../../core/types.js';
import type { NatsTransport } from '../nats.js';

vi.mock('@camera.ui/rpc', () => ({ createRPCClient: vi.fn() }));

const A: ConnectionTarget = { endpoint: { url: 'https://nvr.local:3443', mode: 'direct-lan' }, tokens: { access: 'at-1' } };
const A_ROTATED: ConnectionTarget = { ...A, tokens: { access: 'at-2' } };

interface FakeClient {
  connect: () => Promise<void>;
  abortClose: () => void;
  setServers: (servers: string[]) => void;
  status: () => AsyncIterable<unknown>;
  emitStatus: (event: unknown) => void;
}

function fakeClient(connect: () => Promise<void>): FakeClient {
  const pending: unknown[] = [];
  let wake: (() => void) | undefined;
  return {
    connect,
    abortClose: () => {},
    setServers: () => {},
    status: () => ({
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (pending.length > 0) yield pending.shift();
          await new Promise<void>((resolve) => (wake = resolve));
        }
      },
    }),
    emitStatus: (event) => {
      pending.push(event);
      wake?.();
    },
  };
}

describe('nats transport: auth errors', () => {
  let transport: NatsTransport | undefined;

  afterEach(async () => {
    await transport?.dispose();
    transport = undefined;
    vi.mocked(createRPCClient).mockReset();
  });

  it('a 4401 at connect names the token the dial carried', async () => {
    const rejected = Object.assign(new Error('unauthorized'), { wsCloseCode: 4401 });
    vi.mocked(createRPCClient).mockImplementation(() => fakeClient(() => Promise.reject(rejected)) as never);
    transport = createNatsTransport();
    const authErrors = vi.fn();
    transport.on('auth-error', authErrors);

    await expect(transport.apply(A)).rejects.toBe(rejected);

    expect(authErrors).toHaveBeenCalledWith(expect.objectContaining({ access: 'at-1' }));
  });

  it.each([
    { shape: 'error', event: { type: 'error', error: Object.assign(new Error('connection closed'), { wsCloseCode: 4401 }) } },
    { shape: 'legacy data', event: { type: 'error', data: { message: 'unauthorized', wsCloseCode: 4401 } } },
  ])('a 4401 on reconnect names the token of the current server list ($shape status)', async ({ event }) => {
    const client = fakeClient(() => Promise.resolve());
    vi.mocked(createRPCClient).mockImplementation(() => client as never);
    transport = createNatsTransport();
    const authErrors = vi.fn();
    transport.on('auth-error', authErrors);
    await transport.apply(A);
    await transport.apply(A_ROTATED);

    client.emitStatus(event);

    await vi.waitFor(() => expect(authErrors).toHaveBeenCalledWith(expect.objectContaining({ access: 'at-2' })));
  });
});
