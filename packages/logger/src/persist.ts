import { isDebug, isRecording, setDebug, setRecording, subscribeFlags } from './flag.js';
import { getEntries, loadEntries, subscribeStore } from './store.js';

import type { LogEntry, StorageAdapter } from './types.js';

const DEBUG_KEY = 'cui-logger-debug';
const RECORDING_KEY = 'cui-logger-recording';
const BUFFER_KEY = 'cui-logger-buffer';
const FLUSH_DELAY = 400;

let adapter: StorageAdapter | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

export function bindStorage(storage: StorageAdapter): void {
  adapter = storage;

  try {
    const d = storage.getItem(DEBUG_KEY);
    if (d === '1' || d === '0') setDebug(d === '1');
    const r = storage.getItem(RECORDING_KEY);
    if (r === '1' || r === '0') setRecording(r === '1');
  } catch {
    // ignore
  }

  try {
    const raw = storage.getItem(BUFFER_KEY);
    if (raw) {
      const prev = JSON.parse(raw) as LogEntry[];
      if (Array.isArray(prev)) loadEntries(prev);
    }
  } catch {
    // ignore
  }

  subscribeFlags(() => {
    try {
      adapter?.setItem(DEBUG_KEY, isDebug() ? '1' : '0');
      adapter?.setItem(RECORDING_KEY, isRecording() ? '1' : '0');
    } catch {
      // ignore
    }
  });

  subscribeStore(() => scheduleFlush());
  scheduleFlush();
}

export function flushNow(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!adapter) return;
  try {
    adapter.setItem(BUFFER_KEY, JSON.stringify(getEntries()));
  } catch {
    // ignore
  }
}

function scheduleFlush(): void {
  if (!adapter || flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushNow();
  }, FLUSH_DELAY);
}
