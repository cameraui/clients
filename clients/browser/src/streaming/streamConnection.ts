/* eslint-disable @stylistic/max-len */
import { Logger } from '@camera.ui/logger';
import { classifyClose } from '@camera.ui/transport';
import { useTimeoutFn, whenever } from '@vueuse/core';
import { computed, effectScope, ref, shallowRef, toValue, watch } from 'vue';

import { useCameraUi } from '../composables/useCameraUi.js';
import { DEFAULT_TAB_PAUSE_MS, useTabVisibility } from '../composables/useTabVisibility.js';
import { createSourceName } from '../server/index.js';
import { STREAM_CONFIG } from './config.js';
import { createMJPEGHandler, isJpegFrame } from './mjpeg.js';
import { chaseLiveEdge, createMSEHandler, playVideo } from './mse.js';
import { abortableSleep, canPlayH265, canPlayMjpeg, checkWebRTCCompatibility, isVideoInPictureInPicture, reportH265DecodeFailure, suspendsWhenHidden } from './utils.js';
import { createBackchannelHandler, createWebRTCHandler, processWebRTCMessage } from './webrtc.js';

import type { CameraSource, ProbeStream, StreamingRole } from '@camera.ui/sdk';
import type { ConnectionTarget } from '@camera.ui/transport';
import type { WsCloseInfo, WsHandle, WsTransport } from '@camera.ui/transport/transports/ws';
import type { ComputedRef, MaybeRefOrGetter, Ref, ShallowRef } from 'vue';
import type { ReactiveCameraDevice } from '../types.js';
import type { MJPEGHandler } from './mjpeg.js';
import type { MSEErrorPhase, MSEHandler } from './mse.js';
import type { ActiveStreamingMode, Go2RTCMessage, ReactiveStream, StreamDegradeReason, StreamStatus, VideoStreamingMode } from './types.js';
import type { BackchannelHandler, WebRTCHandler } from './webrtc.js';

export interface StreamConnectionOptions {
  camera: MaybeRefOrGetter<ReactiveCameraDevice | undefined>;
  videoElement: MaybeRefOrGetter<HTMLVideoElement | undefined | null>;
  containerElement?: MaybeRefOrGetter<HTMLElement | undefined | null>;
  mode?: MaybeRefOrGetter<VideoStreamingMode>;
  resolution?: MaybeRefOrGetter<StreamingRole>;
  autoStart?: boolean;
}

const log = new Logger('StreamConnection');

const MSE_AUDIO_CODEC = /mp4a|opus|flac|mp3/i;
const RETRY_BASE_DELAY = 1000;
const RETRY_MAX_DELAY = 30_000;
const RETRY_RESET_AFTER = 30_000;
const WS_RESOLVE_TIMEOUT = 15_000;
const HEALTH_CHECK_INTERVAL = 1000;
const STALL_AFTER = 3000;
const STALL_RECONNECT_AFTER = 15_000;
const HAVE_CURRENT_DATA = 2;
const PROBE_WAIT_MS = 2_000;

type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: () => void) => number;
  cancelVideoFrameCallback?: (id: number) => void;
};

type SignalingPeer = WebRTCHandler | BackchannelHandler;

function isPageHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

function decodedFrames(video: HTMLVideoElement): number | undefined {
  return typeof video.getVideoPlaybackQuality === 'function' ? video.getVideoPlaybackQuality().totalVideoFrames : undefined;
}

function withJitter(delayMs: number): number {
  return delayMs * (1 - Math.random() / 2);
}

export class StreamConnection implements ReactiveStream {
  public readonly status: Ref<StreamStatus>;
  public readonly activeMode: Ref<ActiveStreamingMode>;
  public readonly requestedMode: Ref<VideoStreamingMode>;
  public readonly activeResolution: Ref<StreamingRole>;
  public readonly requestedResolution: Ref<StreamingRole>;
  public readonly degradedFrom: Ref<StreamingRole | null>;
  public readonly degradeReason: Ref<StreamDegradeReason | null>;
  public readonly source: ShallowRef<CameraSource | undefined>;
  public readonly hasVideo: Ref<boolean>;
  public readonly hasAudio: Ref<boolean>;
  public readonly hasBackchannel: Ref<boolean>;
  public readonly isPlaying: Ref<boolean>;
  public readonly stalled: Ref<boolean>;
  public readonly error: Ref<Error | undefined>;
  public readonly probeInfo: ShallowRef<ProbeStream | undefined>;
  public readonly muted: Ref<boolean>;
  public readonly paused: Ref<boolean>;
  public readonly nativeWidth: Ref<number>;
  public readonly nativeHeight: Ref<number>;

  private readonly camera: ComputedRef<ReactiveCameraDevice | undefined>;
  private readonly videoElement: ComputedRef<HTMLVideoElement | undefined | null>;
  private readonly containerElement: ComputedRef<HTMLElement | undefined | null>;
  private readonly target: Readonly<Ref<ConnectionTarget | null>>;
  private readonly isReady: ComputedRef<boolean>;
  private readonly triedSourceIds = new Set<string>();
  private readonly options: StreamConnectionOptions;
  private readonly wsTransport: WsTransport;
  private readonly scope = effectScope(true);
  private readonly stopsWhenHidden = suspendsWhenHidden();

  private connectionGeneration = 0;
  private abortController = new AbortController();
  private probedSourceId: string | undefined;
  private probeInFlight: { sourceId: string; result: Promise<ProbeStream | undefined> } | undefined;
  private probing: Promise<ProbeStream | undefined> | undefined;
  private wasPausedByVisibility = false;
  private hiddenPauseRan = false;
  private disarmPipWatch: (() => void) | null = null;
  private wsHandle: WsHandle | undefined;
  private wsOpenedAt = 0;
  private webrtcHandler: WebRTCHandler | undefined;
  private mseHandler: MSEHandler | undefined;
  private mjpegHandler: MJPEGHandler | undefined;
  private audioHandler: MSEHandler | undefined;
  private audioElement: HTMLAudioElement | undefined;
  private cancelFirstFrameWatch: (() => void) | undefined;
  private awaitingWebRTCFrame = false;
  private backchannelHandler: BackchannelHandler | undefined;
  private pendingMicTrack: MediaStreamTrack | null = null;
  private offerPeer: SignalingPeer | undefined;
  private answeredPeer: SignalingPeer | undefined;
  private lastMediaStream: MediaStream | null = null;
  private stopWatchers: (() => void)[] = [];
  private failures = 0;
  private playingSince: number | undefined;
  private connectToken: string | undefined;
  private rejectedToken: string | undefined;
  private lastError: Error | undefined;
  private mseRejected = false;
  private mseAnswerPending = false;
  private mseStopPending = false;
  private healthInterval: ReturnType<typeof setInterval> | undefined;
  private lastProgressAt = 0;
  private lastMediaTime = 0;
  private lastFrameCount: number | undefined;
  private frameCounterLive = false;

  private offTabVisible: (() => void) | undefined;
  private offTabPaused: (() => void) | undefined;
  private onVideoPauseBound: (() => void) | undefined;
  private onVideoPlayBound: (() => void) | undefined;
  private onVideoResizeBound: (() => void) | undefined;
  private startWsConnectTimeout!: () => void;
  private stopWsConnectTimeout!: () => void;
  private startConnectTimeout!: () => void;
  private stopConnectTimeout!: () => void;
  private startMseConnectTimeout!: () => void;
  private stopMseConnectTimeout!: () => void;

  constructor(options: StreamConnectionOptions) {
    this.options = options;

    const ctx = useCameraUi();
    if (!ctx.wsTransport) {
      throw new Error('[camera.ui] StreamConnection requires a wsTransport on CameraUiContext — pass `wsTransport` to createCameraUiPlugin.');
    }
    this.target = ctx.target;
    this.wsTransport = ctx.wsTransport;

    const { autoStart = true } = options;

    this.status = ref<StreamStatus>('idle');
    this.activeMode = ref<ActiveStreamingMode>('webrtc');
    this.activeResolution = ref<StreamingRole>('low-resolution');
    this.degradedFrom = ref<StreamingRole | null>(null);
    this.degradeReason = ref<StreamDegradeReason | null>(null);
    this.source = shallowRef<CameraSource | undefined>();
    this.hasVideo = ref(false);
    this.hasAudio = ref(false);
    this.hasBackchannel = ref(false);
    this.isPlaying = ref(false);
    this.stalled = ref(false);
    this.error = ref<Error | undefined>();
    this.probeInfo = shallowRef<ProbeStream | undefined>();
    this.muted = ref(true);
    this.paused = ref(false);
    this.nativeWidth = ref(0);
    this.nativeHeight = ref(0);
    this.requestedMode = ref<VideoStreamingMode>(toValue(options.mode) ?? 'auto');
    this.requestedResolution = ref<StreamingRole>(toValue(options.resolution) ?? 'high-resolution');

    this.camera = computed(() => toValue(options.camera));
    this.videoElement = computed(() => toValue(options.videoElement));
    this.containerElement = computed(() => toValue(options.containerElement));
    this.isReady = computed(() => !!this.camera.value && !!this.videoElement.value && !!this.target.value);

    this.scope.run(() => {
      const { onTabPaused, onTabVisible } = useTabVisibility();
      // a stalled reader of a hidden page holds the shared tunnel window for every other remote viewer
      const hiddenStopDelay = this.stopsWhenHidden ? 0 : DEFAULT_TAB_PAUSE_MS;

      const wsConnectTimeout = useTimeoutFn(
        () => {
          const handle = this.wsHandle;
          if (!handle || handle.readyState === WebSocket.OPEN) return;
          // readyState reads CLOSED while the transport still resolves the URL (HA sign_path), that step gets a longer budget
          if (handle.readyState === WebSocket.CLOSED && performance.now() - this.wsOpenedAt < WS_RESOLVE_TIMEOUT) {
            this.startWsConnectTimeout();
            return;
          }
          this.disconnectWebSocket();
          if (!this.abortController.signal.aborted && this.status.value !== 'closed') {
            this.retryLater();
          }
        },
        STREAM_CONFIG.WEBRTC.WS_CONNECT_TIMEOUT,
        { immediate: false },
      );

      const connectTimeout = useTimeoutFn(
        () => {
          if (this.abortController.signal.aborted) return;
          if (this.webrtcHandler && !this.webrtcHandler.isConnected) {
            if (this.requestedMode.value === 'auto') {
              this.fallBackToMSE();
            } else {
              this.retryAfterNoMedia();
            }
          } else if (
            (this.webrtcHandler && this.awaitingWebRTCFrame) ||
            (this.mjpegHandler && !this.isPlaying.value) ||
            (this.status.value === 'connected' && !this.isPlaying.value)
          ) {
            // a hidden page may not decode at all, judge the first frame once it can be seen
            if (isPageHidden()) {
              this.startConnectTimeout();
              return;
            }
            this.handleNoFramesWhileConnected();
          }
        },
        () => (this.webrtcTookOver() ? STALL_RECONNECT_AFTER : STREAM_CONFIG.WEBRTC.CONNECT_TIMEOUT),
        { immediate: false },
      );

      const mseConnectTimeout = useTimeoutFn(
        () => {
          if (this.abortController.signal.aborted || this.status.value === 'connected' || this.status.value === 'closed') return;
          if (this.mseHandler && !this.mseHandler.isReady) {
            this.retryAfterNoMedia();
          }
        },
        STREAM_CONFIG.WEBRTC.CONNECT_TIMEOUT,
        { immediate: false },
      );

      this.startWsConnectTimeout = wsConnectTimeout.start;
      this.stopWsConnectTimeout = wsConnectTimeout.stop;
      this.startConnectTimeout = connectTimeout.start;
      this.stopConnectTimeout = connectTimeout.stop;
      this.startMseConnectTimeout = mseConnectTimeout.start;
      this.stopMseConnectTimeout = mseConnectTimeout.stop;

      this.setupWatchers();

      this.offTabPaused = onTabPaused(
        () => {
          log.debug(`onTabPaused fired — status=${this.status.value}, isReady=${this.isReady.value}, target=${!!this.target.value}`);
          this.hiddenPauseRan = true;
          if (this.status.value === 'idle' || this.status.value === 'closed') {
            log.debug(`onTabPaused — already in ${this.status.value}, skipping stop()`);
            return;
          }
          if (isVideoInPictureInPicture(this.videoElement.value)) {
            log.debug('onTabPaused — video is in picture-in-picture, keeping the stream');
            this.watchPipLeave();
            return;
          }
          this.wasPausedByVisibility = true;
          this.stop();
          log.debug('onTabPaused — stop() done, wasPausedByVisibility=true');
        },
        { delayMs: hiddenStopDelay },
      );

      this.offTabVisible = onTabVisible(({ hiddenMs }) => {
        log.debug(
          `onTabVisible fired — wasPausedByVisibility=${this.wasPausedByVisibility}, status=${this.status.value}, isReady=${this.isReady.value}, target=${!!this.target.value}`,
        );
        this.disarmPipWatch?.();
        const pauseRan = this.hiddenPauseRan;
        this.hiddenPauseRan = false;
        if (this.wasPausedByVisibility) {
          this.wasPausedByVisibility = false;
          this.startWhenReady();
          return;
        }
        // the delayed stop never ran (frozen page), nothing has looked at the socket since
        if (!pauseRan && hiddenMs >= hiddenStopDelay && this.status.value === 'connected') {
          log.debug(`onTabVisible: hidden for ${hiddenMs}ms without a stop, reconnecting`);
          this.restart();
          return;
        }
        log.debug('onTabVisible — not paused by visibility, no-op');
      });

      if (autoStart) {
        whenever(
          this.isReady,
          () => {
            if (this.status.value === 'idle' || this.status.value === 'closed') {
              this.start();
            }
          },
          { immediate: true },
        );
      }
    });
  }

  private watchPipLeave(): void {
    if (this.disarmPipWatch) return;
    const video = this.videoElement.value;
    if (!video) return;

    const onLeave = () => {
      if (isVideoInPictureInPicture(video)) return;
      this.disarmPipWatch?.();
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') return;
      if (this.status.value === 'idle' || this.status.value === 'closed') return;
      log.debug('picture-in-picture closed while tab hidden — stopping the stream');
      this.wasPausedByVisibility = true;
      this.stop();
    };
    video.addEventListener('leavepictureinpicture', onLeave);
    video.addEventListener('webkitpresentationmodechanged', onLeave);
    this.disarmPipWatch = () => {
      video.removeEventListener('leavepictureinpicture', onLeave);
      video.removeEventListener('webkitpresentationmodechanged', onLeave);
      this.disarmPipWatch = null;
    };
  }

  public async start(): Promise<void> {
    log.debug(`start() called — status=${this.status.value}, isReady=${this.isReady.value}`);
    if (this.status.value !== 'idle' && this.status.value !== 'closed') {
      log.debug(`start() — skipped, status is ${this.status.value}`);
      return;
    }
    if (!this.isReady.value) {
      log.debug('start() — skipped, isReady=false');
      return;
    }
    if (this.stopsWhenHidden && isPageHidden()) {
      log.debug('start() — page hidden, starting once it is visible');
      this.wasPausedByVisibility = true;
      return;
    }

    this.cleanup();
    this.abortController = new AbortController();
    const gen = ++this.connectionGeneration;

    this.triedSourceIds.clear();
    this.failures = 0;
    this.playingSince = undefined;
    this.status.value = 'connecting';
    this.error.value = undefined;
    this.isPlaying.value = false;

    try {
      const init = this.initializeSource();
      if (init === 'unsupported') {
        log.debug('start() — no source with a playable codec');
        this.setUnsupported();
        return;
      }
      if (!init) {
        log.debug('start() — no streaming source available');
        this.error.value = new Error('No streaming source available');
        this.status.value = 'error';
        return;
      }

      let dialedSourceId: string | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        const probedSourceId = this.source.value?._id;
        dialedSourceId = probedSourceId;
        log.debug('start(): connecting WebSocket');
        const probe = await this.dialWithProbe();

        // Stale check: restart()/stop() have started a new generation
        if (gen !== this.connectionGeneration) {
          log.debug('start() — generation stale after probe, aborting');
          return;
        }

        // The probe is authoritative for this source — taint before
        // connecting instead of waiting for the no-frames timeout.
        if (probe && probedSourceId && this.probeSaysUnplayable(probe)) {
          this.triedSourceIds.add(probedSourceId);
        }

        const reinit = this.initializeSource();
        if (reinit === 'unsupported') {
          this.disconnectWebSocket();
          this.setUnsupported();
          return;
        }
        if (!reinit) {
          this.disconnectWebSocket();
          this.error.value = new Error('No streaming source available');
          this.status.value = 'error';
          return;
        }

        // settled on the probed source, or the probe failed: keep the socket and let
        // the runtime net catch a wrong guess
        if (!probe || this.source.value?._id === probedSourceId) break;
      }
      if (this.source.value?._id !== dialedSourceId) this.dialWithProbe();
    } catch (err) {
      if (gen !== this.connectionGeneration) return;
      log.debug('start() — error:', err);
      this.error.value = err instanceof Error ? err : new Error(String(err));
      this.status.value = 'error';
    }
  }

  public stop(): void {
    if (this.status.value === 'closed') {
      log.debug('stop() — already closed, no-op');
      return;
    }
    log.debug(`stop() — was ${this.status.value}, transitioning to closed`);
    ++this.connectionGeneration;
    this.status.value = 'closed';
    this.isPlaying.value = false;
    this.cleanup();
  }

  public async setMode(mode: VideoStreamingMode): Promise<void> {
    if (this.requestedMode.value === mode) return;

    this.requestedMode.value = mode;
    this.activeMode.value = mode === 'auto' ? 'webrtc' : mode;

    // A mode switch changes codec playability (MSE vs WebRTC H.265 support
    // differ) — re-evaluate from scratch when stuck in 'unsupported'.
    if (this.status.value === 'unsupported') {
      this.stop();
      await this.start();
      return;
    }

    // Only restart if already connected — during 'connecting', start() will
    // pick up the updated refs naturally when it reaches handleWsOpen().
    if (this.status.value === 'connected') {
      await this.restart();
    }
  }

  public async setResolution(resolution: StreamingRole): Promise<void> {
    if (this.requestedResolution.value === resolution) return;

    this.requestedResolution.value = resolution;

    if (this.status.value === 'unsupported') {
      this.stop();
      await this.start();
      return;
    }

    const result = this.getSourceForResolution(resolution);

    if (result && result !== 'unsupported' && result.source._id !== this.source.value?._id) {
      this.source.value = result.source;
      this.activeResolution.value = result.effectiveResolution;
      this.degradedFrom.value = result.degradedFrom;
      this.degradeReason.value = result.degradedFrom ? 'codec' : null;

      // Only restart if already connected — during 'connecting', start()
      // re-reads the source after its probe and dials again on a change.
      if (this.status.value === 'connected') {
        await this.restart();
      }
    }
  }

  public async setMicrophone(track: MediaStreamTrack | null): Promise<void> {
    if (!track) {
      this.closeBackchannel();
      return;
    }
    if (!this.hasBackchannel.value) return;

    this.pendingMicTrack = track;
    if (!this.backchannelHandler) {
      await this.startBackchannel();
    } else if (this.backchannelHandler.isConnected) {
      await this.backchannelHandler.setMicrophoneTrack(track);
    }
  }

  public setMuted(muted: boolean): void {
    this.muted.value = muted;
    const video = this.videoElement.value;
    if (video) video.muted = muted;
    if (this.audioElement) this.audioElement.muted = muted;
  }

  public async play(): Promise<void> {
    this.paused.value = false;
    const video = this.videoElement.value;
    if (!video) return;
    try {
      await video.play();
    } catch {
      if (!video.muted) {
        video.muted = true;
        this.muted.value = true;
        try {
          await video.play();
        } catch {
          /* ignore */
        }
      }
    }

    const audio = this.audioElement;
    if (audio) {
      audio.muted = this.muted.value;
      audio.play().catch(() => {});
    }
  }

  public pause(): void {
    this.paused.value = true;
    const video = this.videoElement.value;
    if (video) video.pause();
    this.audioElement?.pause();
  }

  public destroy(): void {
    for (const stopWatcher of this.stopWatchers) {
      stopWatcher();
    }
    this.stopWatchers = [];

    this.offTabVisible?.();
    this.offTabVisible = undefined;
    this.offTabPaused?.();
    this.offTabPaused = undefined;
    this.disarmPipWatch?.();

    const video = this.videoElement.value;
    if (video) {
      if (this.onVideoPauseBound) video.removeEventListener('pause', this.onVideoPauseBound);
      if (this.onVideoPlayBound) video.removeEventListener('play', this.onVideoPlayBound);
      if (this.onVideoResizeBound) video.removeEventListener('resize', this.onVideoResizeBound);
    }

    this.stop();
    this.scope.stop();
  }

  public restart(): Promise<void> {
    return this.reconnect(1000);
  }

  public invalidateProbe(): void {
    this.probeInfo.value = undefined;
    this.probeInFlight = undefined;
  }

  private async reconnect(delayMs: number, waitStatus: 'reconnecting' | 'error' = 'reconnecting'): Promise<void> {
    this.status.value = waitStatus;
    this.isPlaying.value = false;
    this.cleanup();

    this.abortController = new AbortController();
    const gen = ++this.connectionGeneration;

    try {
      await abortableSleep(delayMs, this.abortController.signal);
    } catch {
      return;
    }

    // Stale check
    if (gen !== this.connectionGeneration) return;

    if (!this.isReady.value) {
      this.status.value = 'idle';
      return;
    }

    this.status.value = 'reconnecting';
    try {
      const init = this.initializeSource();
      if (init === 'unsupported') {
        this.setUnsupported();
        return;
      }
      if (!init) {
        this.error.value = new Error('No streaming source available');
        this.status.value = 'error';
        return;
      }
      this.dialWithProbe();
    } catch (err) {
      if (gen !== this.connectionGeneration) return;
      this.error.value = err instanceof Error ? err : new Error(String(err));
      this.status.value = 'error';
    }
  }

  private retryLater(err?: Error): void {
    const delay = this.nextRetryDelay();
    if (err) this.error.value = err;
    this.reconnect(delay, err ? 'error' : 'reconnecting');
  }

  private nextRetryDelay(): number {
    if (this.playingSince !== undefined && performance.now() - this.playingSince >= RETRY_RESET_AFTER) {
      this.failures = 0;
    }
    this.playingSince = undefined;
    const base = Math.min(RETRY_BASE_DELAY * 2 ** this.failures, RETRY_MAX_DELAY);
    this.failures++;
    return withJitter(base);
  }

  private retryAfterNoMedia(): void {
    if (this.markSourceUndecodable()) {
      this.restart();
      return;
    }
    this.retryLater(this.lastError);
  }

  private startWhenReady(): void {
    if (this.isReady.value) {
      log.debug('startWhenReady — already ready, calling start() now');
      this.start();
      return;
    }
    log.debug(`startWhenReady — not ready (camera=${!!this.camera.value}, video=${!!this.videoElement.value}, target=${!!this.target.value}), watching isReady`);
    const stop = watch(this.isReady, (ready) => {
      if (!ready) return;
      log.debug('startWhenReady — isReady → true, calling start()');
      stop();
      this.start();
    });
    this.stopWatchers.push(stop);
  }

  private setupWatchers(): void {
    const stopAuthWatch = watch(
      () => this.target.value?.endpoint.url ?? null,
      (next, prev) => {
        if (!next || !prev || next === prev) return;
        if (this.status.value === 'idle' || this.status.value === 'closed') return;
        this.restart();
      },
    );
    this.stopWatchers.push(stopAuthWatch);

    const stopTokenWatch = watch(
      () => this.target.value?.tokens.access,
      (token) => {
        if (this.rejectedToken === undefined || !token || token === this.rejectedToken) return;
        this.rejectedToken = undefined;
        if (this.status.value === 'idle' || this.status.value === 'closed') return;
        this.reconnect(0);
      },
    );
    this.stopWatchers.push(stopTokenWatch);

    // camera updates swap the inner refs, not the device object — a stream
    // stuck in 'unsupported' re-evaluates when source metadata changes
    const stopSourcesWatch = watch(
      () => this.camera.value?.sources.value,
      () => {
        if (this.status.value !== 'unsupported') return;
        this.stop();
        this.start();
      },
    );
    this.stopWatchers.push(stopSourcesWatch);

    const stopModeWatch = watch(
      () => toValue(this.options.mode),
      (newMode) => {
        if (newMode !== undefined && newMode !== this.requestedMode.value) {
          this.setMode(newMode);
        }
      },
    );
    this.stopWatchers.push(stopModeWatch);

    const stopResolutionWatch = watch(
      () => toValue(this.options.resolution),
      (newResolution) => {
        if (newResolution !== undefined && newResolution !== this.requestedResolution.value) {
          this.setResolution(newResolution);
        }
      },
    );
    this.stopWatchers.push(stopResolutionWatch);

    const stopVideoElWatch = watch(
      this.videoElement,
      (video, oldVideo) => {
        if (oldVideo) {
          if (this.onVideoPauseBound) oldVideo.removeEventListener('pause', this.onVideoPauseBound);
          if (this.onVideoPlayBound) oldVideo.removeEventListener('play', this.onVideoPlayBound);
          if (this.onVideoResizeBound) oldVideo.removeEventListener('resize', this.onVideoResizeBound);
        }
        if (video) {
          this.onVideoPauseBound = () => {
            if (!this.paused.value) {
              // Unintended pause → auto-resume
              video.play().catch(() => {});
            }
          };
          this.onVideoPlayBound = () => {
            this.paused.value = false;
          };
          this.onVideoResizeBound = () => {
            if (video.videoWidth > 0 && video.videoHeight > 0) {
              this.nativeWidth.value = video.videoWidth;
              this.nativeHeight.value = video.videoHeight;
            }
          };
          video.addEventListener('pause', this.onVideoPauseBound);
          video.addEventListener('play', this.onVideoPlayBound);
          video.addEventListener('resize', this.onVideoResizeBound);
          if (video.videoWidth > 0 && video.videoHeight > 0) {
            this.nativeWidth.value = video.videoWidth;
            this.nativeHeight.value = video.videoHeight;
          }
        }
      },
      { immediate: true },
    );
    this.stopWatchers.push(stopVideoElWatch);

    const stopHealthWatch = watch(
      () => this.status.value === 'connected' && this.isPlaying.value,
      (active) => {
        this.stopHealthCheck();
        if (active) this.startHealthCheck();
      },
      { immediate: true },
    );
    this.stopWatchers.push(stopHealthWatch);

    const stopCameraWatch = watch([this.camera, this.videoElement, () => this.target.value], ([newCamera, newVideo, newClient], [oldCamera, oldVideo]) => {
      if (newCamera !== oldCamera) {
        // Only restart when already connected — during 'connecting', start()
        // picks up the current camera automatically (refs are already up-to-date)
        if (this.status.value === 'connected') {
          if (newCamera && newVideo && newClient) {
            this.restart();
          }
        } else if (this.status.value === 'unsupported' && newCamera && newVideo && newClient) {
          // camera update may carry corrected codec metadata — re-evaluate;
          // if nothing changed this lands back in 'unsupported' without connecting
          this.stop();
          this.start();
        }
      } else if (newVideo !== oldVideo && newVideo) {
        if (newVideo.srcObject instanceof MediaStream) {
          const existingStream = newVideo.srcObject;
          if (existingStream.active && existingStream.getTracks().some((t) => t.readyState === 'live')) {
            playVideo(newVideo);
            this.lastMediaStream = existingStream;
            return;
          }
        }

        if (this.status.value === 'connected' && this.activeMode.value !== 'mse') {
          const mediaStream = this.lastMediaStream;
          if (mediaStream?.active && mediaStream.getTracks().some((t) => t.readyState === 'live')) {
            newVideo.srcObject = mediaStream;
            playVideo(newVideo);
          } else {
            this.restart();
          }
        } else if (this.status.value === 'connected' && this.activeMode.value === 'mse') {
          this.restart();
        } else if (this.status.value === 'connecting' || this.status.value === 'reconnecting') {
          const stopConnectionWatch = watch(
            () => this.isPlaying.value,
            (playing) => {
              const currentVideo = this.videoElement.value;
              if (playing && currentVideo?.srcObject instanceof MediaStream) {
                playVideo(currentVideo);
                stopConnectionWatch();
              } else if (playing && currentVideo && !currentVideo.srcObject) {
                if (this.lastMediaStream?.active) {
                  currentVideo.srcObject = this.lastMediaStream;
                  playVideo(currentVideo);
                  stopConnectionWatch();
                }
              }
            },
            { immediate: true },
          );
          this.stopWatchers.push(stopConnectionWatch);
        }
      }
    });
    this.stopWatchers.push(stopCameraWatch);
  }

  private isSourcePlayable(source: CameraSource): boolean {
    if (this.triedSourceIds.has(source._id)) return false;
    if (source.videoCodec === 'JPEG') return canPlayMjpeg();
    if (source.videoCodec !== 'H265') return true;

    const mode = this.requestedMode.value;
    if (mode === 'auto') return canPlayH265('auto');
    if (mode === 'mse') return canPlayH265('mse');
    return canPlayH265('webrtc');
  }

  // prettier-ignore
  private getSourceForResolution(resolution: StreamingRole):
    | {
      source: CameraSource;
      effectiveResolution: StreamingRole;
      degradedFrom: StreamingRole | null;
    }
    | 'unsupported'
    | undefined {
    const cam = this.camera.value;
    if (!cam) return undefined;

    const resolutionOrder: StreamingRole[] = ['high-resolution', 'mid-resolution', 'low-resolution'];
    const startIndex = Math.max(0, resolutionOrder.indexOf(resolution));

    let skippedUnplayable = false;
    for (let i = startIndex; i < resolutionOrder.length; i++) {
      const src = cam.sources.value.find((s) => s.role === resolutionOrder[i]);
      if (!src) continue;
      if (!this.isSourcePlayable(src)) {
        skippedUnplayable = true;
        continue;
      }
      return { source: src, effectiveResolution: resolutionOrder[i], degradedFrom: skippedUnplayable ? resolution : null };
    }

    const fallback = cam.streamSource.value;
    if (fallback && this.isSourcePlayable(fallback)) {
      return { source: fallback, effectiveResolution: (fallback.role as StreamingRole) ?? 'low-resolution', degradedFrom: skippedUnplayable ? resolution : null };
    }

    // sources exist but none is decodable here — terminal, not "no source"
    if (skippedUnplayable || fallback) return 'unsupported';
    return undefined;
  }

  private initializeSource(): boolean | 'unsupported' {
    const result = this.getSourceForResolution(this.requestedResolution.value);
    if (!result) return false;
    if (result === 'unsupported') return 'unsupported';

    this.source.value = result.source;
    this.activeResolution.value = result.effectiveResolution;
    this.degradedFrom.value = result.degradedFrom;
    this.degradeReason.value = result.degradedFrom ? 'codec' : null;

    if (this.probedSourceId && this.probedSourceId !== result.source._id) {
      this.probeInfo.value = undefined;
      this.probedSourceId = undefined;
      this.hasVideo.value = false;
      this.hasAudio.value = false;
      this.hasBackchannel.value = false;
    }
    return true;
  }

  private setUnsupported(): void {
    const cam = this.camera.value;
    const codec = cam?.sources.value.find((s) => s.videoCodec)?.videoCodec ?? 'H265';
    this.error.value = new Error(`${codec} cannot be played on this device`);
    this.status.value = 'unsupported';
  }

  private probeSaysUnplayable(probe: ProbeStream): boolean {
    const video = probe.video.filter((v) => v.direction === 'sendonly');
    if (!video.length) return false;
    if (video.every((v) => v.codec === 'JPEG')) return !canPlayMjpeg();
    if (!video.every((v) => v.codec === 'H265')) return false;
    const mode = this.requestedMode.value;
    return !canPlayH265(mode === 'auto' ? 'auto' : mode === 'mse' ? 'mse' : 'webrtc');
  }

  private sourceLikelyH265(): boolean {
    const src = this.source.value;
    if (!src) return false;
    if (src.videoCodec === 'H265') return true;
    if (src.videoCodec !== undefined) return false;

    const video = this.probeInfo.value?.video.filter((v) => v.direction === 'sendonly') ?? [];
    return video.length > 0 && video.every((v) => v.codec === 'H265');
  }

  private markSourceUndecodable(): boolean {
    const src = this.source.value;
    if (!src || !this.sourceLikelyH265()) return false;
    this.triedSourceIds.add(src._id);
    this.invalidateProbe();
    return true;
  }

  private handleNoFramesWhileConnected(): void {
    // a missed first frame after a takeover may only be a late keyframe, too weak to rule out H.265 for the whole page
    if (this.sourceLikelyH265() && !this.webrtcTookOver()) {
      reportH265DecodeFailure(this.activeMode.value === 'mse' ? 'mse' : 'webrtc');
    }

    if (this.requestedMode.value === 'auto' && this.activeMode.value !== 'mse' && !this.mjpegHandler && !this.mseRejected) {
      this.webrtcHandler?.close();
      this.webrtcHandler = undefined;
      this.awaitingWebRTCFrame = false;
      this.activeMode.value = 'mse';
      this.isPlaying.value = false;
      this.status.value = 'reconnecting';
      this.startMSE();
      this.resumeBackchannel();
      return;
    }

    this.retryAfterNoMedia();
  }

  private webrtcTookOver(): boolean {
    return this.awaitingWebRTCFrame && this.isPlaying.value;
  }

  private noteDeliveredAudio(delivered: boolean): void {
    if (delivered && !this.hasAudio.value) {
      this.hasAudio.value = true;
    }
  }

  private probeStream(): Promise<ProbeStream | undefined> {
    const cam = this.camera.value;
    const source = this.source.value;
    if (!cam || !source || this.abortController.signal.aborted) return Promise.resolve(undefined);
    // while the NATS link is down a probe waits for it, the next dials of its source wait on the same one
    if (this.probeInFlight?.sourceId === source._id) return this.probeInFlight.result;

    const entry = { sourceId: source._id, result: Promise.resolve<ProbeStream | undefined>(undefined) };
    this.probeInFlight = entry;
    entry.result = this.askProbe(cam, entry);
    return entry.result;
  }

  private async askProbe(cam: ReactiveCameraDevice, entry: { sourceId: string }): Promise<ProbeStream | undefined> {
    try {
      const probe = await cam.probeStream(entry.sourceId, {
        video: true,
        audio: ['pcma', 'opus'],
        microphone: true,
      });

      // a dropped probe, or one for a source left behind, describes nothing on screen
      if (probe && this.probeInFlight === entry && !this.abortController.signal.aborted) {
        this.probeInfo.value = probe;
        this.probedSourceId = entry.sourceId;
        this.hasBackchannel.value = probe.audio.some((a) => a.direction === 'recvonly');
        this.hasAudio.value = probe.audio.filter((a) => a.direction === 'sendonly').length > 0;
        this.hasVideo.value = probe.video.filter((v) => v.direction === 'sendonly').length > 0;
      }

      return probe;
    } catch {
      return undefined;
    } finally {
      if (this.probeInFlight === entry) this.probeInFlight = undefined;
    }
  }

  private dialWithProbe(): Promise<ProbeStream | undefined> {
    const probing = this.settledProbe(this.probeForSource());
    this.probing = probing;
    this.connectWebSocket();
    return probing;
  }

  private probeForSource(): Promise<ProbeStream | undefined> {
    const source = this.source.value;
    const known = this.probeInfo.value;
    return known && source && this.probedSourceId === source._id ? Promise.resolve(known) : this.probeStream();
  }

  private settledProbe(probe: Promise<ProbeStream | undefined>): Promise<ProbeStream | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(undefined), PROBE_WAIT_MS);
      const settle = (result: ProbeStream | undefined): void => {
        clearTimeout(timer);
        resolve(result);
      };
      probe.then(settle, () => settle(undefined));
    });
  }

  private connectWebSocket(): void {
    this.disconnectWebSocket();

    const cam = this.camera.value;
    if (this.abortController.signal.aborted || !cam || !this.source.value || !this.target.value) {
      return;
    }

    const sourceNamePart = this.source.value.name ?? this.source.value.role ?? this.source.value._id;
    const sourceName = createSourceName(cam.name.value, sourceNamePart);

    this.connectToken = this.target.value.tokens.access;
    this.rejectedToken = undefined;
    this.lastError = undefined;
    this.mseRejected = false;
    this.mseAnswerPending = false;
    this.mseStopPending = false;
    this.offerPeer = undefined;
    this.answeredPeer = undefined;

    this.wsOpenedAt = performance.now();
    this.startWsConnectTimeout();

    this.wsHandle = this.wsTransport.open({
      path: '/api/go2rtc',
      query: { src: sourceName },
      binaryType: 'arraybuffer',
    });

    this.wsHandle.on('open', () => this.handleWsOpen());
    this.wsHandle.on('close', (info) => this.handleWsClose(info));
    this.wsHandle.on('message', (ev) => this.handleWsMessage(ev));
    this.wsHandle.on('error', () => {});
  }

  private disconnectWebSocket(): void {
    this.stopWsConnectTimeout();
    if (this.wsHandle) {
      this.wsHandle.dispose();
      this.wsHandle = undefined;
    }
  }

  private sendWsMessage(msg: object): void {
    if (this.wsHandle?.readyState === WebSocket.OPEN) {
      this.wsHandle.send(JSON.stringify(msg));
    }
  }

  private handleWsOpen(): void {
    if (this.abortController.signal.aborted) return;

    this.stopWsConnectTimeout();
    this.status.value = 'connecting';

    // WebRTC or MSE and the talk path follow the probe
    const handle = this.wsHandle;
    void (this.probing ?? Promise.resolve(undefined)).then(() => {
      if (this.abortController.signal.aborted || this.wsHandle !== handle) return;
      this.requestStream();
    });
  }

  private requestStream(): void {
    // go2rtc has no WebRTC or MSE consumer for JPEG
    if (this.sourceIsMjpeg()) {
      this.startMjpeg();
      return;
    }

    const mode = this.requestedMode.value;

    if (mode === 'auto') {
      this.startAutoMode();
    } else if (mode === 'webrtc' || mode === 'webrtc/tcp') {
      this.startWebRTC(mode);
    } else if (mode === 'mse') {
      this.startMSE();
    }
  }

  private handleWsClose(info: WsCloseInfo | undefined): void {
    if (this.status.value === 'closed' || this.abortController.signal.aborted) return;

    const kind = info ? classifyClose(info) : 'other';
    if (kind === 'other') {
      this.retryLater();
      return;
    }

    const rejected = this.connectToken;
    log.debug(`go2rtc socket closed (${info?.code}): ${info?.reason}`);
    if (kind === 'forbidden') {
      // retrying cannot help until the token or the endpoint changes, the watchers take it from there
      this.error.value = new Error(info?.reason || `Stream refused (${info?.code})`);
      this.status.value = 'error';
      this.isPlaying.value = false;
      this.cleanup();
      this.rejectedToken = rejected;
      return;
    }

    // the transport's auth-error makes the kernel refresh, the token watcher reconnects with the new one
    if (this.target.value?.tokens.access !== rejected) {
      this.reconnect(0);
      return;
    }
    this.reconnect(withJitter(RETRY_MAX_DELAY));
    this.rejectedToken = rejected;
  }

  private handleWsMessage(ev: MessageEvent): void {
    if (this.abortController.signal.aborted) return;

    if (typeof ev.data === 'string') {
      let msg: Go2RTCMessage;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        // Malformed signaling frame — dropping it beats crashing the whole
        // WS message dispatch.
        return;
      }
      this.handleMessage(msg);
    } else if (this.mjpegHandler && isJpegFrame(ev.data)) {
      this.mjpegHandler.appendFrame(ev.data);
    } else {
      (this.mseHandler ?? this.audioHandler)?.appendBuffer(ev.data);
    }
  }

  private handleMessage(msg: Go2RTCMessage): void {
    switch (msg.type) {
      case 'webrtc/answer':
        this.answeredPeer = this.takeOfferReply();
        if (this.answeredPeer) processWebRTCMessage(this.answeredPeer, msg);
        this.resumeBackchannel();
        break;

      case 'webrtc/candidate':
        // candidates follow their answer, those of a peer closed meanwhile go nowhere
        if (this.answeredPeer && this.isCurrentPeer(this.answeredPeer)) processWebRTCMessage(this.answeredPeer, msg);
        break;

      case 'mse':
        this.mseAnswerPending = false;
        if (this.mseStopPending) {
          this.mseStopPending = false;
          this.sendWsMessage({ type: 'mse/stop' });
        }
        if (typeof msg.value === 'string') {
          const handler = this.mseHandler ?? this.audioHandler;
          if (!handler) break;
          this.noteDeliveredAudio(MSE_AUDIO_CODEC.test(msg.value));
          handler.initializeBuffer(msg.value);
        }
        break;

      case 'mjpeg':
        if (this.mjpegHandler) this.status.value = 'connected';
        break;

      case 'error':
        this.handleGo2rtcError(String(msg.value));
        break;
    }
  }

  private handleGo2rtcError(message: string): void {
    const request = message.slice(0, Math.max(0, message.indexOf(':')));
    const err = new Error(message);
    log.debug(`go2rtc error: ${message}`);

    if (request === 'webrtc/offer') {
      const peer = this.takeOfferReply();
      if (peer && peer === this.webrtcHandler && !peer.isConnected) {
        this.lastError = err;
        this.stopConnectTimeout();
        if (this.requestedMode.value === 'auto') {
          this.fallBackToMSE();
        } else {
          this.retryLater(err);
        }
        return;
      }
      // the talk backchannel negotiates on the same socket, its failure leaves the picture alone
      if (peer && peer === this.backchannelHandler) this.closeBackchannel();
      this.resumeBackchannel();
      return;
    }

    if (request === 'mjpeg') {
      if (this.mjpegHandler) this.retryLater(err);
      return;
    }

    if (request === 'mse') {
      this.mseAnswerPending = false;
      this.mseStopPending = false;
      // the picture of an MJPEG stream goes on without its sound
      if (this.audioHandler) {
        this.closeAudio();
        return;
      }
      if (!this.mseHandler) return;
      this.lastError = err;
      this.mseRejected = true;
      if (this.requestedMode.value === 'auto' && this.webrtcHandler) {
        this.dropMSE();
        return;
      }
      this.retryLater(err);
      return;
    }

    // a rejected ICE candidate or an unknown request does not end the session
    if (!request.startsWith('webrtc')) this.lastError = err;
  }

  private async startWebRTC(mode: 'webrtc' | 'webrtc/tcp'): Promise<void> {
    if (this.abortController.signal.aborted) return;

    this.startConnectTimeout();

    const handler = createWebRTCHandler({
      mode,
      signal: this.abortController.signal,
      onConnected: (stream) => this.handleWebRTCConnected(stream),
      onDisconnected: () => this.handleWebRTCDisconnected(),
      onFailed: () => this.handleWebRTCFailed(),
      onCandidate: (candidate) => this.sendWsMessage({ type: 'webrtc/candidate', value: candidate }),
    });
    this.webrtcHandler = handler;

    const offer = await handler.createOffer();
    if (offer && !this.abortController.signal.aborted && this.webrtcHandler === handler) {
      this.sendOffer(handler, offer);
    }
  }

  private handleWebRTCConnected(stream: MediaStream): void {
    if (this.abortController.signal.aborted) return;

    const video = this.videoElement.value;
    if (!video) return;

    // go2rtc answers audio-only when it cannot deliver the video codec —
    // switching to that stream would freeze the picture with no way back
    if (this.hasVideo.value && stream.getVideoTracks().length === 0) {
      this.handleWebRTCFailed();
      return;
    }

    this.noteDeliveredAudio(stream.getAudioTracks().length > 0);

    // connectTimeout keeps running as a first-frame watchdog (a connected
    // H.265 track can still decode to nothing) — handleFirstFrame stops it
    this.activeMode.value = this.requestedMode.value === 'auto' ? 'webrtc' : (this.requestedMode.value as 'webrtc' | 'webrtc/tcp');

    this.lastMediaStream = stream;

    video.srcObject = stream;
    video.muted = this.muted.value;
    playVideo(video);

    this.status.value = 'connected';

    // MSE may already be on screen, the WebRTC track still has to prove it renders
    if (stream.getVideoTracks().length > 0) {
      this.awaitingWebRTCFrame = true;
      // go2rtc replays no GOP to WebRTC, its first frame waits for the camera's next keyframe
      if (this.webrtcTookOver()) this.startConnectTimeout();
      this.resetHealthBaseline(video);
      this.watchFirstFrame(video);
    } else {
      this.handleFirstFrame();
    }

    if (this.requestedMode.value === 'auto' && this.mseHandler) {
      this.dropMSE();
    }
  }

  private handleWebRTCDisconnected(): void {
    if (this.status.value !== 'closed' && !this.abortController.signal.aborted) {
      this.status.value = 'reconnecting';

      if (this.requestedMode.value === 'auto' && this.mseHandler?.isReady) {
        this.webrtcHandler?.close();
        this.webrtcHandler = undefined;
        this.activeMode.value = 'mse';
        this.status.value = 'connected';
        this.resumeBackchannel();
      } else {
        this.retryLater();
      }
    }
  }

  private handleWebRTCFailed(): void {
    if (this.abortController.signal.aborted) return;

    this.stopConnectTimeout();

    if (this.requestedMode.value === 'auto') {
      this.fallBackToMSE();
    } else {
      this.retryLater(this.lastError ?? new Error('WebRTC connection failed'));
    }
  }

  private fallBackToMSE(): void {
    this.webrtcHandler?.close();
    this.webrtcHandler = undefined;
    this.awaitingWebRTCFrame = false;
    if (this.mseRejected) {
      this.retryLater(this.lastError);
      return;
    }
    this.activeMode.value = 'mse';
    if (this.mseHandler?.isReady) {
      this.handleMSEReady();
    } else {
      this.startMSE();
    }
    this.resumeBackchannel();
  }

  private startMSE(): void {
    if (this.mseHandler) return;

    const video = this.videoElement.value;
    if (this.abortController.signal.aborted || !video) return;

    this.mseHandler = createMSEHandler({
      videoElement: video,
      signal: this.abortController.signal,
      onReady: () => this.handleMSEReady(),
      onFirstData: () => this.handleMSEFirstData(),
      onError: (err, phase) => this.handleMSEError(err, phase),
    });

    const codecs = this.mseHandler.setup();
    if (codecs) {
      // the held stop belongs to the dropped request and has to reach go2rtc before the new one
      if (this.mseStopPending) {
        this.mseStopPending = false;
        this.sendWsMessage({ type: 'mse/stop' });
      }
      this.sendWsMessage({ type: 'mse', value: codecs });
      this.mseAnswerPending = true;
      this.startMseConnectTimeout();
    }
  }

  private handleMSEReady(): void {
    if (this.abortController.signal.aborted) return;

    this.stopMseConnectTimeout();

    if (this.requestedMode.value === 'auto') {
      if (!this.webrtcHandler?.isConnected) {
        this.activeMode.value = 'mse';
        this.status.value = 'connected';
      }
    } else {
      this.activeMode.value = 'mse';
      this.status.value = 'connected';
    }

    // with WebRTC out of the race nothing else would notice bytes that never decode
    if (!this.webrtcHandler && !this.isPlaying.value) {
      this.startConnectTimeout();
    }
  }

  private handleMSEFirstData(): void {
    if (this.abortController.signal.aborted) return;

    const video = this.videoElement.value;
    if (video) {
      this.watchFirstFrame(video);
      playVideo(video);
    }
  }

  private handleMSEError(err: Error, phase: MSEErrorPhase): void {
    if (this.abortController.signal.aborted) return;
    log.debug(`MSE ${phase} error:`, err);

    // auto mode with WebRTC still in play: only the fMP4 path goes, WebRTC and its deadline decide the rest
    if (this.requestedMode.value === 'auto' && this.webrtcHandler) {
      const tookOver = this.isPlaying.value || this.status.value === 'connected';
      this.dropMSE();
      if (tookOver) {
        this.isPlaying.value = false;
        this.status.value = 'reconnecting';
      }
      return;
    }

    const video = this.videoElement.value;
    const beforeFirstFrame = !video || video.readyState < HAVE_CURRENT_DATA;
    if ((phase === 'setup' || beforeFirstFrame) && this.sourceLikelyH265()) {
      reportH265DecodeFailure('mse');
      this.markSourceUndecodable();
      this.restart();
      return;
    }

    if (phase === 'setup') {
      this.error.value = err;
      this.status.value = 'error';
      this.cleanup();
      return;
    }

    this.retryLater();
  }

  private dropMSE(): void {
    this.mseHandler?.close();
    this.mseHandler = undefined;
    this.stopMseConnectTimeout();
    // a stop that overtakes a slow attach finds no consumer yet, go2rtc would stream on
    if (this.mseAnswerPending) {
      this.mseStopPending = true;
    } else {
      this.sendWsMessage({ type: 'mse/stop' });
    }
  }

  private startAutoMode(): void {
    if (this.abortController.signal.aborted) return;

    // without a probe both paths start and the runtime decides
    const probe = this.probeInfo.value;
    if (probe) {
      const compatibility = checkWebRTCCompatibility(probe);

      if (!compatibility.compatible) {
        this.activeMode.value = 'mse';
        this.startMSE();
        return;
      }
    }

    // WebRTC first, so an MSE setup that fails synchronously only drops MSE
    this.startWebRTC('webrtc');
    this.startMSE();
  }

  private sourceIsMjpeg(): boolean {
    const video = this.probeInfo.value?.video.filter((v) => v.direction === 'sendonly') ?? [];
    if (video.length) return video.every((v) => v.codec === 'JPEG');
    return this.source.value?.videoCodec === 'JPEG';
  }

  private startMjpeg(): void {
    const video = this.videoElement.value;
    if (this.abortController.signal.aborted || !video) return;

    const handler = createMJPEGHandler({ signal: this.abortController.signal });
    this.mjpegHandler = handler;
    this.activeMode.value = 'mjpeg';
    this.lastMediaStream = handler.stream;

    video.srcObject = handler.stream;
    playVideo(video);
    this.sendWsMessage({ type: 'mjpeg' });
    this.startConnectTimeout();
    this.watchFirstFrame(video);

    if (this.hasAudio.value) this.startAudio();
  }

  private startAudio(): void {
    if (this.audioHandler || this.abortController.signal.aborted) return;

    const audio = document.createElement('audio');
    audio.muted = this.muted.value;
    const handler = createMSEHandler({
      videoElement: audio,
      signal: this.abortController.signal,
      onReady: () => {},
      onFirstData: () => playVideo(audio),
      onError: (err) => {
        log.debug('MJPEG audio error:', err);
        this.dropAudio();
      },
    });

    const codecs = handler
      .setup()
      ?.split(',')
      .filter((codec) => MSE_AUDIO_CODEC.test(codec))
      .join(',');
    if (!codecs) {
      handler.close();
      return;
    }

    this.audioElement = audio;
    this.audioHandler = handler;
    this.sendWsMessage({ type: 'mse', value: codecs });
    this.mseAnswerPending = true;
  }

  private dropAudio(): void {
    if (!this.audioHandler) return;
    this.closeAudio();
    if (this.mseAnswerPending) {
      this.mseStopPending = true;
    } else {
      this.sendWsMessage({ type: 'mse/stop' });
    }
  }

  private closeAudio(): void {
    this.audioHandler?.close();
    this.audioHandler = undefined;

    const audio = this.audioElement;
    if (!audio) return;
    this.audioElement = undefined;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  }

  private handleFirstFrame(): void {
    if (this.abortController.signal.aborted) return;

    // a frame of the MSE fallback must not end the deadline of a WebRTC attempt still negotiating
    if (!this.webrtcHandler || this.webrtcHandler.isConnected) {
      this.stopConnectTimeout();
      this.awaitingWebRTCFrame = false;
      this.resumeBackchannel();
    }
    this.error.value = undefined;
    if (!this.isPlaying.value) {
      this.isPlaying.value = true;
      this.playingSince = performance.now();
    }
  }

  private watchFirstFrame(video: HTMLVideoElement): void {
    this.cancelFirstFrameWatch?.();
    if (video.readyState >= HAVE_CURRENT_DATA) {
      this.handleFirstFrame();
      return;
    }

    const target = video as VideoWithFrameCallback;
    const onFrame = () => {
      this.cancelFirstFrameWatch?.();
      this.handleFirstFrame();
    };
    const callbackId = target.requestVideoFrameCallback?.(onFrame);
    video.addEventListener('loadeddata', onFrame);
    this.cancelFirstFrameWatch = () => {
      this.cancelFirstFrameWatch = undefined;
      video.removeEventListener('loadeddata', onFrame);
      if (callbackId !== undefined) target.cancelVideoFrameCallback?.(callbackId);
    };
  }

  private startHealthCheck(): void {
    const video = this.videoElement.value;
    if (video) this.resetHealthBaseline(video);
    this.healthInterval = setInterval(() => this.checkHealth(), HEALTH_CHECK_INTERVAL);
  }

  private stopHealthCheck(): void {
    if (this.healthInterval !== undefined) {
      clearInterval(this.healthInterval);
      this.healthInterval = undefined;
    }
    this.stalled.value = false;
  }

  private resetHealthBaseline(video: HTMLVideoElement): void {
    this.lastProgressAt = performance.now();
    this.lastMediaTime = video.currentTime;
    this.lastFrameCount = this.frameCount(video);
    this.frameCounterLive = false;
    this.stalled.value = false;
  }

  private checkHealth(): void {
    const video = this.videoElement.value;
    if (!video) return;

    const mse = this.activeMode.value === 'mse';
    const frames = this.frameCount(video);
    if (frames !== undefined && frames > 0) this.frameCounterLive = true;
    const progressed = frames !== this.lastFrameCount || (mse && video.currentTime !== this.lastMediaTime);
    if (mse) chaseLiveEdge(video);
    if (this.audioElement) chaseLiveEdge(this.audioElement);
    this.lastMediaTime = video.currentTime;
    this.lastFrameCount = frames;

    const now = performance.now();
    if (progressed || !this.expectsFrames(video)) {
      this.lastProgressAt = now;
      this.stalled.value = false;
      return;
    }

    const silentFor = now - this.lastProgressAt;
    if (silentFor >= STALL_RECONNECT_AFTER) {
      log.debug(`no frame for ${Math.round(silentFor)}ms, reconnecting`);
      this.retryLater();
    } else if (silentFor >= STALL_AFTER) {
      this.stalled.value = true;
    }
  }

  private frameCount(video: HTMLVideoElement): number | undefined {
    return this.mjpegHandler ? this.mjpegHandler.frames : decodedFrames(video);
  }

  private expectsFrames(video: HTMLVideoElement): boolean {
    if (this.paused.value || video.paused || isVideoInPictureInPicture(video) || isPageHidden()) return false;
    // a browser without frame counts for this source leaves nothing to judge WebRTC by
    return this.activeMode.value === 'mse' || this.frameCounterLive;
  }

  private cleanup(): void {
    this.abortController.abort();

    this.stopConnectTimeout();
    this.stopWsConnectTimeout();
    this.stopMseConnectTimeout();

    this.stopHealthCheck();
    this.cancelFirstFrameWatch?.();
    this.awaitingWebRTCFrame = false;

    this.lastMediaStream = null;

    this.webrtcHandler?.close();
    this.webrtcHandler = undefined;

    this.mseHandler?.close();
    this.mseHandler = undefined;

    this.mjpegHandler?.close();
    this.mjpegHandler = undefined;
    this.closeAudio();

    this.closeBackchannel();

    // Only the handle is ours; the wsTransport itself is owned by the app layer.
    this.disconnectWebSocket();

    const video = this.videoElement.value;
    if (video) {
      video.style.display = '';
      video.pause();
      video.srcObject = null;
      video.removeAttribute('src');
      video.load();
    }
  }

  private async startBackchannel(): Promise<void> {
    if (this.abortController.signal.aborted || !this.wsHandle || this.wsHandle.readyState !== WebSocket.OPEN) {
      return;
    }
    if (this.offerPeer) return;
    // go2rtc closes a peer it does not count as connected when the socket offers again, and counts it one DTLS flight after the browser: a frame proves it
    if (this.webrtcHandler && (!this.webrtcHandler.isConnected || this.awaitingWebRTCFrame)) return;

    const handler = createBackchannelHandler({
      filterUdp: this.requestedMode.value === 'webrtc/tcp',
      signal: this.abortController.signal,
      onCandidate: (candidate) => this.sendWsMessage({ type: 'webrtc/candidate', value: candidate }),
      onConnected: async () => {
        if (this.pendingMicTrack && this.backchannelHandler === handler) {
          await handler.setMicrophoneTrack(this.pendingMicTrack);
        }
      },
      onFailed: () => this.closeBackchannel(handler),
    });
    this.backchannelHandler = handler;

    let offer: string | undefined;
    try {
      offer = await handler.createOffer();
    } catch {
      this.closeBackchannel(handler);
      return;
    }
    if (offer && !this.abortController.signal.aborted && this.backchannelHandler === handler) {
      this.sendOffer(handler, offer);
    }
  }

  private resumeBackchannel(): void {
    if (this.pendingMicTrack && !this.backchannelHandler) this.startBackchannel();
  }

  private sendOffer(peer: SignalingPeer, sdp: string): void {
    if (this.wsHandle?.readyState !== WebSocket.OPEN) return;
    this.offerPeer = peer;
    this.wsHandle.send(JSON.stringify({ type: 'webrtc/offer', value: sdp }));
  }

  private takeOfferReply(): SignalingPeer | undefined {
    const peer = this.offerPeer;
    this.offerPeer = undefined;
    return peer && this.isCurrentPeer(peer) ? peer : undefined;
  }

  private isCurrentPeer(peer: SignalingPeer): boolean {
    return peer === this.webrtcHandler || peer === this.backchannelHandler;
  }

  private closeBackchannel(handler = this.backchannelHandler): void {
    handler?.close();
    if (handler !== this.backchannelHandler) return;
    this.backchannelHandler = undefined;
    this.pendingMicTrack = null;
  }
}

export function createStreamConnection(options: StreamConnectionOptions): StreamConnection {
  return new StreamConnection(options);
}
