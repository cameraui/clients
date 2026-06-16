import { STREAM_CONFIG } from './config.js';

import type { AudioCodec, ProbeStream } from '@camera.ui/sdk';
import type { CodecCompatibility } from './types.js';

export function isSafari(): boolean {
  return /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
}

export function safariVersion(): RegExpMatchArray | null {
  return navigator.userAgent.match(/version\/(\d+)/i);
}

export function isFirefox(): boolean {
  return navigator.userAgent.toLowerCase().includes('firefox');
}

export function isChrome(): boolean {
  return navigator.userAgent.toLowerCase().includes('chrome');
}

export function isMobile(): boolean {
  return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
}

export function getSupportedCodecs(): string[] {
  const codecs = [...STREAM_CONFIG.CODECS.DEFAULT];

  const version = safariVersion();
  if (version?.[1]) {
    const majorVersion = parseInt(version[1], 10);
    if (majorVersion < 13) {
      const index = codecs.indexOf('mp4a.40.2');
      if (index > -1) codecs.splice(index);
    } else if (majorVersion < 14) {
      const index = codecs.indexOf('flac');
      if (index > -1) codecs.splice(index);
    } else {
      const index = codecs.indexOf('opus');
      if (index > -1) codecs.splice(index);
    }
  }

  return codecs;
}

export function filterSupportedCodecs(codecs: string[], isTypeSupported: (type: string) => boolean): string {
  return codecs.filter((codec) => isTypeSupported(`video/mp4; codecs="${codec}"`)).join(',');
}

export function isWebRTCCompatibleAudio(codec: AudioCodec): boolean {
  return (STREAM_CONFIG.CODECS.WEBRTC_AUDIO as readonly string[]).includes(codec);
}

export function isWebRTCCompatibleVideo(codec: string): boolean {
  if ((STREAM_CONFIG.CODECS.WEBRTC_VIDEO as readonly string[]).includes(codec)) {
    return true;
  }

  if (codec === 'H265') {
    return isH265Supported();
  }

  return false;
}

export function isH265Supported(): boolean {
  try {
    const videoCodecs = RTCRtpSender?.getCapabilities('video')?.codecs;
    if (!videoCodecs) return false;

    return videoCodecs.some((c) => c.mimeType.toLowerCase().includes('h265') || c.mimeType.toLowerCase().includes('hevc'));
  } catch {
    return false;
  }
}

export function checkWebRTCCompatibility(probe: ProbeStream): CodecCompatibility {
  const audioStreams = probe.audio.filter((s) => s.direction === 'sendonly');
  const videoStreams = probe.video.filter((s) => s.direction === 'sendonly');

  const audioCompatible = audioStreams.length === 0 || audioStreams.some((s) => isWebRTCCompatibleAudio(s.codec));
  const videoCompatible = videoStreams.length === 0 || videoStreams.some((s) => isWebRTCCompatibleVideo(s.codec));

  const incompatibleCodecs: string[] = [];
  if (!audioCompatible) {
    incompatibleCodecs.push(...audioStreams.map((s) => s.codec));
  }
  if (!videoCompatible) {
    incompatibleCodecs.push(...videoStreams.map((s) => s.codec));
  }

  return {
    compatible: audioCompatible && videoCompatible,
    audioCompatible,
    videoCompatible,
    incompatibleCodecs,
  };
}

export function hasManagedMediaSource(): boolean {
  return 'ManagedMediaSource' in window;
}

export function hasMediaSource(): boolean {
  return 'MediaSource' in window || hasManagedMediaSource();
}

export function getMediaSourceConstructor(): typeof MediaSource | undefined {
  if (hasManagedMediaSource()) {
    return (window as unknown as { ManagedMediaSource: typeof MediaSource }).ManagedMediaSource;
  }
  if ('MediaSource' in window) {
    return window.MediaSource;
  }
  return undefined;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    const timer = setTimeout(resolve, ms);

    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}
