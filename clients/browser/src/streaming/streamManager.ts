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

    // If another consumer remains and we were the active host, reparent the
    // shared <video> to a remaining consumer's container so it doesn't end up
    // orphaned in a detached DOM subtree (happens when CuiCameraViewDnD's
    // fullscreen overlay unmounts and only the grid card consumer remains).
    if (consumerContainerRef) {
      entry.consumerContainerRefs.delete(consumerContainerRef);

      if (entry.refCount > 0 && consumerContainerRef.value === entry.containerElementRef.value) {
        for (const ref of entry.consumerContainerRefs) {
          const candidate = ref.value;
          if (candidate && candidate !== consumerContainerRef.value) {
            entry.containerElementRef = ref;
            if (entry.sharedVideoElement && entry.sharedVideoElement.parentElement !== candidate) {
              candidate.appendChild(entry.sharedVideoElement);
              entry.sharedVideoElement.play().catch(() => {});
            }
            break;
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
      entry.stream.stop();
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
      entry.stream.stop();
      this.streams.delete(cameraName);
    }

    this.releaseTimers.delete(cameraName);
  }
}

export const streamManager = new StreamManager();

export function createStreamManager(config?: StreamManagerConfig): StreamManager {
  return new StreamManager(config);
}
