import { STREAM_CONFIG } from './config.js';

import type { WebRTCMessage } from './types.js';

interface BasePeerConnectionState {
  pc: RTCPeerConnection | null;
  micTransceiver: RTCRtpTransceiver | null;
  isConnected: boolean;
}

function createBasePeerConnection(signal: AbortSignal, onCandidate: (candidate: string) => void, filterUdp: boolean): RTCPeerConnection {
  const peerConnection = new RTCPeerConnection({
    bundlePolicy: 'max-bundle',
    iceServers: [...STREAM_CONFIG.WEBRTC.ICE_SERVERS],
  });

  peerConnection.onicecandidate = (ev) => {
    if (signal.aborted) return;

    if (filterUdp && ev.candidate?.protocol === 'udp') {
      return;
    }

    const candidate = ev.candidate?.toJSON().candidate ?? '';
    if (candidate) {
      onCandidate(candidate);
    }
  };

  return peerConnection;
}

async function handleSdpAnswer(pc: RTCPeerConnection | null, signal: AbortSignal, sdp: string): Promise<void> {
  if (signal.aborted || !pc) return;
  await pc.setRemoteDescription({ type: 'answer', sdp });
}

async function handleIceCandidate(pc: RTCPeerConnection | null, signal: AbortSignal, candidate: string, filterUdp: boolean): Promise<void> {
  if (signal.aborted || !pc) return;

  if (filterUdp && candidate.includes(' udp ')) {
    return;
  }

  await pc.addIceCandidate({ candidate, sdpMid: '0' });
}

async function setMicTrack(micTransceiver: RTCRtpTransceiver | null, signal: AbortSignal, track: MediaStreamTrack | null): Promise<void> {
  if (signal.aborted || !micTransceiver) return;

  try {
    await micTransceiver.sender.replaceTrack(track);
  } catch {
    // Ignore errors
  }
}

function closePeerConnection(state: BasePeerConnectionState): void {
  if (state.micTransceiver) {
    state.micTransceiver.sender.replaceTrack(null).catch(() => {});
    state.micTransceiver = null;
  }

  if (state.pc) {
    state.pc.getTransceivers().forEach((t) => t.sender?.track?.stop());
    state.pc.close();
    state.pc = null;
  }

  state.isConnected = false;
}

export interface WebRTCHandlerOptions {
  mode: 'webrtc' | 'webrtc/tcp';
  onConnected: (stream: MediaStream) => void;
  onDisconnected: () => void;
  onFailed: () => void;
  onCandidate: (candidate: string) => void;
  signal: AbortSignal;
}

export interface WebRTCHandler {
  readonly pc: RTCPeerConnection | null;
  readonly micTransceiver: RTCRtpTransceiver | null;
  readonly isConnected: boolean;
  createOffer: () => Promise<string | undefined>;
  handleAnswer: (sdp: string) => Promise<void>;
  handleCandidate: (candidate: string) => Promise<void>;
  setMicrophoneTrack: (track: MediaStreamTrack | null) => Promise<void>;
  close: () => void;
}

export interface BackchannelHandlerOptions {
  onConnected: () => void;
  onDisconnected: () => void;
  onCandidate: (candidate: string) => void;
  signal: AbortSignal;
}

export interface BackchannelHandler {
  readonly isConnected: boolean;
  createOffer: () => Promise<string | undefined>;
  handleAnswer: (sdp: string) => Promise<void>;
  handleCandidate: (candidate: string) => Promise<void>;
  setMicrophoneTrack: (track: MediaStreamTrack | null) => Promise<void>;
  close: () => void;
}

export function createWebRTCHandler(options: WebRTCHandlerOptions): WebRTCHandler {
  const { mode, onConnected, onDisconnected, onFailed, onCandidate, signal } = options;

  const state: BasePeerConnectionState = {
    pc: null,
    micTransceiver: null,
    isConnected: false,
  };

  const filterUdp = mode === 'webrtc/tcp';

  function createPeerConnection(): RTCPeerConnection {
    const peerConnection = createBasePeerConnection(signal, onCandidate, filterUdp);

    peerConnection.onconnectionstatechange = () => {
      if (signal.aborted) return;

      const connectionState = peerConnection.connectionState;

      if (connectionState === 'connected') {
        state.isConnected = true;

        const stream = new MediaStream(
          peerConnection
            .getTransceivers()
            .filter((tr) => tr.currentDirection === 'recvonly')
            .map((tr) => tr.receiver.track),
        );

        onConnected(stream);
      } else if (connectionState === 'failed') {
        state.isConnected = false;
        onFailed();
      } else if (connectionState === 'disconnected') {
        state.isConnected = false;
        onDisconnected();
      }
    };

    peerConnection.addTransceiver('video', { direction: 'recvonly' });
    peerConnection.addTransceiver('audio', { direction: 'recvonly' });
    state.micTransceiver = peerConnection.addTransceiver('audio', { direction: 'sendonly' });

    return peerConnection;
  }

  async function createOffer(): Promise<string | undefined> {
    if (signal.aborted) return undefined;

    state.pc = createPeerConnection();

    const offer = await state.pc.createOffer();
    await state.pc.setLocalDescription(offer);

    return offer.sdp;
  }

  function close(): void {
    closePeerConnection(state);
  }

  signal.addEventListener('abort', close, { once: true });

  return {
    get pc() {
      return state.pc;
    },
    get micTransceiver() {
      return state.micTransceiver;
    },
    get isConnected() {
      return state.isConnected;
    },
    createOffer,
    handleAnswer: (sdp: string) => handleSdpAnswer(state.pc, signal, sdp),
    handleCandidate: (candidate: string) => handleIceCandidate(state.pc, signal, candidate, filterUdp),
    setMicrophoneTrack: (track: MediaStreamTrack | null) => setMicTrack(state.micTransceiver, signal, track),
    close,
  };
}

export function createBackchannelHandler(options: BackchannelHandlerOptions): BackchannelHandler {
  const { onConnected, onDisconnected, onCandidate, signal } = options;

  const state: BasePeerConnectionState = {
    pc: null,
    micTransceiver: null,
    isConnected: false,
  };

  function createPeerConnection(): RTCPeerConnection {
    const peerConnection = createBasePeerConnection(signal, onCandidate, false);

    peerConnection.onconnectionstatechange = () => {
      if (signal.aborted) return;

      const connectionState = peerConnection.connectionState;

      if (connectionState === 'connected') {
        state.isConnected = true;
        onConnected();
      } else if (connectionState === 'disconnected' || connectionState === 'failed') {
        state.isConnected = false;
        onDisconnected();
      }
    };

    state.micTransceiver = peerConnection.addTransceiver('audio', { direction: 'sendonly' });

    return peerConnection;
  }

  async function createOffer(): Promise<string | undefined> {
    if (signal.aborted) return undefined;

    state.pc = createPeerConnection();

    const offer = await state.pc.createOffer();
    await state.pc.setLocalDescription(offer);

    return offer.sdp;
  }

  function close(): void {
    closePeerConnection(state);
  }

  signal.addEventListener('abort', close, { once: true });

  return {
    get isConnected() {
      return state.isConnected;
    },
    createOffer,
    handleAnswer: (sdp: string) => handleSdpAnswer(state.pc, signal, sdp),
    handleCandidate: (candidate: string) => handleIceCandidate(state.pc, signal, candidate, false),
    setMicrophoneTrack: (track: MediaStreamTrack | null) => setMicTrack(state.micTransceiver, signal, track),
    close,
  };
}

export async function processWebRTCMessage(handler: WebRTCHandler | BackchannelHandler, msg: WebRTCMessage): Promise<void> {
  switch (msg.type) {
    case 'webrtc/answer':
      await handler.handleAnswer(msg.value);
      break;
    case 'webrtc/candidate':
      if (msg.value) {
        await handler.handleCandidate(msg.value);
      }
      break;
  }
}
