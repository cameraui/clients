import { afterEach, describe, expect, it, vi } from 'vitest';
import { shallowRef } from 'vue';

import { clearPluginIdCache, forgetPluginId, resolvePluginId } from '../resolvePluginId.js';

import type { RPCClient } from '@camera.ui/rpc';

afterEach(() => {
  clearPluginIdCache();
});

describe('resolvePluginId', () => {
  it('asks the server again for a plugin whose id was forgotten', async () => {
    let id = 'id-1';
    const getPlugin = vi.fn(async (name: string) => ({ id, name }));
    const rpc = shallowRef({ createProxy: () => ({ getPlugin }) } as unknown as RPCClient);

    expect(await resolvePluginId(rpc, 'tuya')).toBe('id-1');
    expect(await resolvePluginId(rpc, 'tuya')).toBe('id-1');
    expect(getPlugin).toHaveBeenCalledTimes(1);

    id = 'id-2';
    forgetPluginId('tuya');

    expect(await resolvePluginId(rpc, 'tuya')).toBe('id-2');
    expect(getPlugin).toHaveBeenCalledTimes(2);
  });
});
