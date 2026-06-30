import { loggerState } from './singleton.js';

import type { Unsubscribe } from './types.js';

export function setDebug(enabled: boolean, scope?: string): void {
  const s = loggerState();
  if (scope) s.scopeOverrides.set(scope, enabled);
  else s.debugEnabled = enabled;
  emit();
}

export function clearScopeOverride(scope: string): void {
  if (loggerState().scopeOverrides.delete(scope)) emit();
}

export function isDebug(scope?: string): boolean {
  const s = loggerState();
  if (scope !== undefined && s.scopeOverrides.has(scope)) return s.scopeOverrides.get(scope) as boolean;
  return s.debugEnabled;
}

export function setRecording(enabled: boolean): void {
  loggerState().recording = enabled;
  emit();
}

export function isRecording(): boolean {
  return loggerState().recording;
}

export function subscribeFlags(cb: () => void): Unsubscribe {
  const { flagListeners } = loggerState();
  flagListeners.add(cb);
  return () => {
    flagListeners.delete(cb);
  };
}

function emit(): void {
  const s = loggerState();
  for (const cb of s.flagListeners) {
    try {
      cb();
    } catch {
      // ignore
    }
  }
}
