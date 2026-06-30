import { beforeEach, describe, expect, it } from 'vitest';

import { Logger } from '../logger.js';
import { connectWorkerLogger } from '../workerBridge.js';

beforeEach(() => {
  delete (globalThis as Record<string, unknown>).__cuiLoggerState__;
});

describe('recording gate', () => {
  it('records nothing while recording is off', () => {
    new Logger('t').info('hello');
    expect(Logger.entries()).toHaveLength(0);
  });

  it('records log/info/warn/error once recording is on', () => {
    Logger.setRecording(true);
    const log = new Logger('t');
    log.log('a');
    log.info('b');
    log.warn('c');
    log.error('d');
    expect(Logger.entries().map((e) => e.level)).toEqual(['log', 'info', 'warn', 'error']);
  });
});

describe('debug gate', () => {
  it('keeps debug() silent unless debug is on, even while recording', () => {
    Logger.setRecording(true);
    const log = new Logger('t');
    log.debug('x');
    expect(Logger.entries()).toHaveLength(0);

    Logger.setDebug(true);
    log.debug('y');
    expect(Logger.entries().map((e) => e.msg)).toEqual(['y']);
  });

  it('honours per-scope debug overrides', () => {
    Logger.setRecording(true);
    Logger.setDebug(true, 'on');
    new Logger('on').debug('a');
    new Logger('off').debug('b');
    expect(Logger.entries().map((e) => e.scope)).toEqual(['on']);
  });
});

describe('ring buffer', () => {
  it('trims to capacity', () => {
    Logger.setRecording(true);
    Logger.setCapacity(3);
    const log = new Logger('t');
    for (let i = 0; i < 5; i++) log.info(String(i));
    expect(Logger.entries().map((e) => e.msg)).toEqual(['2', '3', '4']);
  });

  it('clear empties the buffer', () => {
    Logger.setRecording(true);
    new Logger('t').info('x');
    Logger.clear();
    expect(Logger.entries()).toHaveLength(0);
  });
});

describe('subscriptions', () => {
  it('onEntries fires on push and stops after unsubscribe', () => {
    Logger.setRecording(true);
    let count = 0;
    const off = Logger.onEntries(() => count++);
    new Logger('t').info('x');
    off();
    new Logger('t').info('y');
    expect(count).toBe(1);
  });

  it('onChange fires on any flag change', () => {
    let count = 0;
    const off = Logger.onChange(() => count++);
    Logger.setRecording(true);
    Logger.setDebug(true);
    off();
    Logger.setRecording(false);
    expect(count).toBe(2);
  });
});

describe('connectWorkerLogger', () => {
  it('pushes the current flag and merges forwarded entries', () => {
    Logger.setRecording(true);
    const ref: { handler?: (e: { data: unknown }) => void } = {};
    const posted: unknown[] = [];
    const worker = {
      addEventListener: (_type: 'message', cb: (e: { data: unknown }) => void) => {
        ref.handler = cb;
      },
      removeEventListener: () => {},
      postMessage: (m: unknown) => posted.push(m),
    };

    connectWorkerLogger(worker);
    expect(posted[0]).toMatchObject({ type: 'flag', recording: true });

    ref.handler?.({ data: { __cui_logger__: true, type: 'entry', entry: { t: 1, level: 'info', scope: 'w', msg: 'from worker' } } });
    expect(Logger.entries().map((e) => e.msg)).toContain('from worker');
  });
});
