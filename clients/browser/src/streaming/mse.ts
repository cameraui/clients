import { STREAM_CONFIG } from './config.js';
import { createFmp4KeyframeScanner } from './fmp4.js';
import { filterSupportedCodecs, getMediaSourceConstructor, getSupportedCodecs, hasManagedMediaSource } from './utils.js';

export type MSEErrorPhase = 'setup' | 'runtime';

export interface MSEHandlerOptions {
  videoElement: HTMLMediaElement;
  onReady: () => void;
  onFirstData: () => void;
  onError: (error: Error, phase: MSEErrorPhase) => void;
  signal: AbortSignal;
}

export interface MSEHandler {
  readonly mediaSource: MediaSource | null;
  readonly sourceBuffer: SourceBuffer | null;
  readonly isReady: boolean;
  setup: () => string | undefined;
  initializeBuffer: (mimeType: string) => void;
  appendBuffer: (data: ArrayBuffer) => void;
  close: () => void;
}

const CUT_MARGIN = 0.001;
const MAX_KEYFRAMES = 256;
const LIVE_EDGE_MARGIN = 0.3;
const PENDING_INITIAL_SIZE = 256 * 1024;

export function createMSEHandler(options: MSEHandlerOptions): MSEHandler {
  const { videoElement, onReady, onFirstData, onError, signal } = options;

  let mediaSource: MediaSource | null = null;
  let sourceBuffer: SourceBuffer | null = null;
  let objectUrl: string | null = null;
  let isReady = false;
  let hasFirstData = false;
  let failed = false;

  let pendingBuffer = new Uint8Array(0);
  let pendingLength = 0;

  const earlyDataBuffer: ArrayBuffer[] = [];
  const supportedCodecs = getSupportedCodecs();
  const scanner = createFmp4KeyframeScanner();
  const keyframes: number[] = [];

  function setup(): string | undefined {
    if (signal.aborted) return undefined;

    const MediaSourceConstructor = getMediaSourceConstructor();
    if (!MediaSourceConstructor) {
      fail(new Error('MediaSource not supported'), 'setup');
      return undefined;
    }

    mediaSource = new MediaSourceConstructor();
    const isMMS = hasManagedMediaSource();
    const oldSrc = videoElement.src;

    mediaSource.addEventListener(
      'sourceopen',
      () => {
        if (signal.aborted) return;

        if (!isMMS && oldSrc && oldSrc.startsWith('blob:') && oldSrc !== videoElement.src) {
          URL.revokeObjectURL(oldSrc);
        }
      },
      { once: true },
    );

    if (isMMS) {
      videoElement.disableRemotePlayback = true;
      videoElement.srcObject = mediaSource;
    } else {
      objectUrl = URL.createObjectURL(mediaSource);
      videoElement.src = objectUrl;
      videoElement.srcObject = null;
    }
    videoElement.addEventListener('error', handleVideoError);

    const codecs = filterSupportedCodecs(supportedCodecs, MediaSourceConstructor.isTypeSupported.bind(MediaSourceConstructor));
    return codecs;
  }

  function initializeBuffer(mimeType: string): void {
    if (signal.aborted || !mediaSource) return;

    if (mediaSource.readyState !== 'open') {
      mediaSource.addEventListener(
        'sourceopen',
        () => {
          if (!signal.aborted) {
            initializeBuffer(mimeType);
          }
        },
        { once: true },
      );
      return;
    }

    pendingLength = 0;
    keyframes.length = 0;

    const MediaSourceConstructor = getMediaSourceConstructor();
    if (MediaSourceConstructor && !MediaSourceConstructor.isTypeSupported(mimeType)) {
      fail(new Error(`MIME type not supported: ${mimeType}`), 'setup');
      return;
    }

    try {
      sourceBuffer = mediaSource.addSourceBuffer(mimeType);
      sourceBuffer.mode = 'segments';
      sourceBuffer.addEventListener('updateend', handleUpdateEnd);
      sourceBuffer.addEventListener('error', handleSourceBufferError);

      isReady = true;

      if (earlyDataBuffer.length > 0) {
        for (const earlyData of earlyDataBuffer) {
          appendBuffer(earlyData);
        }
        earlyDataBuffer.length = 0;
      }

      if (failed || signal.aborted) return;
      onReady();
    } catch (err) {
      fail(err, isReady ? 'runtime' : 'setup');
    }
  }

  function handleUpdateEnd(): void {
    if (signal.aborted || failed || !sourceBuffer || !mediaSource) return;

    if (!sourceBuffer.updating && pendingLength > 0) {
      try {
        // appendBuffer copies synchronously, the queue can take new frames right after
        sourceBuffer.appendBuffer(pendingBuffer.subarray(0, pendingLength));
        pendingLength = 0;
      } catch (err) {
        // A swallowed failure here would stall the pipeline permanently: no
        // new update → no updateend → the queue never drains again and every
        // incoming frame accumulates until overflow.
        if (!recoverFromQuota(err)) {
          fail(err, 'runtime');
          return;
        }
      }
    }

    if (!sourceBuffer.updating && sourceBuffer.buffered?.length) {
      const end = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1);
      const start0 = sourceBuffer.buffered.start(0);
      const margin = STREAM_CONFIG.MSE.BUFFER_WINDOW;

      if (!hasFirstData) {
        hasFirstData = true;
        onFirstData();
      }

      let cut = cutPoint(Math.min(videoElement.currentTime, end) - margin);
      if (end - start0 > STREAM_CONFIG.MSE.MAX_BUFFER_WINDOW) {
        // a paused playhead or a stream without known keyframes must not grow the buffer forever
        const keyframe = cutPoint(end - margin);
        cut = keyframe !== undefined && keyframe > start0 + CUT_MARGIN ? keyframe : end - margin;
      }

      if (cut !== undefined && cut > start0 + CUT_MARGIN) {
        try {
          sourceBuffer.remove(start0, cut - CUT_MARGIN);
          mediaSource.setLiveSeekableRange(cut, end);
        } catch {
          // Ignore errors
        }
        forgetKeyframesBefore(cut);
      }

      if (videoElement.currentTime < end - margin) {
        const target = seekPoint(end - margin, end);
        if (target > videoElement.currentTime) {
          videoElement.currentTime = target;
        }
      }

      const gap = end - videoElement.currentTime;
      if (gap > 1) {
        videoElement.playbackRate = 1.1;
      } else if (gap < 0.1) {
        videoElement.playbackRate = 0.9;
      } else {
        videoElement.playbackRate = 1.0;
      }
    }
  }

  function appendBuffer(data: ArrayBuffer): void {
    if (signal.aborted || failed) return;

    if (!sourceBuffer) {
      earlyDataBuffer.push(data);
      return;
    }

    // after a decode error the source is ended and every append throws
    if (mediaSource?.readyState === 'closed' || mediaSource?.readyState === 'ended') {
      fail(new Error(`MediaSource ${mediaSource.readyState}`), 'runtime');
      return;
    }

    scanner.scan(data, noteKeyframe);

    if (sourceBuffer.updating || pendingLength > 0) {
      if (!enqueue(new Uint8Array(data))) {
        // Queue overflow — the SourceBuffer stopped draining. Uint8Array.set
        // would throw an uncaught RangeError inside the WS dispatch; surface
        // a proper error instead so the connection layer can recover.
        pendingLength = 0;
        fail(new Error('MSE pending buffer overflow'), 'runtime');
        return;
      }
    } else {
      try {
        sourceBuffer.appendBuffer(data);
      } catch (err) {
        if (recoverFromQuota(err)) {
          // Queue the frame — the updateend fired by the eviction retries the
          // drain with it.
          enqueue(new Uint8Array(data));
        } else {
          fail(err, 'runtime');
        }
      }
    }
  }

  function enqueue(bytes: Uint8Array): boolean {
    const needed = pendingLength + bytes.byteLength;
    if (needed > STREAM_CONFIG.MSE.BUFFER_SIZE) return false;
    if (needed > pendingBuffer.byteLength) {
      let size = Math.max(pendingBuffer.byteLength, PENDING_INITIAL_SIZE);
      while (size < needed) size *= 2;
      const grown = new Uint8Array(Math.min(size, STREAM_CONFIG.MSE.BUFFER_SIZE));
      grown.set(pendingBuffer.subarray(0, pendingLength));
      pendingBuffer = grown;
    }
    pendingBuffer.set(bytes, pendingLength);
    pendingLength = needed;
    return true;
  }

  function recoverFromQuota(err: unknown): boolean {
    if ((err as DOMException | undefined)?.name !== 'QuotaExceededError') return false;
    if (!sourceBuffer || sourceBuffer.updating || !sourceBuffer.buffered?.length) return false;
    try {
      const start0 = sourceBuffer.buffered.start(0);
      const end = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1);
      const evictTo = cutPoint(Math.min(videoElement.currentTime, end)) ?? Math.max(start0 + 1, end - STREAM_CONFIG.MSE.BUFFER_WINDOW);
      if (evictTo <= start0 + CUT_MARGIN) return false;
      sourceBuffer.remove(start0, evictTo - CUT_MARGIN);
      forgetKeyframesBefore(evictTo);
      return true;
    } catch {
      return false;
    }
  }

  function noteKeyframe(time: number): void {
    while (keyframes.length && keyframes[keyframes.length - 1] >= time) keyframes.pop();
    keyframes.push(time);
    if (keyframes.length > MAX_KEYFRAMES) keyframes.shift();
  }

  function forgetKeyframesBefore(time: number): void {
    while (keyframes.length && keyframes[0] < time) keyframes.shift();
  }

  function cutPoint(time: number): number | undefined {
    if (scanner.hasVideo === false) return time;
    for (let i = keyframes.length - 1; i >= 0; i--) {
      if (keyframes[i] <= time) return keyframes[i];
    }
    return undefined;
  }

  function seekPoint(time: number, end: number): number {
    if (!scanner.hasVideo) return time;
    let point = time;
    for (const keyframe of keyframes) {
      if (keyframe > end) break;
      point = keyframe;
      if (keyframe >= time) break;
    }
    return point;
  }

  function handleSourceBufferError(): void {
    fail(new Error('SourceBuffer error'), 'runtime');
  }

  function handleVideoError(): void {
    const error = videoElement.error;
    fail(new Error(error?.message || `Video element error ${error?.code ?? 'unknown'}`), 'runtime');
  }

  function fail(err: unknown, phase: MSEErrorPhase): void {
    if (failed || signal.aborted) return;
    failed = true;
    onError(err instanceof Error ? err : new Error(String(err)), phase);
  }

  function close(): void {
    videoElement.removeEventListener('error', handleVideoError);

    if (sourceBuffer) {
      sourceBuffer.removeEventListener('updateend', handleUpdateEnd);
      sourceBuffer.removeEventListener('error', handleSourceBufferError);

      if (mediaSource?.readyState === 'open') {
        try {
          mediaSource.removeSourceBuffer(sourceBuffer);
        } catch {
          // Ignore errors
        }
      }
      sourceBuffer = null;
    }

    if (mediaSource?.readyState === 'open') {
      try {
        mediaSource.endOfStream();
      } catch {
        // Ignore errors
      }
    }
    mediaSource = null;

    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }

    isReady = false;
    hasFirstData = false;
    pendingLength = 0;
    earlyDataBuffer.length = 0;
    keyframes.length = 0;
  }

  signal.addEventListener('abort', close, { once: true });

  return {
    get mediaSource() {
      return mediaSource;
    },
    get sourceBuffer() {
      return sourceBuffer;
    },
    get isReady() {
      return isReady;
    },
    setup,
    initializeBuffer,
    appendBuffer,
    close,
  };
}

export function chaseLiveEdge(video: HTMLMediaElement): void {
  if (video.buffered.length > 0) {
    const end = video.buffered.end(video.buffered.length - 1);
    if (end - video.currentTime > 1) {
      video.currentTime = end - LIVE_EDGE_MARGIN;
    }
  }
}

export async function playVideo(videoElement: HTMLMediaElement): Promise<void> {
  try {
    await videoElement.play();
  } catch {
    if (!videoElement.muted) {
      videoElement.muted = true;
      await playVideo(videoElement);
    }
  }
}
