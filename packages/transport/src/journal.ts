export interface JournalEntry {
  readonly seq: number;
  readonly t: number;
  readonly scope: string;
  readonly msg: string;
  readonly detail?: string;
}

export interface JournalOptions {
  readonly capacity?: number;
  readonly now?: () => number;
}

export interface ConnectionJournal {
  record(scope: string, msg: string, detail?: unknown): void;
  list(): JournalEntry[];
  clear(): void;
  subscribe(listener: (entry: JournalEntry) => void): () => void;
  exportText(): string;
}

const DEFAULT_CAPACITY = 1_000;
const MAX_DETAIL_LENGTH = 300;

function stringifyDetail(detail: unknown): string | undefined {
  if (detail === undefined || detail === null) return undefined;
  let text: string;
  if (typeof detail === 'string') text = detail;
  else if (detail instanceof Error) text = detail.message;
  else {
    try {
      text = JSON.stringify(detail);
    } catch {
      text = String(detail);
    }
  }
  return text.length > MAX_DETAIL_LENGTH ? `${text.slice(0, MAX_DETAIL_LENGTH)}…` : text;
}

function formatTime(t: number): string {
  const d = new Date(t);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

export function createConnectionJournal(options: JournalOptions = {}): ConnectionJournal {
  const capacity = options.capacity ?? DEFAULT_CAPACITY;
  const now = options.now ?? (() => Date.now());
  const buffer: JournalEntry[] = [];
  const listeners = new Set<(entry: JournalEntry) => void>();
  let head = 0;
  let seq = 0;

  function record(scope: string, msg: string, detail?: unknown): void {
    const entry: JournalEntry = { seq: seq++, t: now(), scope, msg, detail: stringifyDetail(detail) };
    if (buffer.length < capacity) {
      buffer.push(entry);
    } else {
      buffer[head] = entry;
      head = (head + 1) % capacity;
    }
    for (const listener of [...listeners]) {
      try {
        listener(entry);
      } catch {
        // ignore
      }
    }
  }

  function list(): JournalEntry[] {
    return [...buffer.slice(head), ...buffer.slice(0, head)];
  }

  function clear(): void {
    buffer.length = 0;
    head = 0;
  }

  function subscribe(listener: (entry: JournalEntry) => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function exportText(): string {
    const entries = list();
    const header = `connection journal — exported ${new Date(now()).toISOString()} (${entries.length} entries)`;
    const lines = entries.map((e) => {
      const detail = e.detail ? ` — ${e.detail}` : '';
      return `${formatTime(e.t)} [${e.scope}] ${e.msg}${detail}`;
    });
    return [header, ...lines].join('\n');
  }

  return { record, list, clear, subscribe, exportText };
}
