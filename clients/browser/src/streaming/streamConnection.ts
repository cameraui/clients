/* eslint-disable @stylistic/max-len */
import { useTimeoutFn, whenever } from '@vueuse/core';
import { computed, ref, shallowRef, toValue, watch } from 'vue';

import { useCameraUi } from '../composables/useCameraUi.js';
import { useTabVisibility } from '../composables/useTabVisibility.js';
import { createSourceName } from '../server/index.js';
import { STREAM_CONFIG } from './config.js';
import { createMSEHandler, playVideo } from './mse.js';
import { abortableSleep, checkWebRTCCompatibility } from './utils.js';
import { createBackchannelHandler, createWebRTCHandler, processWebRTCMessage } from './webrtc.js';

import type { CameraSource, ProbeStream, StreamingRole } from '@camera.ui/sdk';
import type { ConnectionTarget } from '@camera.ui/transport';
import type { WsHandle, WsTransport } from '@camera.ui/transport/transports/ws';
import type { ComputedRef, MaybeRefOrGetter, Ref, ShallowRef } from 'vue';
import type { ReactiveCameraDevice } from '../types.js';
import type { MSEHandler } from './mse.js';
import type { Go2RTCMessage, ReactiveStream, StreamStatus, VideoStreamingMode } from './types.js';
import type { BackchannelHandler, WebRTCHandler } from './webrtc.js';

export interface StreamConnectionOptions {
  camera: MaybeRefOrGetter<ReactiveCameraDevice | undefined>;
  videoElement: MaybeRefOrGetter<HTMLVideoElement | undefined | null>;
  containerElement?: MaybeRefOrGetter<HTMLElement | undefined | null>;
  mode?: MaybeRefOrGetter<VideoStreamingMode>;
  resolution?: MaybeRefOrGetter<StreamingRole>;
  autoStart?: boolean;
}

const USE_DEBUG = true;

function log(...args: unknown[]): void {
  if (!USE_DEBUG) return;
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  console.log(`[StreamConnection ${hh}:${mm}:${ss}.${ms}]`, ...args);
}

export class StreamConnection implements ReactiveStream {
  public readonly status: Ref<StreamStatus>;
  public readonly activeMode: Ref<Exclude<VideoStreamingMode, 'auto'>>;
  public readonly requestedMode: Ref<VideoStreamingMode>;
  public readonly activeResolution: Ref<StreamingRole>;
  public readonly requestedResolution: Ref<StreamingRole>;
  public readonly source: ShallowRef<CameraSource | undefined>;
  public readonly hasVideo: Ref<boolean>;
  public readonly hasAudio: Ref<boolean>;
  public readonly hasBackchannel: Ref<boolean>;
  public readonly isPlaying: Ref<boolean>;
  public readonly error: Ref<Error | undefined>;
  public readonly probeInfo: ShallowRef<ProbeStream | undefined>;
  public readonly muted: Ref<boolean>;
  public readonly paused: Ref<boolean>;
  public readonly nativeWidth: Ref<number>;
  public readonly nativeHeight: Ref<number>;

  private readonly options: StreamConnectionOptions;

  private connectionGeneration = 0;
  private abortController = new AbortController();
  private offTabVisible: (() => void) | undefined;
  private offTabPaused: (() => void) | undefined;
  private wasPausedByVisibility = false;
  private readonly wsTransport: WsTransport;
  private wsHandle: WsHandle | undefined;
  private webrtcHandler: WebRTCHandler | undefined;
  private mseHandler: MSEHandler | undefined;
  private firstFrameCallbackId: number | undefined;
  private backchannelHandler: BackchannelHandler | undefined;
  private pendingMicTrack: MediaStreamTrack | null = null;
  private lastMediaStream: MediaStream | null = null;
  private stopWatchers: (() => void)[] = [];
  private mseMonitorInterval: ReturnType<typeof setInterval> | undefined;
  private onVideoPauseBound: (() => void) | undefined;
  private onVideoPlayBound: (() => void) | undefined;
  private onVideoResizeBound: (() => void) | undefined;

  private readonly camera: ComputedRef<ReactiveCameraDevice | undefined>;
  private readonly videoElement: ComputedRef<HTMLVideoElement | undefined | null>;
  private readonly containerElement: ComputedRef<HTMLElement | undefined | null>;
  private readonly target: Readonly<Ref<ConnectionTarget | null>>;
  private readonly isReady: ComputedRef<boolean>;
  private readonly effectiveMode: ComputedRef<Exclude<VideoStreamingMode, 'auto'>>;

  private readonly startWsConnectTimeout: () => void;
  private readonly stopWsConnectTimeout: () => void;
  private readonly startConnectTimeout: () => void;
  private readonly stopConnectTimeout: () => void;
  private readonly startReconnectTimeout: () => void;
  private readonly stopReconnectTimeout: () => void;

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
    this.activeMode = ref<Exclude<VideoStreamingMode, 'auto'>>('webrtc');
    this.activeResolution = ref<StreamingRole>('low-resolution');
    this.source = shallowRef<CameraSource | undefined>();
    this.hasVideo = ref(false);
    this.hasAudio = ref(false);
    this.hasBackchannel = ref(false);
    this.isPlaying = ref(false);
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
    this.effectiveMode = computed(() => {
      if (this.requestedMode.value === 'auto') {
        return this.activeMode.value;
      }
      return this.requestedMode.value;
    });

    const { onTabPaused, onTabVisible } = useTabVisibility();

    const { start: startWsConnectTimeout, stop: stopWsConnectTimeout } = useTimeoutFn(
      () => {
        if (this.wsHandle?.readyState === WebSocket.CONNECTING) {
          this.disconnectWebSocket();
          if (!this.abortController.signal.aborted && this.status.value !== 'closed') {
            this.restart();
          }
        }
      },
      STREAM_CONFIG.WEBRTC.WS_CONNECT_TIMEOUT,
      { immediate: false },
    );
    this.startWsConnectTimeout = startWsConnectTimeout;
    this.stopWsConnectTimeout = stopWsConnectTimeout;

    const { start: startConnectTimeout, stop: stopConnectTimeout } = useTimeoutFn(
      () => {
        if (this.webrtcHandler && !this.webrtcHandler.isConnected) {
          if (this.requestedMode.value === 'auto') {
            if (this.mseHandler?.isReady) {
              this.activeMode.value = 'mse';
              this.status.value = 'connected';
            } else {
              this.activeMode.value = 'mse';
              this.startMSE();
            }
          } else {
            this.restart();
          }
        }
      },
      STREAM_CONFIG.WEBRTC.CONNECT_TIMEOUT,
      { immediate: false },
    );
    this.startConnectTimeout = startConnectTimeout;
    this.stopConnectTimeout = stopConnectTimeout;

    const { start: startReconnectTimeout, stop: stopReconnectTimeout } = useTimeoutFn(
      () => {
        if (!this.abortController.signal.aborted) {
          this.restart();
        }
      },
      STREAM_CONFIG.WEBRTC.RECONNECT_DELAY,
      { immediate: false },
    );
    this.startReconnectTimeout = startReconnectTimeout;
    this.stopReconnectTimeout = stopReconnectTimeout;

    this.setupWatchers();

    this.offTabPaused = onTabPaused(() => {
      log(`onTabPaused fired — status=${this.status.value}, isReady=${this.isReady.value}, target=${!!this.target.value}`);
      if (this.status.value === 'idle' || this.status.value === 'closed') {
        log(`onTabPaused — already in ${this.status.value}, skipping stop()`);
        return;
      }
      this.wasPausedByVisibility = true;
      this.stop();
      log('onTabPaused — stop() done, wasPausedByVisibility=true');
    });

    this.offTabVisible = onTabVisible(() => {
      log(
        `onTabVisible fired — wasPausedByVisibility=${this.wasPausedByVisibility}, status=${this.status.value}, isReady=${this.isReady.value}, target=${!!this.target.value}`,
      );
      if (!this.wasPausedByVisibility) {
        log('onTabVisible — not paused by visibility, no-op');
        return;
      }
      this.wasPausedByVisibility = false;
      this.startWhenReady();
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
  }

  public async start(): Promise<void> {
    log(`start() called — status=${this.status.value}, isReady=${this.isReady.value}`);
    if (this.status.value !== 'idle' && this.status.value !== 'closed') {
      log(`start() — skipped, status is ${this.status.value}`);
      return;
    }
    if (!this.isReady.value) {
      log('start() — skipped, isReady=false');
      return;
    }

    this.cleanup();
    this.abortController = new AbortController();
    const gen = ++this.connectionGeneration;

    this.status.value = 'connecting';
    this.error.value = undefined;
    this.isPlaying.value = false;

    try {
      if (!this.initializeSource()) {
        log('start() — no streaming source available');
        this.error.value = new Error('No streaming source available');
        this.status.value = 'error';
        return;
      }

      await this.probeStream();

      // Stale check: restart()/stop() have started a new generation
      if (gen !== this.connectionGeneration) {
        log('start() — generation stale after probe, aborting');
        return;
      }

      // Re-resolve source in case resolution changed during the async probe
      // (setResolution updates the refs but no longer restarts during 'connecting')
      this.initializeSource();

      log('start() — connecting WebSocket');
      this.connectWebSocket();
    } catch (err) {
      if (gen !== this.connectionGeneration) return;
      log('start() — error:', err);
      this.error.value = err instanceof Error ? err : new Error(String(err));
      this.status.value = 'error';
    }
  }

  public stop(): void {
    if (this.status.value === 'closed') {
      log('stop() — already closed, no-op');
      return;
    }
    log(`stop() — was ${this.status.value}, transitioning to closed`);
    ++this.connectionGeneration;
    this.status.value = 'closed';
    this.cleanup();
  }

  public async setMode(mode: VideoStreamingMode): Promise<void> {
    if (this.requestedMode.value === mode) return;

    this.requestedMode.value = mode;
    this.activeMode.value = mode === 'auto' ? 'webrtc' : mode;

    // Only restart if already connected — during 'connecting', start() will
    // pick up the updated refs naturally when it reaches handleWsOpen().
    if (this.status.value === 'connected') {
      await this.restart();
    }
  }

  public async setResolution(resolution: StreamingRole): Promise<void> {
    if (this.requestedResolution.value === resolution) return;

    this.requestedResolution.value = resolution;

    const result = this.getSourceForResolution(resolution);

    if (result && result.source._id !== this.source.value?._id) {
      this.source.value = result.source;
      this.activeResolution.value = result.effectiveResolution;

      // Only restart if already connected — during 'connecting', start()
      // re-reads the source before connectWebSocket().
      if (this.status.value === 'connected') {
        await this.restart();
      }
    }
  }

  public async setMicrophone(track: MediaStreamTrack | null): Promise<void> {
    if (this.webrtcHandler) {
      await this.webrtcHandler.setMicrophoneTrack(track);
      return;
    }

    if (this.activeMode.value === 'mse' && this.hasBackchannel.value) {
      this.pendingMicTrack = track;

      if (track && !this.backchannelHandler) {
        await this.startBackchannel();
      } else if (!track && this.backchannelHandler) {
        this.closeBackchannel();
      } else if (this.backchannelHandler?.isConnected) {
        await this.backchannelHandler.setMicrophoneTrack(track);
      }
    }
  }

  public setMuted(muted: boolean): void {
    this.muted.value = muted;
    const video = this.videoElement.value;
    if (video) video.muted = muted;
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
  }

  public pause(): void {
    this.paused.value = true;
    const video = this.videoElement.value;
    if (video) video.pause();
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

    this.stop();
  }

  public async restart(): Promise<void> {
    this.status.value = 'reconnecting';
    this.isPlaying.value = false;
    this.cleanup();

    this.abortController = new AbortController();
    const gen = ++this.connectionGeneration;

    try {
      await abortableSleep(1000, this.abortController.signal);
    } catch {
      return;
    }

    // Stale check
    if (gen !== this.connectionGeneration) return;

    if (!this.isReady.value) {
      this.status.value = 'idle';
      return;
    }

    try {
      if (!this.initializeSource()) {
        this.error.value = new Error('No streaming source available');
        this.status.value = 'error';
        return;
      }
      this.connectWebSocket();
    } catch (err) {
      if (gen !== this.connectionGeneration) return;
      this.error.value = err instanceof Error ? err : new Error(String(err));
      this.status.value = 'error';
    }
  }

  private startWhenReady(): void {
    if (this.isReady.value) {
      log('startWhenReady — already ready, calling start() now');
      this.start();
      return;
    }
    log(`startWhenReady — not ready (camera=${!!this.camera.value}, video=${!!this.videoElement.value}, target=${!!this.target.value}), watching isReady`);
    const stop = watch(this.isReady, (ready) => {
      if (!ready) return;
      log('startWhenReady — isReady → true, calling start()');
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

    const stopMseWatch = watch(
      this.activeMode,
      (mode) => {
        this.stopMseMonitor();
        if (mode === 'mse') {
          this.mseMonitorInterval = setInterval(() => this.monitorMseBuffer(), 1000);
        }
      },
      { immediate: true },
    );
    this.stopWatchers.push(stopMseWatch);

    const stopCameraWatch = watch([this.camera, this.videoElement, () => this.target.value], ([newCamera, newVideo, newClient], [oldCamera, oldVideo]) => {
      if (newCamera !== oldCamera) {
        // Only restart when already connected — during 'connecting', start()
        // picks up the current camera automatically (refs are already up-to-date)
        if (this.status.value === 'connected') {
          if (newCamera && newVideo && newClient) {
            this.restart();
          }
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

  // prettier-ignore
  private getSourceForResolution(resolution: StreamingRole):
    | {
      source: CameraSource;
      effectiveResolution: StreamingRole;
    }
    | undefined {
    const cam = this.camera.value;
    if (!cam) return undefined;

    const resolutionOrder: StreamingRole[] = ['high-resolution', 'mid-resolution', 'low-resolution'];

    const exactSource = cam.sources.value.find((s) => s.role === resolution);
    if (exactSource) {
      return { source: exactSource, effectiveResolution: resolution };
    }

    const startIndex = resolutionOrder.indexOf(resolution);
    for (let i = startIndex; i < resolutionOrder.length; i++) {
      const src = cam.sources.value.find((s) => s.role === resolutionOrder[i]);
      if (src) {
        return { source: src, effectiveResolution: resolutionOrder[i] };
      }
    }

    const fallback = cam.streamSource.value;
    if (fallback) {
      return { source: fallback, effectiveResolution: (fallback.role as StreamingRole) ?? 'low-resolution' };
    }

    return undefined;
  }

  private initializeSource(): boolean {
    const result = this.getSourceForResolution(this.requestedResolution.value);
    if (!result) return false;

    this.source.value = result.source;
    this.activeResolution.value = result.effectiveResolution;
    return true;
  }

  private async probeStream(): Promise<ProbeStream | undefined> {
    const cam = this.camera.value;
    if (!cam || !this.source.value || this.abortController.signal.aborted) return undefined;

    try {
      const probe = await cam.probeStream(this.source.value._id, {
        video: true,
        audio: ['pcma', 'opus'],
        microphone: true,
      });

      if (probe && !this.abortController.signal.aborted) {
        this.probeInfo.value = probe;
        this.hasBackchannel.value = probe.audio.some((a) => a.direction === 'recvonly');
        this.hasAudio.value = probe.audio.filter((a) => a.direction === 'sendonly').length > 0;
        this.hasVideo.value = probe.video.filter((v) => v.direction === 'sendonly').length > 0;
      }

      return probe;
    } catch {
      return undefined;
    }
  }

  private connectWebSocket(): void {
    this.disconnectWebSocket();

    const cam = this.camera.value;
    if (this.abortController.signal.aborted || !cam || !this.source.value || !this.target.value) {
      return;
    }

    const sourceNamePart = this.source.value.name ?? this.source.value.role ?? this.source.value._id;
    const sourceName = createSourceName(cam.name.value, sourceNamePart);

    this.startWsConnectTimeout();

    this.wsHandle = this.wsTransport.open({
      path: '/api/go2rtc',
      query: { src: sourceName },
      binaryType: 'arraybuffer',
    });

    this.wsHandle.on('open', () => this.handleWsOpen());
    this.wsHandle.on('close', () => this.handleWsClose());
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

    const mode = this.effectiveMode.value;

    if (mode === 'webrtc' || mode === 'webrtc/tcp') {
      this.startWebRTC(mode);
    } else if (mode === 'mse') {
      this.startMSE();
    } else if (this.requestedMode.value === 'auto') {
      this.startAutoMode();
    }
  }

  private handleWsClose(): void {
    if (this.status.value !== 'closed' && !this.abortController.signal.aborted) {
      this.startReconnectTimeout();
    }
  }

  private handleWsMessage(ev: MessageEvent): void {
    if (this.abortController.signal.aborted) return;

    if (typeof ev.data === 'string') {
      const msg: Go2RTCMessage = JSON.parse(ev.data);
      this.handleMessage(msg);
    } else if (this.mseHandler) {
      this.mseHandler.appendBuffer(ev.data);
      this.handleFirstFrame();
    }
  }

  private handleMessage(msg: Go2RTCMessage): void {
    switch (msg.type) {
      case 'webrtc/answer':
      case 'webrtc/candidate':
        if (this.webrtcHandler) {
          processWebRTCMessage(this.webrtcHandler, msg);
        } else if (this.backchannelHandler) {
          processWebRTCMessage(this.backchannelHandler, msg);
        }
        break;

      case 'mse':
        if (this.mseHandler && typeof msg.value === 'string') {
          this.mseHandler.initializeBuffer(msg.value);
        }
        break;

      case 'error':
        if (this.requestedMode.value !== 'auto') {
          this.error.value = new Error(msg.value);
          this.status.value = 'error';
        }
        break;
    }
  }

  private async startWebRTC(mode: 'webrtc' | 'webrtc/tcp'): Promise<void> {
    if (this.abortController.signal.aborted) return;

    this.startConnectTimeout();

    this.webrtcHandler = createWebRTCHandler({
      mode,
      signal: this.abortController.signal,
      onConnected: (stream) => this.handleWebRTCConnected(stream),
      onDisconnected: () => this.handleWebRTCDisconnected(),
      onFailed: () => this.handleWebRTCFailed(),
      onCandidate: (candidate) => this.sendWsMessage({ type: 'webrtc/candidate', value: candidate }),
    });

    const offer = await this.webrtcHandler.createOffer();
    if (offer && !this.abortController.signal.aborted) {
      this.sendWsMessage({ type: 'webrtc/offer', value: offer });
    }
  }

  private handleWebRTCConnected(stream: MediaStream): void {
    if (this.abortController.signal.aborted) return;

    const video = this.videoElement.value;
    if (!video) return;

    this.stopConnectTimeout();
    this.activeMode.value = this.requestedMode.value === 'auto' ? 'webrtc' : (this.requestedMode.value as 'webrtc' | 'webrtc/tcp');

    this.lastMediaStream = stream;

    video.srcObject = stream;
    video.muted = this.muted.value;
    playVideo(video);

    this.status.value = 'connected';

    this.handleFirstFrameWebRTC(stream);

    if (this.requestedMode.value === 'auto' && this.mseHandler) {
      this.mseHandler.close();
      this.mseHandler = undefined;
    }
  }

  private handleWebRTCDisconnected(): void {
    if (this.status.value !== 'closed' && !this.abortController.signal.aborted) {
      this.status.value = 'reconnecting';

      if (this.requestedMode.value === 'auto' && this.mseHandler?.isReady) {
        this.activeMode.value = 'mse';
        this.status.value = 'connected';
      } else {
        this.restart();
      }
    }
  }

  private handleWebRTCFailed(): void {
    if (this.abortController.signal.aborted) return;

    this.stopConnectTimeout();

    if (this.requestedMode.value === 'auto') {
      this.activeMode.value = 'mse';
      if (!this.mseHandler?.isReady) {
        this.startMSE();
      } else {
        this.status.value = 'connected';
      }
    } else {
      this.error.value = new Error('WebRTC connection failed');
      this.status.value = 'error';
    }
  }

  private startMSE(): void {
    const video = this.videoElement.value;
    if (this.abortController.signal.aborted || !video) return;

    this.mseHandler = createMSEHandler({
      videoElement: video,
      signal: this.abortController.signal,
      onReady: () => this.handleMSEReady(),
      onFirstData: () => this.handleMSEFirstData(),
      onError: (err) => {
        if (this.requestedMode.value !== 'auto') {
          this.error.value = err;
          this.status.value = 'error';
        }
      },
    });

    const codecs = this.mseHandler.setup();
    if (codecs) {
      this.sendWsMessage({ type: 'mse', value: codecs });
    }
  }

  private handleMSEReady(): void {
    if (this.abortController.signal.aborted) return;

    if (this.requestedMode.value === 'auto') {
      if (!this.webrtcHandler?.isConnected) {
        this.activeMode.value = 'mse';
        this.status.value = 'connected';
      }
    } else {
      this.activeMode.value = 'mse';
      this.status.value = 'connected';
    }
  }

  private handleMSEFirstData(): void {
    if (this.abortController.signal.aborted) return;

    const video = this.videoElement.value;
    if (video) {
      playVideo(video);
    }
  }

  private async startAutoMode(): Promise<void> {
    if (this.abortController.signal.aborted) return;

    const probe = this.probeInfo.value ?? (await this.probeStream());
    if (probe) {
      const compatibility = checkWebRTCCompatibility(probe);

      if (!compatibility.compatible) {
        this.activeMode.value = 'mse';
        this.startMSE();
        return;
      }
    }

    this.startMSE();
    this.startWebRTC('webrtc');
  }

  private handleFirstFrame(): void {
    if (!this.isPlaying.value && !this.abortController.signal.aborted) {
      this.isPlaying.value = true;
    }
  }

  private monitorMseBuffer(): void {
    const video = this.videoElement.value;
    if (!video || this.activeMode.value !== 'mse' || !this.isPlaying.value) return;
    if (video.buffered.length > 0) {
      const end = video.buffered.end(video.buffered.length - 1);
      if (end - video.currentTime > 1) {
        video.currentTime = end;
      }
    }
  }

  private stopMseMonitor(): void {
    if (this.mseMonitorInterval !== undefined) {
      clearInterval(this.mseMonitorInterval);
      this.mseMonitorInterval = undefined;
    }
  }

  private handleFirstFrameWebRTC(stream: MediaStream): void {
    const video = this.videoElement.value;
    if (this.isPlaying.value || this.abortController.signal.aborted || !video) return;

    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) {
      this.handleFirstFrame();
      return;
    }

    type VideoWithCallback = HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
    const videoWithCallback = video as VideoWithCallback;

    if (typeof videoWithCallback.requestVideoFrameCallback === 'function') {
      this.firstFrameCallbackId = videoWithCallback.requestVideoFrameCallback(() => {
        if (!this.abortController.signal.aborted) {
          this.handleFirstFrame();
        }
      });
    } else {
      const checkFrame = () => {
        if (this.abortController.signal.aborted) return;

        if (video.readyState >= 2 && video.videoWidth > 0) {
          this.handleFirstFrame();
        } else {
          this.firstFrameCallbackId = requestAnimationFrame(checkFrame);
        }
      };
      this.firstFrameCallbackId = requestAnimationFrame(checkFrame);
    }
  }

  private cleanup(): void {
    this.abortController.abort();

    this.stopConnectTimeout();
    this.stopWsConnectTimeout();
    this.stopReconnectTimeout();

    this.stopMseMonitor();

    const videoEl = this.videoElement.value;
    if (videoEl) {
      if (this.onVideoPauseBound) videoEl.removeEventListener('pause', this.onVideoPauseBound);
      if (this.onVideoPlayBound) videoEl.removeEventListener('play', this.onVideoPlayBound);
      if (this.onVideoResizeBound) videoEl.removeEventListener('resize', this.onVideoResizeBound);
    }

    this.lastMediaStream = null;

    this.webrtcHandler?.close();
    this.webrtcHandler = undefined;

    this.mseHandler?.close();
    this.mseHandler = undefined;

    this.closeBackchannel();

    // Only the handle is ours; the wsTransport itself is owned by the app layer.
    this.disconnectWebSocket();

    const video = this.videoElement.value;

    if (this.firstFrameCallbackId !== undefined) {
      if (video && 'cancelVideoFrameCallback' in video) {
        (video as HTMLVideoElement & { cancelVideoFrameCallback: (id: number) => void }).cancelVideoFrameCallback(this.firstFrameCallbackId);
      } else {
        cancelAnimationFrame(this.firstFrameCallbackId);
      }
      this.firstFrameCallbackId = undefined;
    }

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

    this.backchannelHandler = createBackchannelHandler({
      signal: this.abortController.signal,
      onCandidate: (candidate) => this.sendWsMessage({ type: 'webrtc/candidate', value: candidate }),
      onConnected: async () => {
        if (this.pendingMicTrack && this.backchannelHandler) {
          await this.backchannelHandler.setMicrophoneTrack(this.pendingMicTrack);
        }
      },
      onDisconnected: () => {
        this.backchannelHandler = undefined;
      },
    });

    const offer = await this.backchannelHandler.createOffer();
    if (offer && !this.abortController.signal.aborted) {
      this.sendWsMessage({ type: 'webrtc/offer', value: offer });
    }
  }

  private closeBackchannel(): void {
    this.backchannelHandler?.close();
    this.backchannelHandler = undefined;
    this.pendingMicTrack = null;
  }
}

export function createStreamConnection(options: StreamConnectionOptions): StreamConnection {
  return new StreamConnection(options);
}
