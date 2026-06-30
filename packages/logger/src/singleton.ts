import type { LogEntry } from './types.js';

export interface LoggerState {
  capacity: number;
  entries: LogEntry[];
  storeListeners: Set<(entries: readonly LogEntry[]) => void>;
  debugEnabled: boolean;
  scopeOverrides: Map<string, boolean>;
  recording: boolean;
  flagListeners: Set<() => void>;
}

const KEY = '__cuiLoggerState__';

// Pinned to globalThis so multiple bundled copies in one runtime share one buffer + flag.
export function loggerState(): LoggerState {
  const g = globalThis as unknown as Record<string, LoggerState | undefined>;
  let state = g[KEY];
  if (!state) {
    state = {
      capacity: 600,
      entries: [],
      storeListeners: new Set(),
      debugEnabled: false,
      scopeOverrides: new Map(),
      recording: false,
      flagListeners: new Set(),
    };
    g[KEY] = state;
  }
  return state;
}
