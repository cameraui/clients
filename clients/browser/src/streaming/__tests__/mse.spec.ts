import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { STREAM_CONFIG } from '../config.js';
import { createMSEHandler } from '../mse.js';
import {
  FakeMediaSource,
  FakeVideo,
  fragment,
  H264_MIME,
  H265_MIME,
  initSegment,
  installMediaGlobals,
  joinMessages,
  restoreMediaGlobals,
  settle,
  videoFrame,
} from './fakes.js';

import type { FakeSourceBuffer, TrackSpec } from './fakes.js';

const FRAME_MS = 40;

function openHandler(options: { mime?: string; tracks?: TrackSpec[]; init?: boolean } = {}) {
  const video = new FakeVideo();
  const onError = vi.fn();
  const onReady = vi.fn();
  const onFirstData = vi.fn();
  const controller = new AbortController();
  const handler = createMSEHandler({ videoElement: video as unknown as HTMLVideoElement, onReady, onFirstData, onError, signal: controller.signal });
  handler.setup();
  handler.initializeBuffer(options.mime ?? H264_MIME);
  if (options.init !== false) handler.appendBuffer(initSegment(options.tracks));
  return { handler, video, onError, onReady, controller, mediaSource: video.mediaSource!, sourceBuffer: video.sourceBuffer! };
}

// a free box after the fragment brings it to `size` bytes without adding samples
function paddedFrame(index: number, size: number): ArrayBuffer {
  const frame = videoFrame(index, 2);
  const padding = new Uint8Array(size - frame.byteLength);
  new DataView(padding.buffer).setUint32(0, padding.byteLength);
  padding.set([0x66, 0x72, 0x65, 0x65], 4);
  return joinMessages(frame, padding.buffer);
}

function span(sourceBuffer: FakeSourceBuffer): number {
  const buffered = sourceBuffer.buffered;
  return buffered.length ? buffered.end(buffered.length - 1) - buffered.start(0) : 0;
}

beforeEach(() => {
  installMediaGlobals();
});

afterEach(() => {
  restoreMediaGlobals();
});

describe('MSE buffer trimming', () => {
  it.each([2, 8, 10])('plays nearly every frame with a %i s GOP and keeps the buffer bounded', async (gop) => {
    const { handler, video, sourceBuffer } = openHandler();
    const total = 60 * 25;
    let maxSpan = 0;

    for (let i = 0; i < total; i++) {
      handler.appendBuffer(videoFrame(i, gop));
      await settle();
      video.advance(FRAME_MS);
      maxSpan = Math.max(maxSpan, span(sourceBuffer));
    }

    expect(video.shown.size / total).toBeGreaterThanOrEqual(0.98);
    expect(sourceBuffer.removes.length).toBeGreaterThan(0);
    expect(maxSpan).toBeLessThanOrEqual(gop + STREAM_CONFIG.MSE.BUFFER_WINDOW + 1);
  });

  it('moves a lagging playhead onto a keyframe', async () => {
    const { handler, video, sourceBuffer } = openHandler();

    for (let i = 0; i < 12 * 25; i++) {
      handler.appendBuffer(videoFrame(i, 2));
      await settle();
    }

    expect(video.currentTime).toBeGreaterThan(0);
    expect(sourceBuffer.frameAt(video.currentTime)?.key).toBe(true);
  });

  it('evicts on QuotaExceeded only up to the keyframe before the playhead', async () => {
    const { handler, video, sourceBuffer, onError } = openHandler();
    for (let i = 0; i < 16 * 25; i++) {
      handler.appendBuffer(videoFrame(i, 4));
      await settle();
    }
    video.currentTime = 9;
    sourceBuffer.throwOnce = new DOMException('quota', 'QuotaExceededError');

    handler.appendBuffer(videoFrame(16 * 25, 4));
    const [, evictedTo] = sourceBuffer.removes.at(-1)!;
    await settle();

    expect(evictedTo).toBeLessThan(8);
    expect(evictedTo).toBeGreaterThan(7.9);
    expect(sourceBuffer.frameAt(9)).toBeDefined();
    expect(sourceBuffer.frameAt(16)).toBeDefined();
    expect(onError).not.toHaveBeenCalled();
  });

  it('keeps everything up to the hard limit when keyframes are unknown', async () => {
    const { handler, video, sourceBuffer } = openHandler({ init: false });
    const limit = STREAM_CONFIG.MSE.MAX_BUFFER_WINDOW;
    let maxSpan = 0;

    for (let i = 0; i < 90 * 25; i++) {
      handler.appendBuffer(videoFrame(i, 2));
      await settle();
      video.advance(FRAME_MS);
      maxSpan = Math.max(maxSpan, span(sourceBuffer));
    }

    expect(maxSpan).toBeGreaterThan(limit - 1);
    expect(maxSpan).toBeLessThanOrEqual(limit + 1);
  });

  it('cuts an audio-only stream anywhere', async () => {
    const { handler, video, sourceBuffer } = openHandler({ tracks: [{ id: 1, kind: 'audio', timescale: 48_000 }] });
    let maxSpan = 0;

    for (let i = 0; i < 900; i++) {
      handler.appendBuffer(fragment({ dts: i * 1024, kind: 'audio', timescale: 48_000, samples: [{ duration: 1024, key: true }] }));
      await settle();
      video.advance(1024 / 48);
      maxSpan = Math.max(maxSpan, span(sourceBuffer));
    }

    expect(maxSpan).toBeLessThanOrEqual(STREAM_CONFIG.MSE.BUFFER_WINDOW + 0.5);
  });
});

describe('MSE append queue', () => {
  it('drains bursts past the initial queue size intact and reuses the queue', async () => {
    const { handler, sourceBuffer, onError } = openHandler();

    // the init segment is still in flight, so the burst waits in the queue
    for (let i = 0; i < 6; i++) handler.appendBuffer(paddedFrame(i, 100 * 1024));
    await settle();
    // the first frame goes straight in, the rest queue behind it
    for (let i = 6; i < 22; i++) handler.appendBuffer(paddedFrame(i, 100 * 1024));
    await settle();

    expect(onError).not.toHaveBeenCalled();
    expect(sourceBuffer.appendCalls).toBe(4);
    expect(sourceBuffer.frames.map((f) => Math.round(f.pts * 25))).toEqual(Array.from({ length: 22 }, (_, i) => i));
  });

  it('reports an overflow only past the queue limit', () => {
    const { handler, onError } = openHandler();
    const size = STREAM_CONFIG.MSE.BUFFER_SIZE / 4;

    for (let i = 0; i < 4; i++) handler.appendBuffer(paddedFrame(i, size));
    expect(onError).not.toHaveBeenCalled();

    handler.appendBuffer(videoFrame(4, 2));
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0].message).toBe('MSE pending buffer overflow');
  });
});

describe('MSE error reporting', () => {
  it('reports a non-quota append failure once and stops appending', async () => {
    const { handler, sourceBuffer, onError } = openHandler();
    await settle();
    sourceBuffer.throwAlways = new DOMException('The HTMLMediaElement.error attribute is not null.', 'InvalidStateError');

    for (let i = 0; i < 5; i++) {
      handler.appendBuffer(videoFrame(i, 2));
      await settle();
    }

    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(expect.any(DOMException), 'runtime');
    expect(sourceBuffer.appendCalls).toBe(2);
  });

  it('reports a failed queued append without touching the released buffer', async () => {
    const { handler, sourceBuffer, onError } = openHandler();
    onError.mockImplementation(() => handler.close());

    // the init segment is still in flight, so this frame waits in the queue
    handler.appendBuffer(videoFrame(0, 2));
    sourceBuffer.throwAlways = new DOMException('decode', 'InvalidStateError');
    await settle();

    expect(onError).toHaveBeenCalledOnce();
  });

  it('reports a SourceBuffer error event', () => {
    const { sourceBuffer, onError } = openHandler();

    sourceBuffer.emit('error');

    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'runtime');
  });

  it('reports a decode error of the video element', () => {
    const { video, onError } = openHandler();

    video.fail(3, 'PIPELINE_ERROR_DECODE');

    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0].message).toContain('PIPELINE_ERROR_DECODE');
  });

  it('treats an ended MediaSource as dead', async () => {
    const { handler, mediaSource, onError } = openHandler();
    await settle();
    mediaSource.readyState = 'ended';

    handler.appendBuffer(videoFrame(0, 2));

    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'runtime');
  });

  it('reports an unsupported MIME type and a failed addSourceBuffer as setup errors', () => {
    FakeMediaSource.isTypeSupported.mockImplementation((mime: string) => !mime.includes('hvc1'));
    const unsupported = openHandler({ mime: H265_MIME, init: false });
    expect(unsupported.onError).toHaveBeenCalledWith(expect.any(Error), 'setup');
    expect(unsupported.onReady).not.toHaveBeenCalled();

    FakeMediaSource.nextAddSourceBufferError = new DOMException('no decoder', 'NotSupportedError');
    const refused = openHandler({ init: false });
    expect(refused.onError).toHaveBeenCalledWith(expect.any(DOMException), 'setup');
    expect(refused.onReady).not.toHaveBeenCalled();
  });

  it('stays quiet once closed', () => {
    const { handler, sourceBuffer, video, onError } = openHandler();

    handler.close();
    sourceBuffer.emit('error');
    video.fail(3, 'PIPELINE_ERROR_DECODE');

    expect(onError).not.toHaveBeenCalled();
    expect(video.listenerCount('error')).toBe(0);
  });
});
