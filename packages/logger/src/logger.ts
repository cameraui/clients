import { clearScopeOverride, isDebug, isRecording, setDebug, setRecording, subscribeFlags } from './flag.js';
import { nativeConsole } from './nativeConsole.js';
import { clearEntries, getEntries, pushEntry, setCapacity, subscribeStore } from './store.js';
import { formatMessage } from './stringify.js';
import { timestamp } from './time.js';

import type { LogEntry, LogLevel, Unsubscribe } from './types.js';

const CONSOLE_METHOD: Record<LogLevel, 'debug' | 'log' | 'info' | 'warn' | 'error'> = {
  debug: 'debug',
  log: 'log',
  info: 'info',
  warn: 'warn',
  error: 'error',
};

export class Logger {
  constructor(public readonly scope: string) {}

  static scope(scope: string): Logger {
    return new Logger(scope);
  }

  debug(...args: unknown[]): void {
    this.emit('debug', args);
  }

  log(...args: unknown[]): void {
    this.emit('log', args);
  }

  info(...args: unknown[]): void {
    this.emit('info', args);
  }

  warn(...args: unknown[]): void {
    this.emit('warn', args);
  }

  error(...args: unknown[]): void {
    this.emit('error', args);
  }

  private emit(level: LogLevel, args: unknown[]): void {
    if (level === 'debug' && !isDebug(this.scope)) return;
    const prefix = `[${this.scope} ${timestamp()}]`;
    if (typeof args[0] === 'string') nativeConsole[CONSOLE_METHOD[level]](`${prefix} ${args[0]}`, ...args.slice(1));
    else nativeConsole[CONSOLE_METHOD[level]](prefix, ...args);
    if (isRecording()) pushEntry({ t: Date.now(), level, scope: this.scope, msg: formatMessage(args) });
  }

  static setDebug(enabled: boolean, scope?: string): void {
    setDebug(enabled, scope);
  }

  static isDebug(scope?: string): boolean {
    return isDebug(scope);
  }

  static clearScope(scope: string): void {
    clearScopeOverride(scope);
  }

  static setRecording(enabled: boolean): void {
    setRecording(enabled);
  }

  static isRecording(): boolean {
    return isRecording();
  }

  static onChange(cb: () => void): Unsubscribe {
    return subscribeFlags(cb);
  }

  static entries(): LogEntry[] {
    return getEntries();
  }

  static clear(): void {
    clearEntries();
  }

  static onEntries(cb: (entries: readonly LogEntry[]) => void): Unsubscribe {
    return subscribeStore(cb);
  }

  static setCapacity(n: number): void {
    setCapacity(n);
  }
}
