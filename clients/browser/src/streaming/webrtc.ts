import { STREAM_CONFIG } from './config.js';
import { orderRelayFirst, relayFirstIceServers, relayPermitCandidate } from './relayFirst.js';

import type { StreamConnectionPath, WebRTCMessage } from './types.js';

type PeerPath = Exclude<StreamConnectionPath, 'tunnel'>;

interface BasePeerConnectionState {
  pc: RTCPeerConnection | null;
  micTransceiver: RTCRtpTransceiver | null;
  isConnected: boolean;
}

function newPeerConnection(iceServers: RTCIceServer[] = [...STREAM_CONFIG.WEBRTC.ICE_SERVERS]): RTCPeerConnection {
  try {
    return new RTCPeerConnection({ bundlePolicy: 'max-bundle', iceServers });
  } catch {
    return new RTCPeerConnection({ bundlePolicy: 'max-bundle', iceServers: [...STREAM_CONFIG.WEBRTC.ICE_SERVERS] });
  }
}

function createBasePeerConnection(
  signal: AbortSignal,
  onCandidate: (candidate: string) => void,
  filterUdp: boolean,
  iceServers: RTCIceServer[] | undefined,
): RTCPeerConnection {
  const peerConnection = newPeerConnection(iceServers);

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

function createRelayFirst(state: BasePeerConnectionState, signal: AbortSignal, filterUdp: boolean, probe: Promise<string | undefined> | undefined) {
  const add = (candidate: string): Promise<void> => handleIceCandidate(state.pc, signal, candidate, filterUdp);
  let address: string | undefined;
  let handle = add;

  return {
    async settle(): Promise<void> {
      address = probe && !filterUdp ? await probe : undefined;
      if (address) handle = orderRelayFirst(add);
    },
    iceServers: (servers: RTCIceServer[] | undefined): RTCIceServer[] | undefined => (address ? relayFirstIceServers(servers) : servers),
    permit(send: (candidate: string) => void): void {
      if (address && !signal.aborted) send(relayPermitCandidate(address));
    },
    handleCandidate: (candidate: string): Promise<void> => handle(candidate),
  };
}

async function setMicTrack(micTransceiver: RTCRtpTransceiver | null, signal: AbortSignal, track: MediaStreamTrack | null): Promise<void> {
  if (signal.aborted || !micTransceiver) return;

  try {
    await micTransceiver.sender.replaceTrack(track);
  } catch {
    // ignore
  }
}

async function readPeerPath(pc: RTCPeerConnection): Promise<PeerPath | undefined> {
  const reports = new Map<string, any>();
  let pairId: string | undefined;
  (await pc.getStats()).forEach((report, id) => {
    reports.set(id, report);
    if (report.type === 'transport' && report.selectedCandidatePairId) {
      pairId = report.selectedCandidatePairId;
    } else if (report.type === 'candidate-pair' && report.selected) {
      // Firefox has no transport stats, it flags the pair itself
      pairId ??= id;
    }
  });

  const pair = pairId ? reports.get(pairId) : undefined;
  if (!pair) return undefined;
  const types = [reports.get(pair.localCandidateId)?.candidateType, reports.get(pair.remoteCandidateId)?.candidateType];
  return types.includes('relay') ? 'relay' : 'direct';
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
  iceServers?: RTCIceServer[];
  relayFirst?: Promise<string | undefined>;
  onConnected: (stream: MediaStream) => void;
  onReconnected: () => void;
  onDisconnected: () => void;
  onFailed: () => void;
  onCandidate: (candidate: string) => void;
  onPath: (path: PeerPath) => void;
  signal: AbortSignal;
}

export interface WebRTCHandler {
  readonly pc: RTCPeerConnection | null;
  readonly isConnected: boolean;
  createOffer: () => Promise<string | undefined>;
  handleAnswer: (sdp: string) => Promise<void>;
  handleCandidate: (candidate: string) => Promise<void>;
  close: () => void;
}

export interface BackchannelHandlerOptions {
  filterUdp: boolean;
  iceServers?: RTCIceServer[];
  relayFirst?: Promise<string | undefined>;
  onConnected: () => void;
  onFailed: () => void;
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
  const { mode, iceServers, relayFirst, onConnected, onReconnected, onDisconnected, onFailed, onCandidate, onPath, signal } = options;

  const state: BasePeerConnectionState = {
    pc: null,
    micTransceiver: null,
    isConnected: false,
  };

  const filterUdp = mode === 'webrtc/tcp';
  const relay = createRelayFirst(state, signal, filterUdp, relayFirst);

  async function handleAnswer(sdp: string): Promise<void> {
    await handleSdpAnswer(state.pc, signal, sdp);
    relay.permit(onCandidate);
  }

  function createPeerConnection(): RTCPeerConnection {
    const peerConnection = createBasePeerConnection(signal, onCandidate, filterUdp, relay.iceServers(iceServers));
    let stream: MediaStream | undefined;

    function reportPath(): void {
      readPeerPath(peerConnection).then(
        (path) => {
          if (path && !signal.aborted && state.pc === peerConnection) onPath(path);
        },
        () => {},
      );
    }

    peerConnection.onconnectionstatechange = () => {
      if (signal.aborted) return;

      const connectionState = peerConnection.connectionState;

      if (connectionState === 'connected') {
        state.isConnected = true;
        reportPath();

        if (stream) {
          onReconnected();
          return;
        }

        stream = new MediaStream(
          peerConnection
            .getTransceivers()
            .filter((tr) => tr.currentDirection === 'recvonly')
            .map((tr) => tr.receiver.track),
        );
        // ICE can move to another pair without leaving the connected state
        peerConnection.getReceivers()[0]?.transport?.iceTransport?.addEventListener('selectedcandidatepairchange', reportPath);

        onConnected(stream);
      } else if (connectionState === 'failed') {
        state.isConnected = false;
        onFailed();
      } else if (connectionState === 'disconnected') {
        state.isConnected = false;
        onDisconnected();
      }
    };

    peerConnection.oniceconnectionstatechange = () => {
      if (!signal.aborted && state.isConnected) reportPath();
    };

    peerConnection.addTransceiver('video', { direction: 'recvonly' });
    peerConnection.addTransceiver('audio', { direction: 'recvonly' });

    return peerConnection;
  }

  async function createOffer(): Promise<string | undefined> {
    if (signal.aborted) return undefined;
    await relay.settle();
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
    get isConnected() {
      return state.isConnected;
    },
    createOffer,
    handleAnswer,
    handleCandidate: relay.handleCandidate,
    close,
  };
}

export function createBackchannelHandler(options: BackchannelHandlerOptions): BackchannelHandler {
  const { filterUdp, iceServers, relayFirst, onConnected, onFailed, onCandidate, signal } = options;

  const state: BasePeerConnectionState = {
    pc: null,
    micTransceiver: null,
    isConnected: false,
  };

  // go2rtc applies a candidate to the socket's last answered peer, one sent before this answer would reach an older peer
  let answered = false;
  const heldCandidates: string[] = [];
  let disconnectGrace: ReturnType<typeof setTimeout> | undefined;
  const relay = createRelayFirst(state, signal, filterUdp, relayFirst);

  function sendCandidate(candidate: string): void {
    if (answered) onCandidate(candidate);
    else heldCandidates.push(candidate);
  }

  async function handleAnswer(sdp: string): Promise<void> {
    if (signal.aborted || !state.pc) return;
    answered = true;
    for (const candidate of heldCandidates.splice(0)) onCandidate(candidate);
    relay.permit(onCandidate);
    await state.pc.setRemoteDescription({ type: 'answer', sdp });
  }

  function createPeerConnection(): RTCPeerConnection {
    const peerConnection = createBasePeerConnection(signal, sendCandidate, filterUdp, relay.iceServers(iceServers));

    peerConnection.onconnectionstatechange = () => {
      if (signal.aborted) return;

      const connectionState = peerConnection.connectionState;

      if (connectionState === 'connected') {
        clearTimeout(disconnectGrace);
        state.isConnected = true;
        onConnected();
      } else if (connectionState === 'disconnected') {
        state.isConnected = false;
        disconnectGrace = setTimeout(onFailed, STREAM_CONFIG.WEBRTC.DISCONNECT_GRACE);
      } else if (connectionState === 'failed') {
        clearTimeout(disconnectGrace);
        state.isConnected = false;
        onFailed();
      }
    };

    state.micTransceiver = peerConnection.addTransceiver('audio', { direction: 'sendonly' });

    return peerConnection;
  }

  async function createOffer(): Promise<string | undefined> {
    if (signal.aborted) return undefined;
    await relay.settle();
    if (signal.aborted) return undefined;

    state.pc = createPeerConnection();

    const offer = await state.pc.createOffer();
    await state.pc.setLocalDescription(offer);

    return offer.sdp;
  }

  function close(): void {
    clearTimeout(disconnectGrace);
    closePeerConnection(state);
  }

  signal.addEventListener('abort', close, { once: true });

  return {
    get isConnected() {
      return state.isConnected;
    },
    createOffer,
    handleAnswer,
    handleCandidate: relay.handleCandidate,
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
