import { describe, expect, it } from 'vitest';

import { endpointKey, isSameEndpoint, sortByPriority } from '../resolver.js';

describe('sortByPriority', () => {
  it('orders ascending, lower number first', () => {
    const sorted = sortByPriority([
      { url: 'a', mode: 'direct-wan', priority: 1 },
      { url: 'b', mode: 'direct-lan', priority: 0 },
      { url: 'c', mode: 'direct-wan', priority: 2 },
    ]);
    expect(sorted.map((e) => e.url)).toEqual(['b', 'a', 'c']);
  });

  it('places undefined priority last', () => {
    const sorted = sortByPriority([
      { url: 'a', mode: 'direct-wan' },
      { url: 'b', mode: 'direct-lan', priority: 0 },
    ]);
    expect(sorted.map((e) => e.url)).toEqual(['b', 'a']);
  });
});

describe('isSameEndpoint / endpointKey', () => {
  it('treats matching url+mode as same', () => {
    expect(isSameEndpoint({ url: 'x', mode: 'direct-lan' }, { url: 'x', mode: 'direct-lan' })).toBe(true);
  });

  it('treats different mode as different', () => {
    expect(isSameEndpoint({ url: 'x', mode: 'direct-lan' }, { url: 'x', mode: 'direct-wan' })).toBe(false);
  });

  it('endpointKey is stable and unique', () => {
    expect(endpointKey({ url: 'x', mode: 'direct-lan' })).toBe('direct-lan|x');
    expect(endpointKey({ url: 'x', mode: 'direct-wan' })).toBe('direct-wan|x');
  });
});
