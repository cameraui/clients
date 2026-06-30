import { describe, expect, it } from 'vitest';

import { isLoggerMessage } from '../protocol.js';

describe('isLoggerMessage', () => {
  it('accepts tagged messages', () => {
    expect(isLoggerMessage({ __cui_logger__: true, type: 'flag', debug: true, recording: true })).toBe(true);
    expect(isLoggerMessage({ __cui_logger__: true, type: 'entry', entry: { t: 0, level: 'info', scope: 's', msg: 'x' } })).toBe(true);
  });

  it('rejects untagged values', () => {
    expect(isLoggerMessage({ type: 'flag' })).toBe(false);
    expect(isLoggerMessage(null)).toBe(false);
    expect(isLoggerMessage('flag')).toBe(false);
  });
});
