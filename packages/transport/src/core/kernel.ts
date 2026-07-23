import { Logger } from '@camera.ui/logger';

import { reducer } from './reducer.js';

import type { Action, ConnectionPhase, ReducerContext } from './types.js';

const log = new Logger('kernel');

export type Listener = (phase: ConnectionPhase, prev: ConnectionPhase, action: Action) => void;
export type Unsubscribe = () => void;

export interface KernelOptions {
  readonly context: ReducerContext;
  readonly initial?: ConnectionPhase;
  readonly onAction?: (action: Action, prev: ConnectionPhase, next: ConnectionPhase) => void;
}

export interface Kernel {
  readonly phase: ConnectionPhase;
  dispatch(action: Action): void;
  subscribe(listener: Listener): Unsubscribe;
  dispose(): void;
}

export function createKernel(options: KernelOptions): Kernel {
  let current: ConnectionPhase = options.initial ?? { kind: 'idle' };
  const listeners = new Set<Listener>();
  const queue: Action[] = [];
  let dispatching = false;
  let disposed = false;

  function dispatch(action: Action): void {
    if (disposed) return;
    if (dispatching) {
      queue.push(action);
      return;
    }
    dispatching = true;
    try {
      let next: Action | undefined = action;
      while (next) {
        const prev = current;
        const after = reducer(prev, next, options.context);
        if (options.onAction) {
          try {
            options.onAction(next, prev, after);
          } catch (err) {
            log.warn('onAction threw on', next.type, err);
          }
        }
        if (after !== prev) {
          current = after;
          // Snapshot + per-listener try/catch: a throw in one subscriber must
          // not cut off downstream effects (e.g., the workerBridge listener
          // attached last would silently miss broadcasts).
          for (const listener of [...listeners]) {
            try {
              listener(after, prev, next);
            } catch (err) {
              log.warn('listener threw on', next.type, err);
            }
          }
        }
        next = queue.shift();
      }
    } finally {
      dispatching = false;
    }
  }

  function subscribe(listener: Listener): Unsubscribe {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function dispose(): void {
    disposed = true;
    listeners.clear();
    queue.length = 0;
  }

  return {
    get phase() {
      return current;
    },
    dispatch,
    subscribe,
    dispose,
  };
}
