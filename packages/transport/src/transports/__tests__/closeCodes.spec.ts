import { describe, expect, it } from 'vitest';

import { classifyClose, refusedByServer } from '../closeCodes.js';

describe('classifyClose', () => {
  it('classifies by structured code first', () => {
    expect(classifyClose({ code: 4401 })).toBe('auth-expired');
    expect(classifyClose({ wsCloseCode: 4401, message: 'whatever' })).toBe('auth-expired');
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
    expect(classifyClose({ message: 'Unauthenticated' })).toBe('auth-expired');
    expect(classifyClose('401 Unauthorized')).toBe('auth-expired');
  });

  it('does not read nats-server policy closes as an expired token', () => {
    expect(classifyClose({ code: 1008 })).toBe('other');
    expect(classifyClose({ wsCloseCode: 1008, message: 'Authorization Violation' })).toBe('other');
    expect(classifyClose('Authentication Timeout')).toBe('other');
  });

  it('classifies socket.io middleware errors by their code', () => {
    expect(classifyClose({ message: 'Not authorized to connect to /logs', data: { code: 'insufficient_role' } })).toBe('forbidden');
    expect(classifyClose({ message: 'User not found', data: { code: 'user_not_found' } })).toBe('forbidden');
    expect(classifyClose({ message: 'Unauthorized: Token is missing or invalid Bearer', data: { code: 'invalid_token' } })).toBe('auth-expired');
    expect(classifyClose({ message: 'no token provided', data: { code: 'credentials_required' } })).toBe('auth-expired');
    expect(classifyClose({ message: 'Format is Authorization: Bearer [token]', data: { code: 'credentials_bad_format' } })).toBe('auth-expired');
    expect(classifyClose({ message: 'Unauthenticated', data: { code: 'unauthenticated' } })).toBe('auth-expired');
    expect(classifyClose({ message: 'Not authorized to connect to /logs' })).toBe('other');
    expect(classifyClose({ message: '401 Unauthorized', data: { code: 'something_new' } })).toBe('auth-expired');
  });

  it('everything else is other', () => {
    expect(classifyClose('staleConnection')).toBe('other');
    expect(classifyClose({ message: 'ECONNREFUSED' })).toBe('other');
    expect(classifyClose('')).toBe('other');
    expect(classifyClose({})).toBe('other');
  });
});

describe('refusedByServer', () => {
  it('trusts only a close code or an error code', () => {
    expect(refusedByServer(Object.assign(new Error('forbidden: token not allowed on rpc bus'), { wsCloseCode: 4403 }))).toBe(true);
    expect(refusedByServer({ code: 4400 })).toBe(true);
    expect(refusedByServer({ message: 'Not authorized to connect to /logs', data: { code: 'insufficient_role' } })).toBe(true);
  });

  it('ignores refusal words in the text', () => {
    expect(refusedByServer(new Error('403 Forbidden'))).toBe(false);
    expect(refusedByServer(Object.assign(new Error('upstream lost: 403'), { wsCloseCode: 4500 }))).toBe(false);
    expect(refusedByServer(Object.assign(new Error('unauthorized'), { wsCloseCode: 4401 }))).toBe(false);
    expect(refusedByServer('forbidden')).toBe(false);
    expect(refusedByServer(undefined)).toBe(false);
  });
});
