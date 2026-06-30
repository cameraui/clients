import { isRecording } from './flag.js';
import { nativeConsole } from './nativeConsole.js';
import { pushEntry } from './store.js';
import { safeStringify } from './stringify.js';

import type { LogLevel } from './types.js';

let installed = false;

const METHOD_LEVEL: Record<'log' | 'debug' | 'info' | 'warn' | 'error', LogLevel> = {
  log: 'log',
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error',
};

export function installConsoleCapture(): void {
  if (installed) return;
  installed = true;

  for (const method of ['log', 'debug', 'info', 'warn', 'error'] as const) {
    const level = METHOD_LEVEL[method];
    const original = nativeConsole[method];
    (console as unknown as Record<string, (...args: unknown[]) => void>)[method] = (...args: unknown[]) => {
      if (isRecording()) pushEntry({ t: Date.now(), level, scope: 'console', msg: args.map(safeStringify).join(' ') });
      original(...args);
    };
  }

  const target = globalThis as unknown as {
    addEventListener?: (type: string, cb: (e: any) => void) => void;
  };
  target.addEventListener?.('error', (e) => {
    if (!isRecording()) return;
    const where = e?.filename ? ` ${e.filename}:${e.lineno}:${e.colno}` : '';
    pushEntry({ t: Date.now(), level: 'error', scope: 'window', msg: `[onerror] ${e?.message ?? ''}${where}`.trim() });
  });
  target.addEventListener?.('unhandledrejection', (e) => {
    if (!isRecording()) return;
    pushEntry({ t: Date.now(), level: 'error', scope: 'window', msg: `[unhandledrejection] ${safeStringify(e?.reason)}` });
  });
}
