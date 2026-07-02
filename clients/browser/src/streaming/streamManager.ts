import type { StreamingRole } from '@camera.ui/sdk';
import type { ShallowRef } from 'vue';
import type { ReactiveStream, VideoStreamingMode } from './types.js';

export interface CachedStreamEntry {
  stream: ReactiveStream;
  videoElementRef: ShallowRef<HTMLVideoElement | undefined>;
  cameraDeviceRef: ShallowRef<unknown | undefined>;
  containerElementRef: ShallowRef<HTMLElement | undefined>;
  consumerContainerRefs: Set<ShallowRef<HTMLElement | undefined>>;
  sharedVideoElement: HTMLVideoElement | undefined;
  mediaStream: MediaStream | null;
  refCount: number;
}

export interface AcquireOptions {
  mode?: VideoStreamingMode;
  resolution?: StreamingRole;
}

export interface StreamManagerConfig {
  releaseDelay?: number;
}

class StreamManager {
  private streams = new Map<string, CachedStreamEntry>();
  private releaseTimers = new Map<string, NodeJS.Timeout>();
  private readonly releaseDelay: number;

  private readonly DEFAULT_RELEASE_DELAY = 2000;

  constructor(config: StreamManagerConfig = {}) {
    this.releaseDelay = config.releaseDelay ?? this.DEFAULT_RELEASE_DELAY;
  }

  public has(cameraName: string): boolean {
    return this.streams.has(cameraName);
  }

  public getRefCount(cameraName: string): number {
    return this.streams.get(cameraName)?.refCount ?? 0;
  }

  public get(cameraName: string): CachedStreamEntry | undefined {
    return this.streams.get(cameraName);
  }

  public acquire(cameraName: string, consumerContainerRef?: ShallowRef<HTMLElement | undefined>): CachedStreamEntry | undefined {
    this.cancelRelease(cameraName);

    const entry = this.streams.get(cameraName);
    if (entry) {
      entry.refCount++;
      if (consumerContainerRef) {
        entry.consumerContainerRefs.add(consumerContainerRef);
      }
      return entry;
    }

    return undefined;
  }

  public register(
    cameraName: string,
    stream: ReactiveStream,
    videoElementRef: ShallowRef<HTMLVideoElement | undefined>,
    cameraDeviceRef: ShallowRef<unknown | undefined>,
    containerElementRef: ShallowRef<HTMLElement | undefined>,
    sharedVideoElement: HTMLVideoElement | undefined,
  ): CachedStreamEntry {
    this.cancelRelease(cameraName);

    const entry: CachedStreamEntry = {
      stream,
      videoElementRef,
      cameraDeviceRef,
      containerElementRef,
      consumerContainerRefs: new Set([containerElementRef]),
      sharedVideoElement,
      mediaStream: null,
      refCount: 1,
    };

    this.streams.set(cameraName, entry);
    return entry;
  }

  public updateContainerElement(cameraName: string, container: HTMLElement | undefined): void {
    const entry = this.streams.get(cameraName);
    if (entry) {
      entry.containerElementRef.value = container;
    }
  }

  public updateSharedVideoElement(cameraName: string, videoElement: HTMLVideoElement | undefined): void {
    const entry = this.streams.get(cameraName);
    if (entry) {
      entry.sharedVideoElement = videoElement;
    }
  }

  public updateMediaStream(cameraName: string, mediaStream: MediaStream | null): void {
    const entry = this.streams.get(cameraName);
    if (entry) {
      entry.mediaStream = mediaStream;
    }
  }

  public release(cameraName: string, _videoElement?: HTMLVideoElement, consumerContainerRef?: ShallowRef<HTMLElement | undefined>): void {
    const entry = this.streams.get(cameraName);
    if (!entry) {
      return;
    }

    entry.refCount--;

    if (consumerContainerRef) {
      entry.consumerContainerRefs.delete(consumerContainerRef);

      const video = entry.sharedVideoElement;
      const releasingContainer = consumerContainerRef.value;
      const videoParent = video?.parentElement ?? null;

      if (entry.refCount > 0 && video && (videoParent === releasingContainer || videoParent === null || !videoParent.isConnected)) {
        const target = this.pickVisibleConsumer(entry, releasingContainer);
        if (target) {
          entry.containerElementRef = target.ref;
          if (video.parentElement !== target.el) {
            target.el.appendChild(video);
            video.play().catch(() => {});
          }
        }
      }
    }

    if (entry.refCount <= 0) {
      const timer = setTimeout(() => {
        this.doRelease(cameraName);
      }, this.releaseDelay);

      this.releaseTimers.set(cameraName, timer);
    }
  }

  public forceRelease(cameraName: string): void {
    this.cancelRelease(cameraName);
    this.doRelease(cameraName);
  }

  public clear(): void {
    for (const timer of this.releaseTimers.values()) {
      clearTimeout(timer);
    }
    this.releaseTimers.clear();

    for (const [cameraName, entry] of this.streams) {
      destroyStream(entry.stream);
      this.streams.delete(cameraName);
    }
  }

  public getDebugInfo(): { cameraName: string; refCount: number; mode: string; resolution: string }[] {
    return Array.from(this.streams.entries()).map(([cameraName, entry]) => ({
      cameraName,
      refCount: entry.refCount,
      mode: entry.stream.activeMode.value,
      resolution: entry.stream.activeResolution.value,
    }));
  }

  private pickVisibleConsumer(
    entry: CachedStreamEntry,
    excludeContainer: HTMLElement | undefined,
  ): { ref: ShallowRef<HTMLElement | undefined>; el: HTMLElement } | undefined {
    let fallback: { ref: ShallowRef<HTMLElement | undefined>; el: HTMLElement } | undefined;
    for (const ref of entry.consumerContainerRefs) {
      const el = ref.value;
      if (!el || el === excludeContainer || !el.isConnected) continue;
      const visible = el.checkVisibility?.() ?? el.offsetParent !== null;
      if (visible) return { ref, el };
      fallback ??= { ref, el };
    }
    return fallback;
  }

  private cancelRelease(cameraName: string): void {
    const timer = this.releaseTimers.get(cameraName);
    if (timer) {
      clearTimeout(timer);
      this.releaseTimers.delete(cameraName);
    }
  }

  private doRelease(cameraName: string): void {
    const entry = this.streams.get(cameraName);
    if (!entry) {
      return;
    }

    if (entry.refCount <= 0) {
      destroyStream(entry.stream);
      this.streams.delete(cameraName);
    }

    this.releaseTimers.delete(cameraName);
  }
}

function destroyStream(stream: ReactiveStream): void {
  const s = stream as ReactiveStream & { destroy?: () => void };
  if (typeof s.destroy === 'function') {
    s.destroy();
  } else {
    s.stop();
  }
}

export const streamManager = new StreamManager();

export function createStreamManager(config?: StreamManagerConfig): StreamManager {
  return new StreamManager(config);
}
