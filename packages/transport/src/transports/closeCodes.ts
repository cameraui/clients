export type CloseClass = 'auth-expired' | 'forbidden' | 'other';

export interface CloseLike {
  readonly code?: number;
  readonly wsCloseCode?: number;
  readonly message?: string;
  readonly reason?: string;
}

export function classifyClose(input: CloseLike | string): CloseClass {
  const obj = typeof input === 'string' ? undefined : input;
  const code = obj?.wsCloseCode ?? obj?.code;
  if (code === 4401 || code === 1008) return 'auth-expired';
  if (code === 4403 || code === 4400) return 'forbidden';
  const text = (typeof input === 'string' ? input : (obj?.reason ?? obj?.message ?? '')).toLowerCase();
  if (!text) return 'other';
  if (text.includes('forbidden') || text.includes('403')) return 'forbidden';
  if (text.includes('unauthorized') || text.includes('401') || text.includes('auth')) return 'auth-expired';
  return 'other';
}
