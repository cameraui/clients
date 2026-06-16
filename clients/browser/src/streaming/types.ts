import type { CameraSource, ProbeStream, StreamingRole } from '@camera.ui/sdk';
import type { MaybeRefOrGetter, Ref } from 'vue';
import type { ReactiveCameraDevice } from '../types.js';

export type VideoStreamingMode = 'webrtc' | 'webrtc/tcp' | 'mse' | 'auto';

export type StreamStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error' | 'closed';

export interface StreamState {
  status: StreamStatus;
  activeMode: Exclude<VideoStreamingMode, 'auto'>;
  requestedMode: VideoStreamingMode;
  activeResolution: StreamingRole;
  requestedResolution: StreamingRole;
  source: CameraSource | undefined;
  hasVideo: boolean;
  hasAudio: boolean;
  hasBackchannel: boolean;
  isPlaying: boolean;
  error: Error | undefined;
}

export interface ReactiveStream {
  readonly status: Ref<StreamStatus>;
  readonly activeMode: Ref<Exclude<VideoStreamingMode, 'auto'>>;
  readonly requestedMode: Ref<VideoStreamingMode>;
  readonly activeResolution: Ref<StreamingRole>;
  readonly requestedResolution: Ref<StreamingRole>;
  readonly source: Ref<CameraSource | undefined>;
  readonly hasVideo: Ref<boolean>;
  readonly hasAudio: Ref<boolean>;
  readonly hasBackchannel: Ref<boolean>;
  readonly isPlaying: Ref<boolean>;
  readonly error: Ref<Error | undefined>;
  readonly probeInfo: Ref<ProbeStream | undefined>;
  readonly muted: Ref<boolean>;
  readonly paused: Ref<boolean>;
  readonly nativeWidth: Ref<number>;
  readonly nativeHeight: Ref<number>;

  start: () => Promise<void>;
  stop: () => void;
  restart: () => Promise<void>;
  setMode: (mode: VideoStreamingMode) => Promise<void>;
  setResolution: (resolution: StreamingRole) => Promise<void>;
  setMicrophone: (track: MediaStreamTrack | null) => Promise<void>;
  setMuted: (muted: boolean) => void;
  play: () => Promise<void>;
  pause: () => void;
}

export interface StreamOptions {
  camera: MaybeRefOrGetter<ReactiveCameraDevice | undefined>;
  videoElement: MaybeRefOrGetter<HTMLVideoElement | undefined | null>;
  mode?: MaybeRefOrGetter<VideoStreamingMode>;
  resolution?: MaybeRefOrGetter<StreamingRole>;
  autoStart?: boolean;
  manageLifecycle?: boolean;
  wsReconnectTimeout?: number;
  webrtcConnectTimeout?: number;
}

export interface Go2RTCMessageBase {
  type: 'mse' | 'webrtc/candidate' | 'webrtc/answer' | 'webrtc/offer' | 'error';
}

export interface MSEMessage extends Go2RTCMessageBase {
  type: 'mse';
  value: string | ArrayBuffer;
}

export interface WebRTCAnswerMessage extends Go2RTCMessageBase {
  type: 'webrtc/answer';
  value: string;
}

export interface WebRTCOfferMessage extends Go2RTCMessageBase {
  type: 'webrtc/offer';
  value: string;
}

export interface WebRTCCandidateMessage extends Go2RTCMessageBase {
  type: 'webrtc/candidate';
  value?: string;
}

export type WebRTCMessage = WebRTCAnswerMessage | WebRTCCandidateMessage;

export interface ErrorMessage extends Go2RTCMessageBase {
  type: 'error';
  value: string;
}

export type Go2RTCMessage = MSEMessage | WebRTCMessage | ErrorMessage;

export type Go2RTCWsMessage = WebRTCOfferMessage | WebRTCCandidateMessage | MSEMessage;

export interface CodecCompatibility {
  compatible: boolean;
  audioCompatible: boolean;
  videoCompatible: boolean;
  incompatibleCodecs: string[];
}
