type ConsoleMethod = 'log' | 'debug' | 'info' | 'warn' | 'error';

function bind(method: ConsoleMethod): (...args: unknown[]) => void {
  const fn = (console[method] ?? console.log) as (...args: unknown[]) => void;
  return fn.bind(console);
}

// Snapshot the real console before installConsoleCapture() patches it, so Logger output isn't re-captured.
export const nativeConsole: Record<ConsoleMethod, (...args: unknown[]) => void> = {
  log: bind('log'),
  debug: bind('debug'),
  info: bind('info'),
  warn: bind('warn'),
  error: bind('error'),
};
