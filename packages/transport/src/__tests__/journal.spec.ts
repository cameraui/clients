import { describe, expect, it, vi } from 'vitest';

import { createConnectionJournal } from '../journal.js';

describe('createConnectionJournal', () => {
  it('records entries with monotonic seq and timestamps', () => {
    let t = 1000;
    const journal = createConnectionJournal({ now: () => t });
    journal.record('kernel', 'idle → discovering');
    t = 2000;
    journal.record('probe', 'probe OK', 'https://lan');
    const entries = journal.list();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ seq: 0, t: 1000, scope: 'kernel', msg: 'idle → discovering' });
    expect(entries[1]).toMatchObject({ seq: 1, t: 2000, scope: 'probe', detail: 'https://lan' });
  });

  it('wraps around at capacity keeping the newest entries in order', () => {
    const journal = createConnectionJournal({ capacity: 3, now: () => 0 });
    for (let i = 0; i < 5; i++) journal.record('s', `m${i}`);
    const entries = journal.list();
    expect(entries.map((e) => e.msg)).toEqual(['m2', 'm3', 'm4']);
    expect(entries.map((e) => e.seq)).toEqual([2, 3, 4]);
  });

  it('stringifies detail from errors and objects, truncating long text', () => {
    const journal = createConnectionJournal({ now: () => 0 });
    journal.record('a', 'err', new Error('boom'));
    journal.record('b', 'obj', { code: 4401 });
    journal.record('c', 'long', 'x'.repeat(500));
    const [a, b, c] = journal.list();
    expect(a!.detail).toBe('boom');
    expect(b!.detail).toBe('{"code":4401}');
    expect(c!.detail!.length).toBeLessThanOrEqual(301);
    expect(c!.detail!.endsWith('…')).toBe(true);
  });

  it('notifies subscribers per entry and survives throwing listeners', () => {
    const journal = createConnectionJournal({ now: () => 0 });
    const bad = vi.fn(() => {
      throw new Error('listener boom');
    });
    const good = vi.fn();
    journal.subscribe(bad);
    const unsub = journal.subscribe(good);
    journal.record('s', 'one');
    expect(good).toHaveBeenCalledTimes(1);
    unsub();
    journal.record('s', 'two');
    expect(good).toHaveBeenCalledTimes(1);
    expect(bad).toHaveBeenCalledTimes(2);
  });

  it('clear empties the buffer without resetting seq', () => {
    const journal = createConnectionJournal({ now: () => 0 });
    journal.record('s', 'one');
    journal.clear();
    journal.record('s', 'two');
    const entries = journal.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.seq).toBe(1);
  });

  it('exportText renders a header and one line per entry', () => {
    const journal = createConnectionJournal({ now: () => 0 });
    journal.record('kernel', 'discovering → online', 'PROBE_SUCCEEDED');
    const text = journal.exportText();
    const lines = text.split('\n');
    expect(lines[0]).toContain('connection journal');
    expect(lines[0]).toContain('(1 entries)');
    expect(lines[1]).toMatch(/\d{2}:\d{2}:\d{2}\.\d{3} \[kernel] discovering → online — PROBE_SUCCEEDED/);
  });
});
