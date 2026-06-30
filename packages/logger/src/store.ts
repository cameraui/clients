import { loggerState } from './singleton.js';

import type { LogEntry, Unsubscribe } from './types.js';

export function setCapacity(n: number): void {
  loggerState().capacity = Math.max(1, Math.floor(n));
  trim();
}

export function pushEntry(entry: LogEntry): void {
  loggerState().entries.push(entry);
  trim();
  emit();
}

export function getEntries(): LogEntry[] {
  return loggerState().entries.slice();
}

export function clearEntries(): void {
  loggerState().entries = [];
  emit();
}

export function loadEntries(loaded: readonly LogEntry[]): void {
  const s = loggerState();
  s.entries = loaded.slice(-s.capacity);
  emit();
}

export function subscribeStore(cb: (entries: readonly LogEntry[]) => void): Unsubscribe {
  const { storeListeners } = loggerState();
  storeListeners.add(cb);
  return () => {
    storeListeners.delete(cb);
  };
}

function trim(): void {
  const s = loggerState();
  if (s.entries.length > s.capacity) s.entries.splice(0, s.entries.length - s.capacity);
}

function emit(): void {
  const s = loggerState();
  for (const cb of s.storeListeners) {
    try {
      cb(s.entries);
    } catch {
      // ignore
    }
  }
}
