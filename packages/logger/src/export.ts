import { DEFAULT_REDACT_RULES, redact as applyRedact } from './redact.js';
import { getEntries } from './store.js';
import { timestamp } from './time.js';

import type { RedactRule } from './redact.js';
import type { LogEntry } from './types.js';

export interface ExportOptions {
  entries?: LogEntry[];
  context?: Record<string, unknown>;
  redact?: boolean | RedactRule[];
}

export function formatEntries(entries: LogEntry[] = getEntries()): string {
  return entries.map((e) => `${timestamp(e.t)} [${e.level.toUpperCase()}] [${e.scope}] ${e.msg}`).join('\n');
}

export function buildExport(options: ExportOptions = {}): string {
  const entries = options.entries ?? getEntries();
  const header = options.context ? `${renderHeader(options.context)}\n\n` : '';
  const full = `${header}${formatEntries(entries)}`;

  if (options.redact === false) return full;
  const rules = Array.isArray(options.redact) ? options.redact : DEFAULT_REDACT_RULES;
  return applyRedact(full, rules);
}

function renderHeader(context: Record<string, unknown>): string {
  const lines = Object.entries(context).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  return ['===== camera.ui diagnostics =====', ...lines].join('\n');
}
