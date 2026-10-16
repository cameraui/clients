export type CloseClass = 'auth-expired' | 'forbidden' | 'other';

export interface CloseLike {
  readonly code?: number;
  readonly wsCloseCode?: number;
  readonly message?: string;
  readonly reason?: string;
  readonly data?: unknown;
}

function classifyErrorCode(code: string): CloseClass | undefined {
  if (code === 'insufficient_role' || code === 'user_not_found') return 'forbidden';
  if (code === 'invalid_token' || code === 'unauthenticated' || code.startsWith('credentials_')) return 'auth-expired';
  return undefined;
}

export function classifyClose(input: CloseLike | string): CloseClass {
  const obj = typeof input === 'string' ? undefined : input;
  const code = obj?.wsCloseCode ?? obj?.code;
  if (code === 4401) return 'auth-expired';
  if (code === 4403 || code === 4400) return 'forbidden';
  const errorCode = typeof obj?.data === 'object' && obj.data !== null ? (obj.data as { code?: unknown }).code : undefined;
  const byErrorCode = typeof errorCode === 'string' ? classifyErrorCode(errorCode) : undefined;
  if (byErrorCode) return byErrorCode;
  const text = (typeof input === 'string' ? input : (obj?.reason ?? obj?.message ?? '')).toLowerCase();
  if (!text) return 'other';
  if (text.includes('forbidden') || text.includes('403')) return 'forbidden';
  // no bare "auth" match: nats-server's Authorization Violation and Authentication Timeout say nothing about the token
  if (text.includes('unauthorized') || text.includes('unauthenticated') || text.includes('401')) return 'auth-expired';
  return 'other';
}

export function refusedByServer(input: unknown): boolean {
  if (typeof input !== 'object' || input === null) return false;
  const { wsCloseCode, code, data } = input as CloseLike;
  return classifyClose({ wsCloseCode, code, data }) === 'forbidden';
}
