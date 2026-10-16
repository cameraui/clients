import { describe, expect, it } from 'vitest';

import { createFmp4KeyframeScanner } from '../fmp4.js';
import { fragment, initSegment, joinMessages, VIDEO_TIMESCALE } from './fakes.js';

const FRAME = VIDEO_TIMESCALE / 25;

function scanAll(...messages: ArrayBuffer[]): { keyframes: number[]; hasVideo: boolean | undefined } {
  const scanner = createFmp4KeyframeScanner();
  const keyframes: number[] = [];
  for (const message of messages) scanner.scan(message, (time) => keyframes.push(time));
  return { keyframes, hasVideo: scanner.hasVideo };
}

describe('createFmp4KeyframeScanner', () => {
  it('reports keyframes of a go2rtc style stream in seconds', () => {
    const { keyframes, hasVideo } = scanAll(
      initSegment(),
      fragment({ dts: 0, samples: [{ duration: FRAME, key: true }] }),
      fragment({ dts: FRAME, samples: [{ duration: FRAME, key: false }] }),
      fragment({ dts: 8 * VIDEO_TIMESCALE, samples: [{ duration: FRAME, key: true }] }),
    );

    expect(hasVideo).toBe(true);
    expect(keyframes).toEqual([0, 8]);
  });

  it('knows nothing before an init segment arrived', () => {
    const { keyframes, hasVideo } = scanAll(fragment({ dts: 0, samples: [{ duration: FRAME, key: true }] }));

    expect(hasVideo).toBeUndefined();
    expect(keyframes).toEqual([]);
  });

  it('flags an audio-only stream and reports no keyframes for it', () => {
    const { keyframes, hasVideo } = scanAll(
      initSegment([{ id: 1, kind: 'audio', timescale: 48_000 }]),
      fragment({ dts: 0, kind: 'audio', timescale: 48_000, samples: [{ duration: 1024, key: true }] }),
    );

    expect(hasVideo).toBe(false);
    expect(keyframes).toEqual([]);
  });

  it('ignores the audio track of a muxed stream', () => {
    const { keyframes } = scanAll(
      initSegment([
        { id: 1, kind: 'video', timescale: VIDEO_TIMESCALE },
        { id: 2, kind: 'audio', timescale: 48_000 },
      ]),
      fragment({ dts: 48_000, trackId: 2, kind: 'audio', timescale: 48_000, samples: [{ duration: 1024, key: true }] }),
      fragment({ dts: 2 * VIDEO_TIMESCALE, samples: [{ duration: FRAME, key: true }] }),
    );

    expect(keyframes).toEqual([2]);
  });

  it('finds every keyframe when one message carries several fragments', () => {
    const burst = joinMessages(...Array.from({ length: 100 }, (_, i) => fragment({ dts: i * FRAME, samples: [{ duration: FRAME, key: i % 50 === 0 }] })));

    expect(scanAll(joinMessages(initSegment(), burst)).keyframes).toEqual([0, 2]);
  });

  it('reads the sync flag from first_sample_flags', () => {
    const { keyframes } = scanAll(
      initSegment(),
      fragment({
        dts: 0,
        layout: 'first-sample-flags',
        samples: [
          { duration: FRAME, key: true },
          { duration: FRAME, key: false },
        ],
      }),
      fragment({ dts: 2 * FRAME, layout: 'first-sample-flags', samples: [{ duration: FRAME, key: false }] }),
    );

    expect(keyframes).toEqual([0]);
  });

  it('walks per-sample flags, durations and composition offsets', () => {
    const { keyframes } = scanAll(
      initSegment(),
      fragment({
        dts: VIDEO_TIMESCALE,
        layout: 'per-sample',
        samples: [
          { duration: FRAME, key: false },
          { duration: FRAME, key: false },
          { duration: 2 * FRAME, key: true, cts: FRAME },
          { duration: FRAME, key: false },
        ],
      }),
    );

    expect(keyframes).toEqual([(VIDEO_TIMESCALE + 3 * FRAME) / VIDEO_TIMESCALE]);
  });

  it('falls back to the trex defaults', () => {
    const { keyframes } = scanAll(
      initSegment([{ id: 1, kind: 'video', timescale: VIDEO_TIMESCALE, trexDuration: FRAME, trexFlags: 0x01010000 }]),
      fragment({ dts: 0, layout: 'trex-defaults', samples: [{ duration: FRAME, key: false }] }),
    );

    expect(keyframes).toEqual([]);
  });

  it('reads version 0 and version 1 headers alike', () => {
    const { keyframes } = scanAll(
      initSegment([{ id: 7, kind: 'video', timescale: 1000, version: 1 }]),
      fragment({ dts: 4000, trackId: 7, timescale: 1000, tfdtVersion: 0, samples: [{ duration: 40, key: true }] }),
    );

    expect(keyframes).toEqual([4]);
  });

  it('survives truncated and garbage input', () => {
    const whole = new Uint8Array(fragment({ dts: 0, samples: [{ duration: FRAME, key: true }] }));
    const scanner = createFmp4KeyframeScanner();
    scanner.scan(initSegment(), () => {});

    const found: number[] = [];
    for (let cut = 0; cut < whole.byteLength; cut += 7) {
      expect(() => scanner.scan(whole.slice(0, cut).buffer, (t) => found.push(t))).not.toThrow();
    }
    expect(() => scanner.scan(new Uint8Array([0, 0, 0, 1, 0x6d, 0x6f, 0x6f, 0x66, 0xff]).buffer, () => {})).not.toThrow();
    expect(found.every((t) => t === 0)).toBe(true);
  });
});
