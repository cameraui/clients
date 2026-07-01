import { describe, expect, it } from 'vitest';

import { formatMessage } from '../stringify.js';

describe('formatMessage', () => {
  it('substitutes %o/%s format specifiers in place', () => {
    expect(formatMessage(['anchor=%o, mode=%s, rafId=%s', null, 'live', null])).toBe('anchor=null, mode=live, rafId=null');
  });

  it('space-joins when the first arg is not a format string', () => {
    expect(formatMessage(['a', 'b', 'c'])).toBe('a b c');
  });

  it('handles %d/%i and appends leftover args', () => {
    expect(formatMessage(['%d items', 3])).toBe('3 items');
    expect(formatMessage(['%s', 'x', 'extra'])).toBe('x extra');
  });

  it('consumes %c styling without emitting it', () => {
    expect(formatMessage(['%cX', 'color:red'])).toBe('X');
  });
});
