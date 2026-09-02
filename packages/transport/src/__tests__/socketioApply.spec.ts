import { describe, expect, it } from 'vitest';

import { createSocketioTransport } from '../transports/socketio.js';

import type { ConnectionTarget } from '../core/types.js';

const TARGET: ConnectionTarget = { endpoint: { url: 'https://lan.local', mode: 'direct-lan' }, tokens: { access: 'at' } };

describe('socketio transport apply', () => {
  it('retries the manager rebuild after a failed apply with the same target', async () => {
    let fail = true;
    const transport = createSocketioTransport({
      resolveQuery: async () => {
        if (fail) throw new Error('signer offline');
        return { token: 'ok' };
      },
    });

    await expect(transport.apply(TARGET)).rejects.toThrow('signer offline');
    expect(transport.manager).toBeNull();

    fail = false;
    await transport.apply(TARGET);
    expect(transport.manager).not.toBeNull();
    expect(transport.socket('/server' as never)).toBeNull();
    expect(transport.ensureSocket('/server')).not.toBeNull();

    transport.dispose();
  });
});
