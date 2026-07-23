import { describe, expect, it } from 'vitest';

import { classifyClose } from '../closeCodes.js';

describe('classifyClose', () => {
  it('classifies by structured code first', () => {
    expect(classifyClose({ code: 4401 })).toBe('auth-expired');
    expect(classifyClose({ wsCloseCode: 4401, message: 'whatever' })).toBe('auth-expired');
    expect(classifyClose({ code: 1008 })).toBe('auth-expired');
    expect(classifyClose({ code: 4403 })).toBe('forbidden');
    expect(classifyClose({ code: 4400 })).toBe('forbidden');
    expect(classifyClose({ code: 1006 })).toBe('other');
  });

  it('forbidden reasons never fall through to the auth branch', () => {
    expect(classifyClose('forbidden: src out of scope')).toBe('forbidden');
    expect(classifyClose({ reason: 'forbidden: token not allowed on rpc bus' })).toBe('forbidden');
    expect(classifyClose('403 Forbidden')).toBe('forbidden');
  });

  it('auth keywords classify as auth-expired', () => {
    expect(classifyClose('unauthorized: token expired')).toBe('auth-expired');
    expect(classifyClose({ message: 'Authentication failed' })).toBe('auth-expired');
    expect(classifyClose('401 Unauthorized')).toBe('auth-expired');
  });

  it('everything else is other', () => {
    expect(classifyClose('staleConnection')).toBe('other');
    expect(classifyClose({ message: 'ECONNREFUSED' })).toBe('other');
    expect(classifyClose('')).toBe('other');
    expect(classifyClose({})).toBe('other');
  });
});
