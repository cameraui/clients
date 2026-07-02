import { STREAM_CONFIG } from './config.js';
import { filterSupportedCodecs, getMediaSourceConstructor, getSupportedCodecs, hasManagedMediaSource } from './utils.js';

export interface MSEHandlerOptions {
  videoElement: HTMLVideoElement;
  onReady: () => void;
  onFirstData: () => void;
  onError: (error: Error) => void;
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

export function createMSEHandler(options: MSEHandlerOptions): MSEHandler {
  const { videoElement, onReady, onFirstData, onError, signal } = options;

  let mediaSource: MediaSource | null = null;
  let sourceBuffer: SourceBuffer | null = null;
  let objectUrl: string | null = null;
  let isReady = false;
  let hasFirstData = false;

  let pendingBuffer = new Uint8Array(STREAM_CONFIG.MSE.BUFFER_SIZE);
  let pendingLength = 0;

  const earlyDataBuffer: ArrayBuffer[] = [];
  const supportedCodecs = getSupportedCodecs();

  function setup(): string | undefined {
    if (signal.aborted) return undefined;

    const MediaSourceConstructor = getMediaSourceConstructor();
    if (!MediaSourceConstructor) {
      onError(new Error('MediaSource not supported'));
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
    pendingBuffer = new Uint8Array(STREAM_CONFIG.MSE.BUFFER_SIZE);

    const MediaSourceConstructor = getMediaSourceConstructor();
    if (MediaSourceConstructor && !MediaSourceConstructor.isTypeSupported(mimeType)) {
      onError(new Error(`MIME type not supported: ${mimeType}`));
      return;
    }

    try {
      sourceBuffer = mediaSource.addSourceBuffer(mimeType);
      sourceBuffer.mode = 'segments';
      sourceBuffer.addEventListener('updateend', handleUpdateEnd);

      isReady = true;

      if (earlyDataBuffer.length > 0) {
        for (const earlyData of earlyDataBuffer) {
          appendBuffer(earlyData);
        }
        earlyDataBuffer.length = 0;
      }

      onReady();
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  function handleUpdateEnd(): void {
    if (signal.aborted || !sourceBuffer || !mediaSource) return;

    if (!sourceBuffer.updating && pendingLength > 0) {
      try {
        const data = pendingBuffer.slice(0, pendingLength);
        sourceBuffer.appendBuffer(data);
        pendingLength = 0;
      } catch (err) {
        // A swallowed failure here would stall the pipeline permanently: no
        // new update → no updateend → the queue never drains again and every
        // incoming frame accumulates until overflow.
        if (!recoverFromQuota(err)) {
          onError(err instanceof Error ? err : new Error(String(err)));
        }
      }
    }

    if (!sourceBuffer.updating && sourceBuffer.buffered?.length) {
      const end = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1);
      const start = end - STREAM_CONFIG.MSE.BUFFER_WINDOW;
      const start0 = sourceBuffer.buffered.start(0);

      if (!hasFirstData) {
        hasFirstData = true;
        onFirstData();
      }

      if (start > start0) {
        try {
          sourceBuffer.remove(start0, start);
          mediaSource.setLiveSeekableRange(start, end);
        } catch {
          // Ignore errors
        }
      }

      if (videoElement.currentTime < start) {
        videoElement.currentTime = start;
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
    if (signal.aborted) return;

    if (!sourceBuffer) {
      earlyDataBuffer.push(data);
      return;
    }

    if (mediaSource?.readyState === 'closed') {
      onError(new Error('MediaSource closed'));
      return;
    }

    if (sourceBuffer.updating || pendingLength > 0) {
      const bytes = new Uint8Array(data);
      if (pendingLength + bytes.byteLength > pendingBuffer.byteLength) {
        // Queue overflow — the SourceBuffer stopped draining. Uint8Array.set
        // would throw an uncaught RangeError inside the WS dispatch; surface
        // a proper error instead so the connection layer can recover.
        pendingLength = 0;
        onError(new Error('MSE pending buffer overflow'));
        return;
      }
      pendingBuffer.set(bytes, pendingLength);
      pendingLength += bytes.byteLength;
    } else {
      try {
        sourceBuffer.appendBuffer(data);
      } catch (err) {
        if (recoverFromQuota(err)) {
          // Queue the frame — the updateend fired by the eviction retries the
          // drain with it.
          const bytes = new Uint8Array(data);
          if (bytes.byteLength <= pendingBuffer.byteLength) {
            pendingBuffer.set(bytes, 0);
            pendingLength = bytes.byteLength;
          }
        }
      }
    }
  }

  // QuotaExceeded → evict the tail of the buffered range. remove() is async
  // and fires updateend, which re-attempts the pending drain. Returns true if
  // an eviction was started.
  function recoverFromQuota(err: unknown): boolean {
    if ((err as DOMException | undefined)?.name !== 'QuotaExceededError') return false;
    if (!sourceBuffer || sourceBuffer.updating || !sourceBuffer.buffered?.length) return false;
    try {
      const start0 = sourceBuffer.buffered.start(0);
      const end = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1);
      const evictTo = Math.max(start0 + 1, end - STREAM_CONFIG.MSE.BUFFER_WINDOW);
      if (evictTo <= start0) return false;
      sourceBuffer.remove(start0, evictTo);
      return true;
    } catch {
      return false;
    }
  }

  function close(): void {
    if (sourceBuffer) {
      sourceBuffer.removeEventListener('updateend', handleUpdateEnd);

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

export async function playVideo(videoElement: HTMLVideoElement): Promise<void> {
  try {
    await videoElement.play();
  } catch {
    if (!videoElement.muted) {
      videoElement.muted = true;
      await playVideo(videoElement);
    }
  }
}
