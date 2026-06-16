import type { Kernel } from '../core/kernel.js';

export type Detach = () => void;

export type PresenceCallback = (kernel: Kernel) => void;

export interface VisibilitySource extends EventTarget {
  visibilityState?: DocumentVisibilityState;
}

export interface PresenceOptions {
  readonly kernel: Kernel;
  readonly networkSource?: EventTarget | null;
  readonly visibilitySource?: VisibilitySource | null;
  readonly onOnline?: PresenceCallback;
  readonly onOffline?: PresenceCallback;
  readonly onVisibilityVisible?: PresenceCallback;
  readonly onVisibilityHidden?: PresenceCallback;
}

export const defaultOnNetworkOnline: PresenceCallback = (kernel) => {
  if (kernel.phase.kind === 'offline') {
    kernel.dispatch({ type: 'USER_RETRY' });
  }
};

export function attachPresence(options: PresenceOptions): Detach {
  const networkSource =
    options.networkSource !== undefined
      ? options.networkSource
      : typeof globalThis !== 'undefined' && 'window' in globalThis
        ? (globalThis as { window: EventTarget }).window
        : null;
  const visibilitySource =
    options.visibilitySource !== undefined
      ? options.visibilitySource
      : typeof globalThis !== 'undefined' && 'document' in globalThis
        ? (globalThis as { document: VisibilitySource }).document
        : null;

  const onOnline = options.onOnline ?? defaultOnNetworkOnline;
  const onOffline = options.onOffline;
  const cleanups: Array<() => void> = [];

  if (networkSource) {
    const handleOnline = (): void => onOnline(options.kernel);
    const handleOffline = (): void => onOffline?.(options.kernel);
    networkSource.addEventListener('online', handleOnline);
    networkSource.addEventListener('offline', handleOffline);
    cleanups.push(() => {
      networkSource.removeEventListener('online', handleOnline);
      networkSource.removeEventListener('offline', handleOffline);
    });
  }

  if (visibilitySource && (options.onVisibilityVisible || options.onVisibilityHidden)) {
    const handleVisibility = (): void => {
      const isVisible = visibilitySource.visibilityState !== 'hidden';
      if (isVisible) {
        options.onVisibilityVisible?.(options.kernel);
      } else {
        options.onVisibilityHidden?.(options.kernel);
      }
    };
    visibilitySource.addEventListener('visibilitychange', handleVisibility);
    cleanups.push(() => {
      visibilitySource.removeEventListener('visibilitychange', handleVisibility);
    });
  }

  return () => {
    for (const fn of cleanups) fn();
    cleanups.length = 0;
  };
}
