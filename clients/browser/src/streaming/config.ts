export const STREAM_CONFIG = {
  WEBRTC: {
    RECONNECT_DELAY: 1000,
    CONNECT_TIMEOUT: 10000,
    WS_CONNECT_TIMEOUT: 5000,
    ICE_SERVERS: [{ urls: 'stun:stun.l.google.com:19302' }],
  },

  MSE: {
    BUFFER_SIZE: 2 * 1024 * 1024,
    BUFFER_WINDOW: 5,
  },

  CODECS: {
    DEFAULT: ['avc1.640029', 'avc1.64002A', 'avc1.640033', 'hvc1.1.6.L153.B0', 'mp4a.40.2', 'mp4a.40.5', 'flac', 'opus'],
    WEBRTC_VIDEO: ['H264', 'VP8', 'VP9'],
    WEBRTC_AUDIO: ['opus', 'G722', 'PCMU', 'PCMA'],
  },
} as const;

export type StreamConfig = typeof STREAM_CONFIG;
