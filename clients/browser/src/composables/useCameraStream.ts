import { tryOnScopeDispose } from '@vueuse/core';
import { computed, onBeforeUnmount, ref, shallowRef, toValue, watch } from 'vue';

import { createActivityMode } from '../streaming/activityMode.js';
import { createStreamConnection } from '../streaming/streamConnection.js';
import { streamManager } from '../streaming/streamManager.js';
import { useCameraById } from './useCameraById.js';
import { useCameraUi } from './useCameraUi.js';
import { useCuiFullscreen } from './useFullscreen.js';

import type { StreamingRole } from '@camera.ui/sdk';
import type { ComputedRef, HTMLAttributes, MaybeRefOrGetter, Ref, ShallowRef, WatchStopHandle } from 'vue';
import type { ActivityModeConfig, CameraActivityMode } from '../streaming/activityMode.js';
import type { StreamConnection } from '../streaming/streamConnection.js';
import type { CachedStreamEntry } from '../streaming/streamManager.js';
import type { ReactiveStream, StreamStatus, VideoStreamingMode } from '../streaming/types.js';
import type { ReactiveCameraDevice } from '../types.js';

const AUTO_STAGGER_STEP_MS = 75;
const AUTO_STAGGER_RESET_MS = 500;
let autoStaggerIndex = 0;
let autoStaggerLastTouch = 0;

function acquireAutoStaggerDelay(): number {
  const now = performance.now();
  if (now - autoStaggerLastTouch > AUTO_STAGGER_RESET_MS) {
    autoStaggerIndex = 0;
  }
  const delay = autoStaggerIndex * AUTO_STAGGER_STEP_MS;
  autoStaggerIndex++;
  autoStaggerLastTouch = now;
  return delay;
}

function isElementVisible(el: HTMLElement | null | undefined): boolean {
  if (!el || !el.isConnected) return false;
  return el.checkVisibility?.() ?? el.offsetParent !== null;
}

export interface CameraStream {
  readonly status: Ref<StreamStatus>;
  readonly isPlaying: Ref<boolean>;
  readonly activeMode: Ref<'webrtc' | 'webrtc/tcp' | 'mse'>;
  readonly activeResolution: Ref<StreamingRole>;
  readonly hasAudio: Ref<boolean>;
  readonly hasBackchannel: Ref<boolean>;
  readonly error: Ref<Error | undefined>;
  readonly isReconnecting: Ref<boolean>;
  readonly activityMode: Ref<CameraActivityMode>;
  readonly inStandby: Ref<boolean>;
  readonly hasActivity: Ref<boolean>;
  readonly isBusy: Ref<boolean>;
  readonly hasSound: Ref<boolean>;
  readonly hasIntercom: Ref<boolean>;
  readonly stream: ShallowRef<ReactiveStream | undefined>;

  readonly videoElement: ShallowRef<HTMLVideoElement | undefined>;
  readonly containerElement: ShallowRef<HTMLElement | undefined>;
  readonly fullscreenElement: ShallowRef<HTMLElement | undefined>;
  readonly renderElement: ComputedRef<HTMLVideoElement | HTMLCanvasElement | undefined>;

  readonly muted: ComputedRef<boolean>;
  readonly paused: ComputedRef<boolean>;
  readonly nativeWidth: Ref<number>;
  readonly nativeHeight: Ref<number>;
  readonly isPip: Ref<boolean>;
  readonly supportsPip: ComputedRef<boolean>;
  readonly isFullscreen: Ref<boolean>;
  readonly isCameraDisabled: ComputedRef<boolean>;

  start: () => Promise<void>;
  stop: () => void;
  restart: () => Promise<void>;
  resumeFromStandby: () => void;
  setMode: (mode: VideoStreamingMode) => Promise<void>;
  setResolution: (resolution: StreamingRole) => Promise<void>;
  setMicrophone: (track: MediaStreamTrack | null) => Promise<void>;
  setActivityMode: (mode: CameraActivityMode) => void;
  reportActivity: (hasActivity: boolean) => void;
  setMuted: (muted: boolean) => void;
  play: () => Promise<void>;
  pause: () => void;
  togglePip: () => void;
  toggleFullscreen: () => Promise<void>;
  captureScreenshot: () => string | null;
}

export interface UseCameraStreamOptions {
  camera: MaybeRefOrGetter<string | ReactiveCameraDevice>;
  mode?: MaybeRefOrGetter<VideoStreamingMode>;
  resolution?: MaybeRefOrGetter<StreamingRole>;
  activityMode?: MaybeRefOrGetter<CameraActivityMode>;
  activityConfig?: ActivityModeConfig;
  autoStart?: MaybeRefOrGetter<boolean>;
  startDelay?: number;
  isolated?: boolean;
  canvasStyle?: MaybeRefOrGetter<HTMLAttributes['style']>;
  canvasClass?: MaybeRefOrGetter<HTMLAttributes['class']>;
  videoStyle?: MaybeRefOrGetter<HTMLAttributes['style']>;
  videoClass?: MaybeRefOrGetter<HTMLAttributes['class']>;
}

export function useCameraStream(options: UseCameraStreamOptions): CameraStream {
  const { activityConfig, autoStart: autoStartOption = true, isolated = false } = options;
  const shouldAutoStart = () => toValue(autoStartOption);
  const startDelay = options.startDelay ?? acquireAutoStaggerDelay();
  const cleanupFns: WatchStopHandle[] = [];

  const { isConnected } = useCameraUi();

  const cameraGetter = computed(() => toValue(options.camera));
  const isCameraString = computed(() => typeof cameraGetter.value === 'string');
  const cameraName = computed(() => {
    const cam = cameraGetter.value;
    return typeof cam === 'string' ? cam : cam.name.value;
  });

  const lookupName = computed(() => (isCameraString.value ? cameraName.value : ''));
  const { camera: cameraDeviceFromLookup, isLoading: lookupLoading } = useCameraById(lookupName);
  const cameraDeviceLoading = computed(() => isCameraString.value && lookupLoading.value);

  const resolvedCameraDevice = computed<ReactiveCameraDevice | undefined>(() => {
    if (isCameraString.value) {
      return cameraDeviceFromLookup.value;
    }
    return cameraGetter.value as ReactiveCameraDevice;
  });

  let startDelayTimer: ReturnType<typeof setTimeout> | undefined;
  let ownedConnection: StreamConnection | undefined;
  let registeredCamName: string | undefined;

  const containerElement = shallowRef<HTMLElement | undefined>();
  const fullscreenElement = shallowRef<HTMLElement | undefined>();
  const videoElement = shallowRef<HTMLVideoElement | undefined>();
  const streamVideoElementRef = shallowRef<HTMLVideoElement | undefined>();
  const currentStream = shallowRef<ReactiveStream>();
  const cameraDeviceRef = shallowRef<ReactiveCameraDevice | undefined>();

  const isUsingCachedStream = ref(false);
  const initialized = ref(false);
  const cleanedUp = ref(false);
  const nativeWidth = ref(0);
  const nativeHeight = ref(0);
  const isPip = ref(false);
  const autoStartReady = ref(startDelay <= 0);

  if (startDelay > 0) {
    startDelayTimer = setTimeout(() => {
      autoStartReady.value = true;
    }, startDelay);
  }

  watch(
    resolvedCameraDevice,
    (device) => {
      cameraDeviceRef.value = device;
    },
    { immediate: true },
  );

  const isCameraDisabled = computed(() => cameraDeviceRef.value?.disabled.value === true);
  const status = computed<StreamStatus>(() => currentStream.value?.status.value ?? 'idle');
  const isPlaying = computed(() => currentStream.value?.isPlaying.value ?? false);
  const activeMode = computed<'webrtc' | 'webrtc/tcp' | 'mse'>(() => currentStream.value?.activeMode.value ?? 'webrtc');
  const activeResolution = computed<StreamingRole>(() => currentStream.value?.activeResolution.value ?? 'low-resolution');
  const hasAudio = computed(() => currentStream.value?.hasAudio.value ?? false);
  const hasBackchannel = computed(() => currentStream.value?.hasBackchannel.value ?? false);
  const error = computed(() => currentStream.value?.error.value);
  const isReconnecting = computed(() => status.value === 'reconnecting');
  const isBusy = computed(() => cameraDeviceLoading.value || (!isPlaying.value && status.value !== 'error'));
  const hasSound = computed(() => hasAudio.value && status.value === 'connected');
  const hasIntercom = computed(() => Boolean(typeof navigator !== 'undefined' && navigator.mediaDevices) && hasBackchannel.value);
  const muted = computed(() => currentStream.value?.muted.value ?? true);
  const paused = computed(() => currentStream.value?.paused.value ?? false);
  const supportsPip = computed(() => typeof document !== 'undefined' && document.pictureInPictureEnabled && !!videoElement.value);
  const renderElement = computed<HTMLVideoElement | HTMLCanvasElement | undefined>(() => videoElement.value);
  const fullscreenTarget = computed(() => fullscreenElement.value ?? containerElement.value);

  const activityModeManager = createActivityMode({
    initialMode: toValue(options.activityMode) ?? 'always-on',
    config: activityConfig,
    onStreamStart: () => {
      if (!isCameraDisabled.value) currentStream.value?.start();
    },
    onStreamStop: () => {
      if (isUsingCachedStream.value) {
        const camName = registeredCamName ?? cameraName.value;
        if (camName && streamManager.getRefCount(camName) > 1) return;
      }
      currentStream.value?.stop();
    },
    isStreamPlaying: () => isPlaying.value,
  });

  const { isFullscreen, toggle: toggleFullscreen } = useCuiFullscreen(fullscreenTarget);

  function createOwnedStream(): ReactiveStream {
    ownedConnection = createStreamConnection({
      camera: cameraDeviceRef,
      videoElement: streamVideoElementRef,
      containerElement,
      mode: computed(() => toValue(options.mode) ?? 'auto'),
      resolution: computed(() => toValue(options.resolution) ?? 'high-resolution'),
      autoStart: false,
    });
    return ownedConnection;
  }

  const ownedStream = createOwnedStream();

  function createVideoElement(): HTMLVideoElement {
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    video.disablePictureInPicture = false;
    video.preload = 'auto';
    video.style.position = 'absolute';
    video.style.width = '100%';
    video.style.height = '100%';
    video.style.inset = '0';
    video.style.objectFit = 'fill';
    return video;
  }

  function insertVideoIntoContainer(video: HTMLVideoElement, container: HTMLElement): void {
    if (video.parentElement && video.parentElement !== container) {
      video.parentElement.removeChild(video);
    }

    if (video.parentElement !== container) {
      container.appendChild(video);
    }
  }

  function reclaimSharedVideo(): void {
    if (isolated) return;
    const container = containerElement.value;
    const video = videoElement.value;
    if (!container || !video || video.parentElement === container) return;
    if (!isElementVisible(container) || isElementVisible(video.parentElement)) return;

    insertVideoIntoContainer(video, container);
    video.play().catch(() => {});

    const camName = cameraName.value;
    const entry = camName ? streamManager.get(camName) : undefined;
    if (entry) entry.containerElementRef = containerElement;
  }

  function onEnterPip(): void {
    isPip.value = true;
  }
  function onLeavePip(): void {
    isPip.value = false;
  }

  function initializeIsolated(): void {
    if (initialized.value) return;

    const container = containerElement.value;
    const camDevice = resolvedCameraDevice.value;

    if (!container || !camDevice || !isConnected.value) return;

    initialized.value = true;
    isUsingCachedStream.value = false;
    currentStream.value = ownedStream;

    const video = createVideoElement();
    videoElement.value = video;
    streamVideoElementRef.value = video;

    if (shouldAutoStart() && autoStartReady.value && activityModeManager.mode.value === 'always-on' && !isCameraDisabled.value) {
      ownedStream.start();
    }
  }

  function initialize(): void {
    if (initialized.value) return;

    if (isolated) {
      initializeIsolated();
      return;
    }

    const container = containerElement.value;
    const camName = cameraName.value;
    const camDevice = resolvedCameraDevice.value;

    if (!container || !camName || !isConnected.value) return;

    const cached = streamManager.acquire(camName, containerElement);

    if (cached) {
      initialized.value = true;
      registeredCamName = camName;
      isUsingCachedStream.value = true;
      currentStream.value = cached.stream;

      if (camDevice && cached.cameraDeviceRef) {
        cached.cameraDeviceRef.value = camDevice;
      }

      let video = cached.sharedVideoElement;
      if (!video) {
        video = createVideoElement();
        cached.sharedVideoElement = video;
        streamManager.updateSharedVideoElement(camName, video);
      }

      if (cached.mediaStream?.active) {
        video.srcObject = cached.mediaStream;
      }

      // Switch the active host ref to our container so release() can later
      // fall back to a remaining consumer if we unmount first. The shared
      // <video> is moved by the insertVideoIntoContainer watcher once
      // videoElement.value is set.
      if (container) {
        cached.containerElementRef = containerElement;
      }

      videoElement.value = video;
      cached.videoElementRef.value = video;

      setupCachedStreamWatchers(cached.stream, video, camName);

      if (shouldAutoStart() && autoStartReady.value && activityModeManager.mode.value === 'always-on' && !isCameraDisabled.value) {
        if (cached.stream.activeMode.value !== 'mse') {
          attachCachedStream(cached, video, camName);
        } else {
          video.play().catch(() => {});
        }
      }
    } else if (camDevice) {
      initialized.value = true;
      registeredCamName = camName;
      isUsingCachedStream.value = false;
      currentStream.value = ownedStream;

      const video = createVideoElement();
      videoElement.value = video;
      streamVideoElementRef.value = video;

      streamManager.register(camName, ownedStream, streamVideoElementRef, cameraDeviceRef, containerElement, video);

      if (shouldAutoStart() && autoStartReady.value && activityModeManager.mode.value === 'always-on' && !isCameraDisabled.value) {
        ownedStream.start();
      }

      const stopPlayingWatch = watch(
        () => ownedStream.isPlaying.value,
        (playing) => {
          if (playing && video.srcObject instanceof MediaStream) {
            streamManager.updateMediaStream(camName, video.srcObject);
          }
        },
        { immediate: true },
      );
      cleanupFns.push(stopPlayingWatch);

      const stopStatusWatch = watch(
        () => ownedStream.status.value,
        (status) => {
          if (status === 'connected') {
            if (video.srcObject instanceof MediaStream) {
              streamManager.updateMediaStream(camName, video.srcObject);
            }
          }
        },
      );
      cleanupFns.push(stopStatusWatch);
    }
  }

  function attachCachedStream(cached: CachedStreamEntry, video: HTMLVideoElement, camName: string): void {
    if (!cached) return;

    const stream = cached.stream;
    const streamMode = stream.activeMode.value;
    const streamStatus = stream.status.value;

    const mediaStreamValid = cached.mediaStream?.active && cached.mediaStream.getTracks().some((t) => t.readyState === 'live');

    if (streamMode === 'mse') {
      streamManager.updateMediaStream(camName, null);
      stream.restart();
    } else if (mediaStreamValid && cached.mediaStream) {
      video.srcObject = cached.mediaStream;
      video.play().catch(() => {});
    } else if (streamStatus === 'idle' || streamStatus === 'closed') {
      stream.start();
      watchForMediaStream(stream, video, camName);
    } else if (streamStatus === 'connected') {
      stream.restart();
      watchForMediaStream(stream, video, camName);
    } else {
      watchForMediaStream(stream, video, camName);
    }
  }

  function watchForMediaStream(stream: ReactiveStream, video: HTMLVideoElement, camName: string): void {
    const stopWatch = watch(
      [() => stream.isPlaying.value, () => stream.status.value],
      ([playing, status]) => {
        if (status === 'connected' || playing) {
          const cached = streamManager.get(camName);
          const mediaStream = cached?.mediaStream;

          if (mediaStream?.active && mediaStream.getTracks().some((t) => t.readyState === 'live')) {
            video.srcObject = mediaStream;
            video.play().catch(() => {});
            stopWatch();
          } else if (video.srcObject instanceof MediaStream) {
            streamManager.updateMediaStream(camName, video.srcObject);
            video.play().catch(() => {});
            stopWatch();
          }
        }
      },
      { immediate: true },
    );

    cleanupFns.push(stopWatch);
  }

  function setupCachedStreamWatchers(stream: ReactiveStream, video: HTMLVideoElement, camName: string): void {
    let wasDisconnected = stream.status.value !== 'connected';

    const stopStatusWatch = watch(
      () => stream.status.value,
      (status) => {
        if (status === 'reconnecting' || status === 'connecting') {
          wasDisconnected = true;
        } else if (status === 'connected' && wasDisconnected) {
          wasDisconnected = false;
          setTimeout(() => {
            if (video.srcObject instanceof MediaStream) {
              streamManager.updateMediaStream(camName, video.srcObject);
              video.play().catch(() => {});
            }
          }, 100);
        }
      },
      { immediate: true },
    );
    cleanupFns.push(stopStatusWatch);

    const stopPlayingWatch = watch(
      () => stream.isPlaying.value,
      (playing) => {
        if (playing && stream.activeMode.value !== 'mse') {
          if (video.srcObject instanceof MediaStream) {
            streamManager.updateMediaStream(camName, video.srcObject);
            video.play().catch(() => {});
          }
        }
      },
      { immediate: true },
    );
    cleanupFns.push(stopPlayingWatch);
  }

  async function start(): Promise<void> {
    if (isCameraDisabled.value) return;
    if (activityModeManager.inStandby.value) {
      activityModeManager.resumeFromStandby();
    } else {
      await currentStream.value?.start();
    }
  }

  function stop(): void {
    currentStream.value?.stop();
  }

  async function restart(): Promise<void> {
    await currentStream.value?.restart();
  }

  function resumeFromStandby(): void {
    if (isCameraDisabled.value) return;
    activityModeManager.resumeFromStandby();
  }

  async function setMode(mode: VideoStreamingMode): Promise<void> {
    const camName = cameraName.value;
    if (camName) {
      streamManager.updateMediaStream(camName, null);
    }
    await currentStream.value?.setMode(mode);
  }

  async function setResolution(resolution: StreamingRole): Promise<void> {
    await currentStream.value?.setResolution(resolution);
  }

  async function setMicrophone(track: MediaStreamTrack | null): Promise<void> {
    await currentStream.value?.setMicrophone(track);
  }

  function setActivityMode(mode: CameraActivityMode): void {
    activityModeManager.setMode(mode);
  }

  function reportActivity(detected: boolean): void {
    activityModeManager.reportActivity(detected);
  }

  function setMuted(newMuted: boolean): void {
    currentStream.value?.setMuted(newMuted);
    const video = videoElement.value;
    if (video) video.muted = newMuted;
  }

  async function playStream(): Promise<void> {
    await currentStream.value?.play();
  }

  function pauseStream(): void {
    currentStream.value?.pause();
  }

  function togglePip(): void {
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture();
    } else if (document.pictureInPictureEnabled && videoElement.value) {
      videoElement.value.requestPictureInPicture();
    }
  }

  function captureScreenshot(): string | null {
    const video = videoElement.value;
    if (!video || video.videoWidth === 0) return null;
    const tmp = document.createElement('canvas');
    tmp.width = video.videoWidth;
    tmp.height = video.videoHeight;
    tmp.getContext('2d')?.drawImage(video, 0, 0);
    return tmp.toDataURL('image/png');
  }

  function cleanup(): void {
    if (cleanedUp.value) return;
    cleanedUp.value = true;

    if (startDelayTimer) {
      clearTimeout(startDelayTimer);
      startDelayTimer = undefined;
    }

    // Immediately mute audio — stream may continue running (cached/debounced)
    // but the user should not hear audio from an unmounted component.
    currentStream.value?.setMuted(true);
    const video = videoElement.value;
    if (video) video.muted = true;

    for (const stopFn of cleanupFns) {
      stopFn();
    }
    cleanupFns.length = 0;

    if (isolated) {
      ownedConnection?.destroy();
    } else {
      const camName = registeredCamName;
      const video = videoElement.value;

      if (camName && initialized.value) {
        streamManager.release(camName, video, containerElement);
      }

      // The manager owns the stream lifecycle only when OUR connection was
      // registered (currentStream === ownedStream): other consumers keep it
      // alive, and doRelease() destroys it once the refcount hits zero. When
      // we rode a cached stream (or never initialized), the owned connection
      // never entered the manager — destroy it here or its detached scope
      // (watchers, visibility hooks) leaks for the page lifetime.
      if (!initialized.value || currentStream.value !== ownedStream) {
        ownedConnection?.destroy();
      }
    }

    activityModeManager.dispose();
  }

  function applyCanvasStyles(canvas: HTMLCanvasElement): void {
    const style = toValue(options.canvasStyle);
    const cls = toValue(options.canvasClass);

    if (style) {
      if (typeof style === 'string') {
        canvas.style.cssText += ';' + style;
      } else if (Array.isArray(style)) {
        for (const s of style) {
          if (typeof s === 'string') {
            canvas.style.cssText += ';' + s;
          } else if (s) {
            Object.assign(canvas.style, s);
          }
        }
      } else {
        Object.assign(canvas.style, style);
      }
    }

    if (cls) {
      if (typeof cls === 'string') {
        canvas.className = cls;
      } else if (Array.isArray(cls)) {
        canvas.className = cls.filter(Boolean).join(' ');
      } else {
        for (const [name, active] of Object.entries(cls)) {
          canvas.classList.toggle(name, !!active);
        }
      }
    }
  }

  if (!isolated && typeof IntersectionObserver !== 'undefined') {
    let visibilityObserver: IntersectionObserver | undefined;
    const stopVisibilityWatch = watch(
      containerElement,
      (container) => {
        visibilityObserver?.disconnect();
        visibilityObserver = undefined;
        if (!container) return;
        visibilityObserver = new IntersectionObserver((entries) => {
          if (entries.some((e) => e.isIntersecting)) reclaimSharedVideo();
        });
        visibilityObserver.observe(container);
      },
      { immediate: true },
    );
    cleanupFns.push(() => {
      stopVisibilityWatch();
      visibilityObserver?.disconnect();
    });
  }

  if (options.canvasStyle !== undefined || options.canvasClass !== undefined) {
    let stopCanvasListener: (() => void) | undefined;

    const stopContainerWatch = watch(
      containerElement,
      (container) => {
        stopCanvasListener?.();
        stopCanvasListener = undefined;
        if (!container) return;

        Array.from(container.querySelectorAll('canvas')).forEach((node) => {
          applyCanvasStyles(node as HTMLCanvasElement);
        });

        const observer = new MutationObserver((records) => {
          for (const r of records) {
            Array.from(r.addedNodes).forEach((added) => {
              if (added instanceof HTMLCanvasElement) {
                applyCanvasStyles(added);
              } else if (added instanceof HTMLElement) {
                Array.from(added.querySelectorAll('canvas')).forEach((c) => applyCanvasStyles(c as HTMLCanvasElement));
              }
            });
          }
        });
        observer.observe(container, { childList: true, subtree: true });
        stopCanvasListener = () => observer.disconnect();
      },
      { immediate: true },
    );

    cleanupFns.push(() => {
      stopContainerWatch();
      stopCanvasListener?.();
    });
  }

  if (options.videoStyle !== undefined || options.videoClass !== undefined) {
    const stopVideoStyleWatch = watch(
      [videoElement, () => toValue(options.videoStyle), () => toValue(options.videoClass)],
      ([video, style, cls]) => {
        if (!video) return;

        if (style) {
          if (typeof style === 'string') {
            video.style.cssText += ';' + style;
          } else if (Array.isArray(style)) {
            for (const s of style) {
              if (typeof s === 'string') {
                video.style.cssText += ';' + s;
              } else if (s) {
                Object.assign(video.style, s);
              }
            }
          } else {
            Object.assign(video.style, style);
          }
        }

        if (cls) {
          if (typeof cls === 'string') {
            video.className = cls;
          } else if (Array.isArray(cls)) {
            video.className = cls.filter(Boolean).join(' ');
          } else {
            for (const [name, active] of Object.entries(cls)) {
              video.classList.toggle(name, active);
            }
          }
        }
      },
      { immediate: true },
    );
    cleanupFns.push(stopVideoStyleWatch);
  }

  const stopDimensionSync = watch([() => currentStream.value?.nativeWidth.value, () => currentStream.value?.nativeHeight.value], ([w, h]) => {
    if (w && w > 0) nativeWidth.value = w;
    if (h && h > 0) nativeHeight.value = h;
  });
  cleanupFns.push(stopDimensionSync);

  const stopPipWatch = watch(
    videoElement,
    (video, oldVideo) => {
      if (oldVideo) {
        oldVideo.removeEventListener('enterpictureinpicture', onEnterPip);
        oldVideo.removeEventListener('leavepictureinpicture', onLeavePip);
      }
      if (video) {
        video.addEventListener('enterpictureinpicture', onEnterPip);
        video.addEventListener('leavepictureinpicture', onLeavePip);
      }
    },
    { immediate: true },
  );
  cleanupFns.push(stopPipWatch);

  watch(
    [containerElement, videoElement],
    ([container, video]) => {
      if (container && video) {
        insertVideoIntoContainer(video, container);
      }
    },
    { immediate: true },
  );

  watch(
    () => toValue(options.activityMode),
    (newMode) => {
      if (newMode && newMode !== activityModeManager.mode.value) {
        activityModeManager.setMode(newMode);
      }
    },
  );

  watch(
    [containerElement, resolvedCameraDevice, isConnected, autoStartReady],
    () => {
      if (!initialized.value) {
        initialize();
      } else if (
        autoStartReady.value &&
        shouldAutoStart() &&
        activityModeManager.mode.value === 'always-on' &&
        !isPlaying.value &&
        status.value === 'idle' &&
        !isCameraDisabled.value
      ) {
        // startDelay elapsed after initialize — trigger the deferred auto-start.
        // Gated on always-on like the initialize paths: standby/activity
        // consumers start via activity triggers, not the stagger timer.
        currentStream.value?.start();
      }
    },
    { immediate: true },
  );

  watch(isCameraDisabled, (disabled, wasDisabled) => {
    if (!initialized.value) return;

    if (!wasDisabled && disabled) {
      currentStream.value?.stop();
    } else if (wasDisabled && !disabled && shouldAutoStart()) {
      currentStream.value?.restart();
    }
  });

  onBeforeUnmount(cleanup);

  tryOnScopeDispose(cleanup);

  return {
    status,
    isPlaying,
    activeMode,
    activeResolution,
    hasAudio,
    hasBackchannel,
    error,
    isReconnecting,
    activityMode: activityModeManager.mode,
    inStandby: activityModeManager.inStandby,
    hasActivity: activityModeManager.hasActivity,
    isBusy,
    hasSound,
    hasIntercom,
    videoElement,
    containerElement,
    fullscreenElement,
    renderElement,
    stream: currentStream,
    muted,
    paused,
    nativeWidth,
    nativeHeight,
    isPip,
    supportsPip,
    isFullscreen,
    start,
    stop,
    restart,
    resumeFromStandby,
    setMode,
    setResolution,
    setMicrophone,
    setActivityMode,
    reportActivity,
    setMuted,
    play: playStream,
    pause: pauseStream,
    togglePip,
    isCameraDisabled,
    toggleFullscreen,
    captureScreenshot,
  };
}
