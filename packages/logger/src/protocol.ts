import type { LogEntry } from './types.js';

export const LOGGER_CHANNEL = '__cui_logger__';

export interface EntryMessage {
  __cui_logger__: true;
  type: 'entry';
  entry: LogEntry;
}

export interface FlagMessage {
  __cui_logger__: true;
  type: 'flag';
  debug: boolean;
  recording: boolean;
}

export type LoggerMessage = EntryMessage | FlagMessage;

export function isLoggerMessage(data: unknown): data is LoggerMessage {
  return !!data && typeof data === 'object' && (data as { __cui_logger__?: unknown }).__cui_logger__ === true;
}
