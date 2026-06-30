import { isDebug, isRecording, subscribeFlags } from './flag.js';
import { isLoggerMessage } from './protocol.js';
import { pushEntry } from './store.js';

import type { Unsubscribe } from './types.js';

interface WorkerLike {
  addEventListener?: (type: 'message', cb: (e: { data: unknown }) => void) => void;
  removeEventListener?: (type: 'message', cb: (e: { data: unknown }) => void) => void;
  postMessage: (message: unknown) => void;
}

export function connectWorkerLogger(worker: WorkerLike): Unsubscribe {
  const onMessage = (e: { data: unknown }): void => {
    if (isLoggerMessage(e.data) && e.data.type === 'entry') pushEntry(e.data.entry);
  };
  worker.addEventListener?.('message', onMessage);

  const pushFlag = (): void => worker.postMessage({ __cui_logger__: true, type: 'flag', debug: isDebug(), recording: isRecording() });
  pushFlag();
  const unsubFlag = subscribeFlags(pushFlag);

  return () => {
    worker.removeEventListener?.('message', onMessage);
    unsubFlag();
  };
}
