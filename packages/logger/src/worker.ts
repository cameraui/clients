import { setDebug, setRecording } from './flag.js';
import { isLoggerMessage } from './protocol.js';
import { subscribeStore } from './store.js';

import type { Unsubscribe } from './types.js';

// Re-exported here so a worker gets Logger + capture from the SAME bundle (and buffer) as the bridge.
export { installConsoleCapture } from './console.js';
export { Logger } from './logger.js';
export type { LogEntry, LogLevel } from './types.js';

type Poster = (message: unknown) => void;

export function initWorkerLoggerBridge(post?: Poster): Unsubscribe {
  const g = globalThis as unknown as {
    postMessage?: Poster;
    addEventListener?: (type: 'message', cb: (e: { data: unknown }) => void) => void;
    removeEventListener?: (type: 'message', cb: (e: { data: unknown }) => void) => void;
  };
  const send: Poster = post ?? ((m) => g.postMessage?.(m));

  const unsubStore = subscribeStore((entries) => {
    const last = entries[entries.length - 1];
    if (last) send({ __cui_logger__: true, type: 'entry', entry: last });
  });

  const onMessage = (e: { data: unknown }): void => {
    if (isLoggerMessage(e.data) && e.data.type === 'flag') {
      setDebug(e.data.debug);
      setRecording(e.data.recording);
    }
  };
  g.addEventListener?.('message', onMessage);

  return () => {
    unsubStore();
    g.removeEventListener?.('message', onMessage);
  };
}
