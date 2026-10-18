import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, ref } from 'vue';

import { STREAM_CONFIG } from '../config.js';
import { StreamConnection } from '../streamConnection.js';
import { reportH265DecodeFailure } from '../utils.js';
import {
  FakeCanvas,
  FakeImageDecoder,
  FakeMediaSource,
  FakeMediaStream,
  FakePeerConnection,
  FakeVideo,
  FakeWsTransport,
  fragment,
  H264_MIME,
  H265_MIME,
  initSegment,
  installMediaGlobals,
  jpegFrame,
  restoreMediaGlobals,
  settle,
  videoFrame,
} from './fakes.js';

import type { CameraSource, ProbeStream } from '@camera.ui/sdk';
import type { ReactiveCameraDevice } from '../../types.js';
import type { VideoStreamingMode } from '../types.js';
import type { FakeWsHandle } from './fakes.js';

const ctx = vi.hoisted(() => ({ target: undefined as unknown, wsTransport: undefined as unknown }));
const tab = vi.hoisted(() => ({
  paused: [] as { cb: () => void; delayMs?: number }[],
  visible: [] as ((info: { hiddenMs: number }) => void)[],
}));

vi.mock('../../composables/useCameraUi.js', () => ({ useCameraUi: () => ctx }));
vi.mock('../../server/index.js', () => ({ createSourceName: (camera: string, source: string) => `${camera}_${source}` }));
vi.mock('../utils.js', async (importOriginal) => ({ ...(await importOriginal<object>()), reportH265DecodeFailure: vi.fn() }));
vi.mock('../../composables/useTabVisibility.js', () => ({
  DEFAULT_TAB_PAUSE_MS: 30_000,
  useTabVisibility: () => ({
    onTabPaused: (cb: () => void, options?: { delayMs?: number }) => {
      tab.paused.push({ cb, delayMs: options?.delayMs });
      return () => {};
    },
    onTabVisible: (cb: (info: { hiddenMs: number }) => void) => {
      tab.visible.push(cb);
      return () => {};
    },
  }),
}));

const H264_SOURCE = { _id: 'main', name: 'main', role: 'high-resolution', videoCodec: 'H264' } as CameraSource;
const PROBE: ProbeStream = {
  video: [{ direction: 'sendonly', codec: 'H264' }],
  audio: [{ direction: 'sendonly', codec: 'opus' }],
} as ProbeStream;
const PROBE_WITH_TALK: ProbeStream = {
  video: [{ direction: 'sendonly', codec: 'H264' }],
  audio: [
    { direction: 'sendonly', codec: 'opus' },
    { direction: 'recvonly', codec: 'PCMU' },
  ],
} as ProbeStream;

function setup(options: { mode?: VideoStreamingMode; sources?: CameraSource[]; probe?: ProbeStream } = {}) {
  const ws = new FakeWsTransport();
  const target = ref({ endpoint: { url: 'http://nvr.local' }, tokens: { access: 'token' } });
  ctx.target = target;
  ctx.wsTransport = ws;
  const camera = {
    name: ref('Garage'),
    sources: ref(options.sources ?? [H264_SOURCE]),
    streamSource: ref(undefined),
    probeStream: vi.fn(async () => options.probe ?? PROBE),
  } as unknown as ReactiveCameraDevice;
  const video = new FakeVideo();
  const scope = effectScope();
  const conn = scope.run(() => new StreamConnection({ camera, videoElement: video as unknown as HTMLVideoElement, mode: options.mode ?? 'mse', autoStart: false }))!;
  return { conn, ws, video, scope, target, camera, probeStream: vi.mocked(camera.probeStream) };
}

function renewToken(target: ReturnType<typeof setup>['target'], access: string): void {
  target.value = { ...target.value, tokens: { access } };
}

// MSE negotiated and its first frame on screen
async function playMse(handle: FakeWsHandle, video: FakeVideo): Promise<void> {
  await negotiate(handle);
  await feed(handle, 5);
  video.advance(40);
}

async function expectNextSocketAt(ws: FakeWsTransport, ms: number): Promise<FakeWsHandle> {
  const count = ws.handles.length;
  await vi.advanceTimersByTimeAsync(ms - 1);
  expect(ws.handles).toHaveLength(count);
  await vi.advanceTimersByTimeAsync(1);
  expect(ws.handles).toHaveLength(count + 1);
  return ws.handles[count];
}

async function negotiate(handle: FakeWsHandle, mime = H264_MIME): Promise<void> {
  handle.serverOpen();
  await settle();
  handle.serverText({ type: 'mse', value: mime });
  handle.serverBinary(initSegment());
  await settle();
}

async function feed(handle: FakeWsHandle, frames: number): Promise<void> {
  for (let i = 0; i < frames; i++) handle.serverBinary(videoFrame(i, 2));
  await settle();
}

beforeEach(() => {
  installMediaGlobals();
  vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
  vi.stubGlobal('MediaStream', FakeMediaStream);
  FakePeerConnection.instances = [];
  vi.mocked(reportH265DecodeFailure).mockClear();
  tab.paused.length = 0;
  tab.visible.length = 0;
  // retry delays at the top of their jitter range
  vi.spyOn(Math, 'random').mockReturnValue(0);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  restoreMediaGlobals();
});

describe('StreamConnection live edge', () => {
  it('seeks a lagging playhead to just behind the live edge', async () => {
    const { conn, ws, video, scope } = setup();
    await conn.start();
    await negotiate(ws.handles[0]);
    await feed(ws.handles[0], 75);
    video.advance(40);

    await vi.advanceTimersByTimeAsync(1000);

    expect(video.currentTime).toBeCloseTo(3 - 0.3, 2);
    scope.stop();
  });

  it('keeps chasing the live edge after a reconnect', async () => {
    const { conn, ws, video, scope } = setup();
    await conn.start();
    await negotiate(ws.handles[0]);

    ws.handles[0].serverClose(1006);
    await vi.advanceTimersByTimeAsync(2000);
    expect(ws.handles).toHaveLength(2);

    await negotiate(ws.handles[1]);
    await feed(ws.handles[1], 75);
    video.advance(40);
    expect(conn.status.value).toBe('connected');
    await vi.advanceTimersByTimeAsync(1000);

    expect(video.currentTime).toBeGreaterThan(2);
    scope.stop();
  });
});

describe('StreamConnection MSE failures', () => {
  it('reconnects after a runtime failure with a growing delay', async () => {
    const { conn, ws, video, scope } = setup();
    await conn.start();

    await negotiate(ws.handles[0]);
    await feed(ws.handles[0], 1);
    expect(conn.status.value).toBe('connected');

    video.sourceBuffer!.throwAlways = new DOMException('gone', 'InvalidStateError');
    ws.handles[0].serverBinary(videoFrame(1, 2));
    await settle();

    expect(conn.status.value).toBe('reconnecting');
    expect(conn.isPlaying.value).toBe(false);
    expect(ws.handles[0].disposed).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);
    expect(ws.handles).toHaveLength(2);

    await negotiate(ws.handles[1]);
    video.sourceBuffer!.throwAlways = new DOMException('gone', 'InvalidStateError');
    ws.handles[1].serverBinary(videoFrame(0, 2));
    await settle();

    await vi.advanceTimersByTimeAsync(1999);
    expect(ws.handles).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(ws.handles).toHaveLength(3);
    scope.stop();
  });

  it('stops for good and closes the socket when the browser refuses the stream', async () => {
    const { conn, ws, scope } = setup();
    await conn.start();
    FakeMediaSource.nextAddSourceBufferError = new DOMException('no decoder', 'NotSupportedError');

    await negotiate(ws.handles[0]);

    expect(conn.status.value).toBe('error');
    expect(ws.handles[0].disposed).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ws.handles).toHaveLength(1);
    scope.stop();
  });

  it('moves to another source when H.265 fails to decode before the first frame', async () => {
    const { conn, ws, video, scope } = setup({
      sources: [
        { _id: 'hevc', name: 'main', role: 'high-resolution', videoCodec: 'H265' } as CameraSource,
        { _id: 'avc', name: 'sub', role: 'low-resolution', videoCodec: 'H264' } as CameraSource,
      ],
    });
    await conn.start();
    expect(ws.handles[0].spec.query?.src).toBe('Garage_main');

    await negotiate(ws.handles[0], H265_MIME);
    video.readyState = 1;
    video.fail(3, 'PIPELINE_ERROR_DECODE');
    await vi.advanceTimersByTimeAsync(1000);

    expect(ws.handles).toHaveLength(2);
    expect(ws.handles[1].spec.query?.src).toBe('Garage_sub');
    expect(conn.degradedFrom.value).toBe('high-resolution');
    scope.stop();
  });

  it('drops only the MSE path when it fails while WebRTC is still negotiating', async () => {
    const { conn, ws, scope } = setup({ mode: 'auto' });
    await conn.start();
    const handle = ws.handles[0];
    FakeMediaSource.nextAddSourceBufferError = new DOMException('no decoder', 'NotSupportedError');

    await negotiate(handle);

    expect(handle.sentMessages()).toContainEqual({ type: 'mse/stop' });
    expect(handle.sentMessages().some((m) => m.type === 'webrtc/offer')).toBe(true);
    expect(handle.disposed).toBe(false);
    expect(conn.status.value).toBe('connecting');
    scope.stop();
  });
});

describe('StreamConnection auto mode', () => {
  function mseRequests(handle: FakeWsHandle): number {
    return handle.sentMessages().filter((m) => m.type === 'mse').length;
  }

  async function resumeMse(handle: FakeWsHandle, video: FakeVideo): Promise<void> {
    handle.serverText({ type: 'mse', value: H264_MIME });
    handle.serverBinary(initSegment());
    await feed(handle, 5);
    video.advance(40);
  }

  it('still offers WebRTC when the browser has no MediaSource', async () => {
    delete (globalThis as { MediaSource?: unknown }).MediaSource;
    const { conn, ws, scope } = setup({ mode: 'auto' });
    await conn.start();
    const handle = ws.handles[0];

    handle.serverOpen();
    await settle();

    expect(handle.sentMessages().some((m) => m.type === 'webrtc/offer')).toBe(true);
    expect(conn.status.value).toBe('connecting');
    expect(handle.disposed).toBe(false);
    scope.stop();
  });

  it.each([
    [
      'a rejected append',
      (video: FakeVideo, handle: FakeWsHandle) => {
        video.sourceBuffer!.throwAlways = new DOMException('gone', 'InvalidStateError');
        handle.serverBinary(videoFrame(5, 2));
      },
    ],
    ['a SourceBuffer error', (video: FakeVideo) => video.sourceBuffer!.emit('error')],
    [
      'a buffer overflow',
      (video: FakeVideo, handle: FakeWsHandle) => {
        video.sourceBuffer!.updating = true;
        for (let i = 0; i < 3; i++) handle.serverBinary(new ArrayBuffer(1024 * 1024));
      },
    ],
  ])('shows the outage and falls back to a fresh MSE after %s while WebRTC never answers', async (_name, breakMse) => {
    const { conn, ws, video, scope } = setup({ mode: 'auto' });
    await conn.start();
    const handle = ws.handles[0];
    await playMse(handle, video);
    expect(conn.status.value).toBe('connected');
    expect(conn.isPlaying.value).toBe(true);

    breakMse(video, handle);
    await settle();

    expect(conn.isPlaying.value).toBe(false);
    expect(conn.status.value).toBe('reconnecting');
    expect(handle.sentMessages()).toContainEqual({ type: 'mse/stop' });

    await vi.advanceTimersByTimeAsync(STREAM_CONFIG.WEBRTC.CONNECT_TIMEOUT);
    expect(mseRequests(handle)).toBe(2);

    await resumeMse(handle, video);
    expect(conn.status.value).toBe('connected');
    expect(conn.isPlaying.value).toBe(true);
    expect(ws.handles).toHaveLength(1);
    scope.stop();
  });

  it('falls back to a fresh MSE when it fails after its first bytes but before it was ready', async () => {
    const { conn, ws, video, scope } = setup({ mode: 'auto' });
    await conn.start();
    const handle = ws.handles[0];
    handle.serverOpen();
    await settle();

    video.mediaSource!.readyState = 'closed';
    handle.serverText({ type: 'mse', value: H264_MIME });
    handle.serverBinary(initSegment());
    await settle();

    video.mediaSource!.readyState = 'open';
    FakeMediaSource.nextAddSourceBufferError = new DOMException('no decoder', 'NotSupportedError');
    video.mediaSource!.emit('sourceopen');
    await settle();

    expect(conn.isPlaying.value).toBe(false);

    await vi.advanceTimersByTimeAsync(STREAM_CONFIG.WEBRTC.CONNECT_TIMEOUT);
    expect(mseRequests(handle)).toBe(2);

    await resumeMse(handle, video);
    expect(conn.status.value).toBe('connected');
    expect(conn.isPlaying.value).toBe(true);
    scope.stop();
  });
});

describe('StreamConnection stop', () => {
  it('reports a stopped stream as no longer playing', async () => {
    const { conn, ws, video, scope } = setup();
    await conn.start();
    await playMse(ws.handles[0], video);
    expect(conn.isPlaying.value).toBe(true);

    conn.stop();

    expect(conn.status.value).toBe('closed');
    expect(conn.isPlaying.value).toBe(false);
    scope.stop();
  });
});

describe('StreamConnection reconnect policy', () => {
  it('backs off with growing delays while the socket keeps dropping', async () => {
    const { conn, ws, scope } = setup();
    await conn.start();
    ws.handles[0].serverOpen();
    await settle();

    ws.handles[0].serverClose(4500, 'upstream lost');
    expect(conn.status.value).toBe('reconnecting');

    let handle = await expectNextSocketAt(ws, 1000);
    handle.serverOpen();
    await settle();
    handle.serverClose(1006);
    handle = await expectNextSocketAt(ws, 2000);
    handle.serverClose(1011);
    await expectNextSocketAt(ws, 4000);
    scope.stop();
  });

  it('spreads the reconnects of many tiles with jitter', async () => {
    vi.mocked(Math.random).mockReturnValue(0.5);
    const { conn, ws, scope } = setup();
    await conn.start();

    ws.handles[0].serverClose(1006);

    await expectNextSocketAt(ws, 750);
    scope.stop();
  });

  it('counts a socket that closes before its first message as a failed attempt', async () => {
    // HA ingress accepts the upgrade itself and closes with 1000 while camera.ui is down
    const { conn, ws, scope } = setup();
    await conn.start();

    for (const delay of [1000, 2000, 4000, 8000]) {
      const handle = ws.handles.at(-1)!;
      handle.serverOpen();
      await settle();
      handle.serverClose(1000);
      await expectNextSocketAt(ws, delay);
    }
    scope.stop();
  });

  it('starts over from the base delay after a session that played for 30 s', async () => {
    const { conn, ws, video, scope } = setup();
    await conn.start();
    ws.handles[0].serverClose(1006);
    let handle = await expectNextSocketAt(ws, 1000);
    handle.serverClose(1006);
    handle = await expectNextSocketAt(ws, 2000);

    await playMse(handle, video);
    expect(conn.isPlaying.value).toBe(true);
    for (let i = 0; i < 30; i++) {
      video.presentFrame();
      await vi.advanceTimersByTimeAsync(1000);
    }
    handle.serverClose(1006);

    await expectNextSocketAt(ws, 1000);
    scope.stop();
  });

  it.each([4403, 4400])('keeps the tile stopped after %i until the token changes', async (code) => {
    const { conn, ws, scope, target } = setup();
    await conn.start();
    ws.handles[0].serverOpen();
    await settle();

    ws.handles[0].serverClose(code, 'forbidden: source not shared');

    expect(conn.status.value).toBe('error');
    expect(conn.error.value?.message).toContain('source not shared');
    expect(ws.handles[0].disposed).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(ws.handles).toHaveLength(1);

    renewToken(target, 'token-2');
    await vi.advanceTimersByTimeAsync(10);
    expect(ws.handles).toHaveLength(2);
    scope.stop();
  });

  it('waits for a fresh token after 4401 instead of retrying with the rejected one', async () => {
    const { conn, ws, scope, target } = setup();
    await conn.start();
    ws.handles[0].serverOpen();
    await settle();

    ws.handles[0].serverClose(4401, 'unauthorized: token expired');

    await vi.advanceTimersByTimeAsync(10_000);
    expect(ws.handles).toHaveLength(1);
    expect(conn.status.value).toBe('reconnecting');

    renewToken(target, 'token-2');
    await vi.advanceTimersByTimeAsync(10);
    expect(ws.handles).toHaveLength(2);
    scope.stop();
  });

  it('tries again after 4401 at the longest backoff when no new token arrives', async () => {
    const { conn, ws, scope } = setup();
    await conn.start();

    ws.handles[0].serverClose(4401, 'unauthorized: unknown token');

    await expectNextSocketAt(ws, 30_000);
    scope.stop();
  });

  it('spreads the retries after 4401 with jitter', async () => {
    vi.mocked(Math.random).mockReturnValue(0.5);
    const { conn, ws, scope } = setup();
    await conn.start();

    ws.handles[0].serverClose(4401, 'unauthorized: unknown token');

    await expectNextSocketAt(ws, 22_500);
    scope.stop();
  });

  it('gives up on a socket that never opens', async () => {
    const { conn, ws, scope } = setup();
    await conn.start();

    await vi.advanceTimersByTimeAsync(STREAM_CONFIG.WEBRTC.WS_CONNECT_TIMEOUT);

    expect(ws.handles[0].disposed).toBe(true);
    expect(conn.status.value).toBe('reconnecting');
    scope.stop();
  });

  it('gives a slow address lookup more time than a socket that does not open', async () => {
    const { conn, ws, scope } = setup();
    ws.hangResolve = true;
    await conn.start();

    await vi.advanceTimersByTimeAsync(12_000);
    expect(ws.handles).toHaveLength(1);
    expect(ws.handles[0].disposed).toBe(false);

    ws.handles[0].serverOpen();
    await settle();
    expect(conn.status.value).toBe('connecting');
    expect(ws.handles[0].sentMessages().some((m) => m.type === 'mse')).toBe(true);
    scope.stop();
  });

  it('gives up on a socket whose address never resolves', async () => {
    const { conn, ws, scope } = setup();
    ws.hangResolve = true;
    await conn.start();

    await vi.advanceTimersByTimeAsync(14_999);
    expect(ws.handles[0].disposed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(ws.handles[0].disposed).toBe(true);
    expect(conn.status.value).toBe('reconnecting');
    await expectNextSocketAt(ws, 1000);
    scope.stop();
  });
});

describe('StreamConnection stall watchdog', () => {
  it('counts the stream as playing from its first shown frame, not its first bytes', async () => {
    const { conn, ws, video, scope } = setup();
    await conn.start();
    await negotiate(ws.handles[0]);
    await feed(ws.handles[0], 5);

    expect(conn.status.value).toBe('connected');
    expect(conn.isPlaying.value).toBe(false);

    video.advance(40);
    expect(conn.isPlaying.value).toBe(true);
    scope.stop();
  });

  it('flags a stall after 3 s without a frame and reconnects after 15 s', async () => {
    const { conn, ws, video, scope } = setup();
    await conn.start();
    await playMse(ws.handles[0], video);

    await vi.advanceTimersByTimeAsync(2000);
    expect(conn.stalled.value).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(conn.stalled.value).toBe(true);
    expect(conn.status.value).toBe('connected');

    await vi.advanceTimersByTimeAsync(11_000);
    expect(conn.status.value).toBe('reconnecting');
    expect(conn.stalled.value).toBe(false);
    expect(ws.handles[0].disposed).toBe(true);
    await expectNextSocketAt(ws, 1000);
    scope.stop();
  });

  it('leaves a stream alone while frames keep coming', async () => {
    const { conn, ws, video, scope } = setup();
    await conn.start();
    await playMse(ws.handles[0], video);

    for (let i = 0; i < 20; i++) {
      video.presentFrame();
      await vi.advanceTimersByTimeAsync(1000);
    }

    expect(conn.stalled.value).toBe(false);
    expect(conn.status.value).toBe('connected');
    expect(ws.handles).toHaveLength(1);
    scope.stop();
  });

  it('does not treat a paused video as stalled', async () => {
    const { conn, ws, video, scope } = setup();
    await conn.start();
    await playMse(ws.handles[0], video);

    conn.pause();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(conn.stalled.value).toBe(false);
    expect(ws.handles).toHaveLength(1);
    scope.stop();
  });

  it('does not judge frames while the page is hidden', async () => {
    const { conn, ws, video, scope } = setup();
    await conn.start();
    await playMse(ws.handles[0], video);

    vi.stubGlobal('document', { visibilityState: 'hidden' });
    await vi.advanceTimersByTimeAsync(30_000);

    expect(conn.stalled.value).toBe(false);
    expect(ws.handles).toHaveLength(1);
    scope.stop();
  });

  it('holds the first-frame verdict until a hidden page is visible again', async () => {
    const page = { visibilityState: 'hidden' };
    vi.stubGlobal('document', page);
    const { conn, ws, scope } = setup({ mode: 'webrtc' });
    await conn.start();
    ws.handles[0].serverOpen();
    await settle();
    FakePeerConnection.instances[0].connect();
    await settle();

    await vi.advanceTimersByTimeAsync(STREAM_CONFIG.WEBRTC.CONNECT_TIMEOUT * 3);
    expect(conn.status.value).toBe('connected');
    expect(ws.handles).toHaveLength(1);

    page.visibilityState = 'visible';
    await vi.advanceTimersByTimeAsync(STREAM_CONFIG.WEBRTC.CONNECT_TIMEOUT);
    expect(conn.status.value).toBe('reconnecting');
    scope.stop();
  });

  it('reconnects a WebRTC stream that stops delivering frames', async () => {
    const { conn, ws, video, scope } = setup({ mode: 'webrtc' });
    await conn.start();
    ws.handles[0].serverOpen();
    await settle();
    FakePeerConnection.instances[0].connect();
    await settle();
    video.presentFrame();
    expect(conn.isPlaying.value).toBe(true);

    await vi.advanceTimersByTimeAsync(15_000);

    expect(conn.status.value).toBe('reconnecting');
    expect(FakePeerConnection.instances[0].closed).toBe(true);
    scope.stop();
  });

  it('does not judge a WebRTC stream when the browser reports no frame counts', async () => {
    const { conn, ws, video, scope } = setup({ mode: 'webrtc' });
    (video as { getVideoPlaybackQuality?: unknown }).getVideoPlaybackQuality = undefined;
    await conn.start();
    ws.handles[0].serverOpen();
    await settle();
    FakePeerConnection.instances[0].connect();
    await settle();
    video.presentFrame();

    await vi.advanceTimersByTimeAsync(30_000);

    expect(conn.status.value).toBe('connected');
    expect(ws.handles).toHaveLength(1);
    scope.stop();
  });

  it('falls back to MSE when a WebRTC track that took over from MSE never renders', async () => {
    const { conn, ws, video, scope } = setup({ mode: 'auto' });
    await conn.start();
    const handle = ws.handles[0];
    await playMse(handle, video);
    expect(conn.isPlaying.value).toBe(true);

    FakePeerConnection.instances[0].connect();
    await settle();
    expect(conn.activeMode.value).toBe('webrtc');

    await vi.advanceTimersByTimeAsync(14_000);
    expect(conn.activeMode.value).toBe('webrtc');
    await vi.advanceTimersByTimeAsync(1000);

    expect(conn.activeMode.value).toBe('mse');
    expect(conn.isPlaying.value).toBe(false);
    expect(handle.sentMessages().filter((m) => m.type === 'mse')).toHaveLength(2);
    scope.stop();
  });

  it('gives a WebRTC track that took over from MSE time for the next keyframe', async () => {
    const { conn, ws, video, scope } = setup({ mode: 'auto' });
    await conn.start();
    const handle = ws.handles[0];
    await playMse(handle, video);
    await vi.advanceTimersByTimeAsync(3000);

    FakePeerConnection.instances[0].connect();
    await settle();
    await vi.advanceTimersByTimeAsync(8000);
    video.presentFrame();
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(1000);
      video.presentFrame();
    }

    expect(conn.activeMode.value).toBe('webrtc');
    expect(conn.status.value).toBe('connected');
    expect(FakePeerConnection.instances[0].closed).toBe(false);
    expect(handle.sentMessages().filter((m) => m.type === 'mse')).toHaveLength(1);
    scope.stop();
  });

  it('does not rule out WebRTC H.265 when a track that took over from MSE misses its first frame', async () => {
    const { conn, ws, video, scope } = setup({ mode: 'auto', sources: [{ ...H264_SOURCE, videoCodec: 'H265' } as CameraSource] });
    await conn.start();
    await playMse(ws.handles[0], video);
    FakePeerConnection.instances[0].connect();
    await settle();

    await vi.advanceTimersByTimeAsync(15_000);

    expect(conn.activeMode.value).toBe('mse');
    expect(reportH265DecodeFailure).not.toHaveBeenCalledWith('webrtc');
    scope.stop();
  });

  it('restarts a stream that kept running through a long hidden period', async () => {
    const { conn, ws, video, scope } = setup();
    await conn.start();
    await playMse(ws.handles[0], video);

    tab.visible[0]({ hiddenMs: 60_000 });

    expect(conn.status.value).toBe('reconnecting');
    await expectNextSocketAt(ws, 1000);
    scope.stop();
  });

  it('leaves a stream alone that started after the hidden pause already ran', async () => {
    const { conn, ws, video, scope } = setup();
    tab.paused[0].cb();
    await conn.start();
    await playMse(ws.handles[0], video);

    tab.visible[0]({ hiddenMs: 120_000 });

    expect(conn.status.value).toBe('connected');
    expect(ws.handles).toHaveLength(1);
    scope.stop();
  });

  it('keeps the stream after a short hidden period', async () => {
    const { conn, ws, video, scope } = setup();
    await conn.start();
    await playMse(ws.handles[0], video);

    tab.visible[0]({ hiddenMs: 5000 });

    expect(conn.status.value).toBe('connected');
    expect(ws.handles).toHaveLength(1);
    scope.stop();
  });

  it('keeps a stream that stayed open for picture-in-picture', async () => {
    const { conn, ws, video, scope } = setup();
    await conn.start();
    await playMse(ws.handles[0], video);
    (video as { webkitPresentationMode?: string }).webkitPresentationMode = 'picture-in-picture';

    tab.paused[0].cb();
    tab.visible[0]({ hiddenMs: 60_000 });

    expect(conn.status.value).toBe('connected');
    expect(ws.handles).toHaveLength(1);
    scope.stop();
  });
});

describe('StreamConnection hidden page', () => {
  it('stops a hidden stream at once inside a native app', () => {
    vi.stubGlobal('Capacitor', { isNativePlatform: () => true });
    const { scope } = setup();

    expect(tab.paused[0].delayMs).toBe(0);
    scope.stop();
  });

  it('starts the stream of a hidden page inside a native app only once the page is visible', async () => {
    vi.stubGlobal('Capacitor', { isNativePlatform: () => true });
    const page = { visibilityState: 'hidden' };
    vi.stubGlobal('document', page);
    const { conn, ws, scope } = setup();

    await conn.start();
    await settle();
    expect(ws.handles).toHaveLength(0);

    page.visibilityState = 'visible';
    tab.visible[0]({ hiddenMs: 5000 });
    await settle();
    expect(ws.handles).toHaveLength(1);
    scope.stop();
  });

  it('gives a desktop tab the default grace period', () => {
    const { scope } = setup();

    expect(tab.paused[0].delayMs ?? 30_000).toBe(30_000);
    scope.stop();
  });
});

describe('StreamConnection go2rtc errors', () => {
  const OFFLINE = 'streams: dial tcp 10.0.0.9:554: i/o timeout';

  it('shows the go2rtc error once both paths failed and keeps retrying', async () => {
    const { conn, ws, video, scope } = setup({ mode: 'auto' });
    await conn.start();
    const handle = ws.handles[0];
    handle.serverOpen();
    await settle();

    handle.serverText({ type: 'error', value: `mse: ${OFFLINE}` });
    expect(conn.status.value).toBe('connecting');
    handle.serverText({ type: 'error', value: `webrtc/offer: ${OFFLINE}` });

    expect(conn.status.value).toBe('error');
    expect(conn.error.value?.message).toContain('i/o timeout');
    expect(handle.disposed).toBe(true);

    const next = await expectNextSocketAt(ws, 1000);
    await playMse(next, video);
    expect(conn.status.value).toBe('connected');
    expect(conn.error.value).toBeUndefined();
    scope.stop();
  });

  it('keeps WebRTC negotiating when only the MSE path is refused', async () => {
    const { conn, ws, video, scope } = setup({ mode: 'auto' });
    await conn.start();
    const handle = ws.handles[0];
    handle.serverOpen();
    await settle();

    handle.serverText({ type: 'error', value: `mse: ${OFFLINE}` });
    FakePeerConnection.instances[0].connect();
    await settle();
    video.presentFrame();

    expect(conn.status.value).toBe('connected');
    expect(conn.activeMode.value).toBe('webrtc');
    expect(conn.error.value).toBeUndefined();
    expect(handle.disposed).toBe(false);
    scope.stop();
  });

  it('retries an explicit WebRTC stream after an offer error instead of stopping for good', async () => {
    const { conn, ws, scope } = setup({ mode: 'webrtc' });
    await conn.start();
    const handle = ws.handles[0];
    handle.serverOpen();
    await settle();

    handle.serverText({ type: 'error', value: 'webrtc/offer: codecs not matched' });

    expect(conn.status.value).toBe('error');
    expect(conn.error.value?.message).toContain('codecs not matched');
    expect(handle.disposed).toBe(true);
    await expectNextSocketAt(ws, 1000);
    scope.stop();
  });

  it('leaves a running MSE stream alone when go2rtc refuses the talk backchannel', async () => {
    const { conn, ws, video, scope } = setup({ probe: PROBE_WITH_TALK });
    await conn.start();
    const handle = ws.handles[0];
    await playMse(handle, video);
    expect(conn.hasBackchannel.value).toBe(true);

    await conn.setMicrophone({ kind: 'audio', readyState: 'live' } as unknown as MediaStreamTrack);
    await settle();
    expect(handle.sentMessages().some((m) => m.type === 'webrtc/offer')).toBe(true);

    handle.serverText({ type: 'error', value: 'webrtc/offer: backchannel: no supported codec' });

    expect(conn.status.value).toBe('connected');
    expect(conn.error.value).toBeUndefined();
    expect(conn.isPlaying.value).toBe(true);
    scope.stop();
  });

  it('ignores a rejected ICE candidate', async () => {
    const { conn, ws, scope } = setup({ mode: 'webrtc' });
    await conn.start();
    const handle = ws.handles[0];
    handle.serverOpen();
    await settle();

    handle.serverText({ type: 'error', value: 'webrtc/candidate: unknown session' });

    expect(conn.status.value).toBe('connecting');
    expect(conn.error.value).toBeUndefined();
    expect(handle.disposed).toBe(false);
    scope.stop();
  });
});

describe('StreamConnection talkback', () => {
  const MIC = { kind: 'audio', readyState: 'live', stop: () => {} } as unknown as MediaStreamTrack;

  function offers(handle: FakeWsHandle): number {
    return handle.sentMessages().filter((m) => m.type === 'webrtc/offer').length;
  }

  async function playWebRTC(handle: FakeWsHandle, video: FakeVideo): Promise<FakePeerConnection> {
    handle.serverOpen();
    await settle();
    handle.serverText({ type: 'webrtc/answer', value: 'picture-answer' });
    const picture = FakePeerConnection.instances[0];
    picture.connect();
    await settle();
    video.presentFrame();
    return picture;
  }

  it('offers no microphone with a WebRTC picture', async () => {
    const { conn, ws, scope } = setup({ mode: 'webrtc', probe: PROBE_WITH_TALK });
    await conn.start();
    ws.handles[0].serverOpen();
    await settle();

    expect(FakePeerConnection.instances).toHaveLength(1);
    expect(FakePeerConnection.instances[0].transceivers.map((t) => t.direction)).not.toContain('sendonly');
    scope.stop();
  });

  it('talks over WebRTC through a peer of its own that lives only while talking', async () => {
    const { conn, ws, video, scope } = setup({ mode: 'webrtc', probe: PROBE_WITH_TALK });
    await conn.start();
    const handle = ws.handles[0];
    const picture = await playWebRTC(handle, video);

    await conn.setMicrophone(MIC);
    await settle();
    expect(offers(handle)).toBe(2);
    const talk = FakePeerConnection.instances[1];
    expect(talk.transceivers.map((t) => [t.kind, t.direction])).toEqual([['audio', 'sendonly']]);

    handle.serverText({ type: 'webrtc/answer', value: 'talk-answer' });
    await settle();
    expect(talk.remoteAnswer).toBe('talk-answer');
    expect(picture.remoteAnswer).toBe('picture-answer');

    talk.setState('connected');
    await settle();
    expect(talk.sendsTrack(MIC)).toBe(true);

    await conn.setMicrophone(null);
    expect(talk.closed).toBe(true);
    expect(picture.closed).toBe(false);
    expect(conn.status.value).toBe('connected');
    scope.stop();
  });

  it('holds the talk offer until the WebRTC picture shows its first frame', async () => {
    const { conn, ws, video, scope } = setup({ mode: 'webrtc', probe: PROBE_WITH_TALK });
    await conn.start();
    const handle = ws.handles[0];
    handle.serverOpen();
    await settle();

    await conn.setMicrophone(MIC);
    await settle();
    expect(offers(handle)).toBe(1);

    handle.serverText({ type: 'webrtc/answer', value: 'picture-answer' });
    FakePeerConnection.instances[0].connect();
    await settle();
    expect(offers(handle)).toBe(1);

    video.presentFrame();
    await settle();

    expect(offers(handle)).toBe(2);
    expect(FakePeerConnection.instances[0].remoteAnswer).toBe('picture-answer');
    expect(FakePeerConnection.instances[1].transceivers.map((t) => t.direction)).toEqual(['sendonly']);
    scope.stop();
  });

  it('sends the talk peer candidates after its answer and gives it the server candidates that follow', async () => {
    const { conn, ws, video, scope } = setup({ mode: 'webrtc', probe: PROBE_WITH_TALK });
    await conn.start();
    const handle = ws.handles[0];
    const picture = await playWebRTC(handle, video);

    await conn.setMicrophone(MIC);
    await settle();
    const talk = FakePeerConnection.instances[1];
    talk.emitCandidate('candidate:talk-host');
    expect(handle.sentMessages()).not.toContainEqual({ type: 'webrtc/candidate', value: 'candidate:talk-host' });

    handle.serverText({ type: 'webrtc/answer', value: 'talk-answer' });
    handle.serverText({ type: 'webrtc/candidate', value: 'candidate:server' });
    await settle();

    expect(handle.sentMessages()).toContainEqual({ type: 'webrtc/candidate', value: 'candidate:talk-host' });
    expect(talk.remoteCandidates).toEqual(['candidate:server']);
    expect(picture.remoteCandidates).toEqual([]);
    scope.stop();
  });

  it('keeps UDP out of the talk peer of a WebRTC/TCP stream', async () => {
    const { conn, ws, video, scope } = setup({ mode: 'webrtc/tcp', probe: PROBE_WITH_TALK });
    await conn.start();
    const handle = ws.handles[0];
    await playWebRTC(handle, video);

    await conn.setMicrophone(MIC);
    await settle();
    const talk = FakePeerConnection.instances[1];
    talk.emitCandidate('candidate:udp-host', 'udp');
    talk.emitCandidate('candidate:tcp-host', 'tcp');
    handle.serverText({ type: 'webrtc/answer', value: 'talk-answer' });
    await settle();

    const sent = handle
      .sentMessages()
      .filter((m) => m.type === 'webrtc/candidate')
      .map((m) => m.value);
    expect(sent).toContain('candidate:tcp-host');
    expect(sent).not.toContain('candidate:udp-host');
    scope.stop();
  });

  it('keeps the WebRTC picture when go2rtc refuses the talk offer', async () => {
    const { conn, ws, video, scope } = setup({ mode: 'webrtc', probe: PROBE_WITH_TALK });
    await conn.start();
    const handle = ws.handles[0];
    const picture = await playWebRTC(handle, video);

    await conn.setMicrophone(MIC);
    await settle();
    const talk = FakePeerConnection.instances[1];
    handle.serverText({ type: 'error', value: 'webrtc/offer: backchannel: no supported codec' });

    expect(talk.closed).toBe(true);
    expect(picture.closed).toBe(false);
    expect(conn.status.value).toBe('connected');
    expect(conn.error.value).toBeUndefined();
    expect(handle.disposed).toBe(false);

    await conn.setMicrophone(null);
    await conn.setMicrophone(MIC);
    await settle();
    expect(offers(handle)).toBe(3);
    scope.stop();
  });

  it('offers the next talk only after go2rtc answered the one turned off before its answer', async () => {
    const { conn, ws, video, scope } = setup({ mode: 'webrtc', probe: PROBE_WITH_TALK });
    await conn.start();
    const handle = ws.handles[0];
    const picture = await playWebRTC(handle, video);

    await conn.setMicrophone(MIC);
    await settle();
    const firstTalk = FakePeerConnection.instances[1];
    await conn.setMicrophone(null);
    await conn.setMicrophone(MIC);
    await settle();
    expect(offers(handle)).toBe(2);

    handle.serverText({ type: 'webrtc/answer', value: 'first-talk-answer' });
    handle.serverText({ type: 'webrtc/candidate', value: 'candidate:first-talk' });
    await settle();
    expect(offers(handle)).toBe(3);
    const nextTalk = FakePeerConnection.instances[2];

    handle.serverText({ type: 'webrtc/answer', value: 'next-talk-answer' });
    await settle();

    expect(firstTalk.remoteAnswer).toBeUndefined();
    expect(nextTalk.remoteAnswer).toBe('next-talk-answer');
    expect(picture.remoteAnswer).toBe('picture-answer');
    expect([...picture.remoteCandidates, ...nextTalk.remoteCandidates]).not.toContain('candidate:first-talk');
    scope.stop();
  });

  it('keeps the next talk when go2rtc refuses the one turned off before its answer', async () => {
    const { conn, ws, video, scope } = setup({ mode: 'webrtc', probe: PROBE_WITH_TALK });
    await conn.start();
    const handle = ws.handles[0];
    const picture = await playWebRTC(handle, video);

    await conn.setMicrophone(MIC);
    await settle();
    await conn.setMicrophone(null);
    await conn.setMicrophone(MIC);
    await settle();

    handle.serverText({ type: 'error', value: 'webrtc/offer: streams: i/o timeout' });
    await settle();
    expect(offers(handle)).toBe(3);
    const nextTalk = FakePeerConnection.instances[2];

    handle.serverText({ type: 'webrtc/answer', value: 'next-talk-answer' });
    await settle();

    expect(nextTalk.closed).toBe(false);
    expect(nextTalk.remoteAnswer).toBe('next-talk-answer');
    expect(picture.closed).toBe(false);
    expect(conn.status.value).toBe('connected');
    scope.stop();
  });

  it('talks only after the late answer of a WebRTC picture given up for MSE, and gives that answer to no peer', async () => {
    const { conn, ws, video, scope } = setup({ mode: 'auto', probe: PROBE_WITH_TALK });
    await conn.start();
    const handle = ws.handles[0];
    await playMse(handle, video);
    const picture = FakePeerConnection.instances[0];

    await conn.setMicrophone(MIC);
    await settle();
    await vi.advanceTimersByTimeAsync(STREAM_CONFIG.WEBRTC.CONNECT_TIMEOUT);
    expect(conn.activeMode.value).toBe('mse');
    expect(offers(handle)).toBe(1);

    handle.serverText({ type: 'webrtc/answer', value: 'picture-answer' });
    await settle();
    expect(offers(handle)).toBe(2);
    const talk = FakePeerConnection.instances[1];
    expect(talk.remoteAnswer).toBeUndefined();

    handle.serverText({ type: 'webrtc/answer', value: 'talk-answer' });
    await settle();

    expect(talk.remoteAnswer).toBe('talk-answer');
    expect(picture.remoteAnswer).toBeUndefined();
    scope.stop();
  });

  it('closes a talk peer whose connection failed', async () => {
    const { conn, ws, video, scope } = setup({ mode: 'webrtc', probe: PROBE_WITH_TALK });
    await conn.start();
    const handle = ws.handles[0];
    const picture = await playWebRTC(handle, video);

    await conn.setMicrophone(MIC);
    await settle();
    const talk = FakePeerConnection.instances[1];
    handle.serverText({ type: 'webrtc/answer', value: 'talk-answer' });
    talk.setState('connected');
    await settle();

    talk.setState('failed');

    expect(talk.closed).toBe(true);
    expect(picture.closed).toBe(false);
    scope.stop();
  });

  it('still ends a talk whose peer lost its connection for a moment', async () => {
    const { conn, ws, video, scope } = setup({ mode: 'webrtc', probe: PROBE_WITH_TALK });
    await conn.start();
    const handle = ws.handles[0];
    await playWebRTC(handle, video);

    await conn.setMicrophone(MIC);
    await settle();
    const talk = FakePeerConnection.instances[1];
    handle.serverText({ type: 'webrtc/answer', value: 'talk-answer' });
    talk.setState('connected');
    await settle();

    talk.setState('disconnected');
    expect(talk.closed).toBe(false);
    await conn.setMicrophone(null);

    expect(talk.closed).toBe(true);
    scope.stop();
  });

  it('leaves the next talk alone when the offer of one turned off fails', async () => {
    const { conn, ws, video, scope } = setup({ mode: 'webrtc', probe: PROBE_WITH_TALK });
    await conn.start();
    const handle = ws.handles[0];
    handle.serverOpen();
    await settle();
    await conn.setMicrophone(MIC);
    handle.serverText({ type: 'webrtc/answer', value: 'picture-answer' });
    await settle();

    FakePeerConnection.instances[0].connect();
    video.presentFrame();
    conn.setMicrophone(null);
    const talking = conn.setMicrophone(MIC);
    await settle();
    await talking;

    const nextTalk = FakePeerConnection.instances.at(-1)!;
    expect(nextTalk.closed).toBe(false);
    expect(offers(handle)).toBe(2);
    scope.stop();
  });
});

describe('StreamConnection mse/stop', () => {
  function stops(handle: FakeWsHandle): number {
    return handle.sentMessages().filter((m) => m.type === 'mse/stop').length;
  }

  async function pictureWinsBeforeMseAnswer(handle: FakeWsHandle): Promise<FakePeerConnection> {
    handle.serverOpen();
    await settle();
    handle.serverText({ type: 'webrtc/answer', value: 'v=0' });
    const picture = FakePeerConnection.instances[0];
    picture.connect();
    await settle();
    return picture;
  }

  it('holds mse/stop until go2rtc answered the mse request', async () => {
    const { conn, ws, scope } = setup({ mode: 'auto' });
    await conn.start();
    const handle = ws.handles[0];
    await pictureWinsBeforeMseAnswer(handle);

    expect(conn.activeMode.value).toBe('webrtc');
    expect(stops(handle)).toBe(0);

    handle.serverText({ type: 'mse', value: H264_MIME });
    handle.serverBinary(initSegment());
    await settle();

    expect(stops(handle)).toBe(1);
    expect(handle.sentMessages().at(-1)).toEqual({ type: 'mse/stop' });
    scope.stop();
  });

  it('sends no mse/stop for an mse request go2rtc refused', async () => {
    const { conn, ws, scope } = setup({ mode: 'auto' });
    await conn.start();
    const handle = ws.handles[0];
    await pictureWinsBeforeMseAnswer(handle);

    handle.serverText({ type: 'error', value: 'mse: streams: codecs not matched' });
    await settle();

    expect(stops(handle)).toBe(0);
    expect(conn.status.value).toBe('connected');
    scope.stop();
  });

  it('stops the earlier fMP4 consumer before it asks for a new one', async () => {
    const { conn, ws, scope } = setup({ mode: 'auto' });
    await conn.start();
    const handle = ws.handles[0];
    const picture = await pictureWinsBeforeMseAnswer(handle);

    picture.setState('failed');
    await settle();

    const types = handle.sentMessages().map((m) => m.type);
    expect(types.filter((t) => t === 'mse')).toHaveLength(2);
    expect(types.lastIndexOf('mse/stop')).toBeLessThan(types.lastIndexOf('mse'));
    expect(types.lastIndexOf('mse/stop')).toBeGreaterThan(types.indexOf('mse'));

    handle.serverText({ type: 'mse', value: H264_MIME });
    handle.serverText({ type: 'mse', value: H264_MIME });
    await settle();
    expect(stops(handle)).toBe(1);
    scope.stop();
  });
});

describe('StreamConnection probe', () => {
  const H265_PROBE: ProbeStream = { video: [{ direction: 'sendonly', codec: 'H265' }], audio: [] } as unknown as ProbeStream;

  function sentTypes(handle: FakeWsHandle): string[] {
    return handle
      .sentMessages()
      .map((m) => m.type)
      .sort();
  }

  function pending<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  }

  it('dials the go2rtc socket while the probe is still out and asks for the stream once it answered', async () => {
    const { conn, ws, probeStream, scope } = setup({ mode: 'mse' });
    const probe = pending<ProbeStream>();
    probeStream.mockReturnValueOnce(probe.promise);

    const starting = conn.start();
    await settle();
    expect(ws.handles).toHaveLength(1);
    ws.handles[0].serverOpen();
    await settle();
    expect(ws.handles[0].sent).toHaveLength(0);

    probe.resolve(PROBE);
    await starting;
    await settle();
    expect(ws.handles[0].sentMessages()[0]?.type).toBe('mse');
    scope.stop();
  });

  it('starts the same source again without asking the server', async () => {
    const { conn, ws, probeStream, scope } = setup({ mode: 'auto', probe: PROBE_WITH_TALK });
    await conn.start();
    conn.stop();

    await conn.start();
    ws.handles[1].serverOpen();
    await settle();

    expect(probeStream).toHaveBeenCalledTimes(1);
    expect(conn.hasBackchannel.value).toBe(true);
    expect(sentTypes(ws.handles[1])).toEqual(['mse', 'webrtc/offer']);
    scope.stop();
  });

  it('asks the server again once the probe was invalidated', async () => {
    const { conn, probeStream, scope } = setup();
    await conn.start();
    conn.stop();

    conn.invalidateProbe();
    await conn.start();

    expect(probeStream).toHaveBeenCalledTimes(2);
    scope.stop();
  });

  it('does not keep the answer of a probe asked before it was invalidated', async () => {
    const { conn, probeStream, scope } = setup();
    const probe = pending<ProbeStream>();
    probeStream.mockReturnValueOnce(probe.promise);
    const starting = conn.start();
    await settle();

    conn.invalidateProbe();
    probe.resolve(PROBE);
    await starting;
    conn.stop();
    await conn.start();

    expect(probeStream).toHaveBeenCalledTimes(2);
    scope.stop();
  });

  it('asks the server again for another source', async () => {
    const { conn, probeStream, scope } = setup({
      sources: [H264_SOURCE, { _id: 'sub', name: 'sub', role: 'low-resolution', videoCodec: 'H264' } as CameraSource],
    });
    await conn.start();
    conn.stop();

    await conn.setResolution('low-resolution');
    await conn.start();

    expect(probeStream).toHaveBeenCalledTimes(2);
    expect(probeStream).toHaveBeenLastCalledWith('sub', expect.anything());
    scope.stop();
  });

  it('asks for the stream without the probe once it took too long, and does not probe twice', async () => {
    const { conn, ws, probeStream, scope } = setup({ mode: 'auto' });
    probeStream.mockReturnValue(new Promise(() => {}));

    conn.start();
    await settle();
    ws.handles[0].serverOpen();
    await settle();
    expect(ws.handles[0].sent).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(2_000);

    expect(sentTypes(ws.handles[0])).toEqual(['mse', 'webrtc/offer']);
    expect(probeStream).toHaveBeenCalledTimes(1);
    scope.stop();
  });

  it('moves the socket to the next source when the probe rules out the one it dialed', async () => {
    const { conn, ws, probeStream, scope } = setup({
      mode: 'webrtc',
      sources: [
        { _id: 'hevc', name: 'main', role: 'high-resolution' } as CameraSource,
        { _id: 'avc', name: 'sub', role: 'low-resolution', videoCodec: 'H264' } as CameraSource,
      ],
    });
    probeStream.mockResolvedValueOnce(H265_PROBE);

    await conn.start();
    const live = ws.handles.filter((h) => !h.disposed);
    live[0]?.serverOpen();
    await settle();

    expect(live).toHaveLength(1);
    expect(live[0].spec.query?.src).toBe('Garage_sub');
    expect(ws.handles.every((h) => h.disposed || h === live[0])).toBe(true);
    expect(ws.handles.filter((h) => h.disposed).every((h) => h.sent.length === 0)).toBe(true);
    scope.stop();
  });

  it('closes the socket it dialed when the probe rules out the only source', async () => {
    const { conn, ws, scope } = setup({ mode: 'webrtc', sources: [{ _id: 'hevc', name: 'main', role: 'high-resolution' } as CameraSource], probe: H265_PROBE });

    await conn.start();

    expect(conn.status.value).toBe('unsupported');
    expect(ws.handles).toHaveLength(1);
    expect(ws.handles[0].disposed).toBe(true);
    scope.stop();
  });

  it('closes the socket it dialed when the camera lost its sources during the probe', async () => {
    const { conn, ws, camera, probeStream, scope } = setup();
    const probe = pending<ProbeStream>();
    probeStream.mockReturnValueOnce(probe.promise);

    const starting = conn.start();
    await settle();
    (camera.sources as unknown as { value: CameraSource[] }).value = [];
    probe.resolve(PROBE);
    await starting;

    expect(conn.status.value).toBe('error');
    expect(ws.handles[0].disposed).toBe(true);
    scope.stop();
  });

  it('moves the socket to the source picked during a probe that failed', async () => {
    const { conn, ws, probeStream, scope } = setup({
      sources: [H264_SOURCE, { _id: 'sub', name: 'sub', role: 'low-resolution', videoCodec: 'H264' } as CameraSource],
    });
    let fail!: () => void;
    probeStream.mockReturnValueOnce(new Promise((_resolve, reject) => (fail = () => reject(new Error('boom')))));

    const starting = conn.start();
    await settle();
    await conn.setResolution('low-resolution');
    fail();
    await starting;

    expect(ws.handles).toHaveLength(2);
    expect(ws.handles[0].disposed).toBe(true);
    expect(ws.handles[1].spec.query?.src).toBe('Garage_sub');
    scope.stop();
  });

  it('asks the server again on a reconnect when the last probe failed', async () => {
    const { conn, ws, probeStream, scope } = setup({ probe: PROBE_WITH_TALK });
    probeStream.mockRejectedValueOnce(new Error('boom'));
    await conn.start();
    expect(conn.hasBackchannel.value).toBe(false);

    ws.handles[0].serverClose(1006);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(ws.handles.length).toBeGreaterThan(1);
    expect(probeStream).toHaveBeenCalledTimes(2);
    expect(conn.hasBackchannel.value).toBe(true);
    scope.stop();
  });

  it('lets reconnects wait on the probe that is still out instead of asking again', async () => {
    const { conn, ws, probeStream, scope } = setup();
    const probe = pending<ProbeStream>();
    probeStream.mockReturnValueOnce(probe.promise);
    conn.start();
    await vi.advanceTimersByTimeAsync(2_000);

    ws.handles[0].serverClose(1006);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ws.handles.length).toBeGreaterThan(1);
    expect(probeStream).toHaveBeenCalledTimes(1);

    probe.resolve(PROBE_WITH_TALK);
    await settle();
    expect(conn.hasBackchannel.value).toBe(true);
    scope.stop();
  });

  it('asks the server again for an H.265 source after it failed to decode', async () => {
    const { conn, ws, video, probeStream, scope } = setup({ sources: [{ _id: 'hevc', name: 'main', role: 'high-resolution', videoCodec: 'H265' } as CameraSource] });
    await conn.start();
    await negotiate(ws.handles[0], H265_MIME);
    video.readyState = 1;
    video.fail(3, 'PIPELINE_ERROR_DECODE');
    await vi.advanceTimersByTimeAsync(1000);
    conn.stop();

    await conn.start();

    expect(probeStream).toHaveBeenCalledTimes(2);
    scope.stop();
  });

  it('drops the talk button of a source that would not decode for the next source', async () => {
    const { conn, ws, video, probeStream, scope } = setup({
      probe: PROBE_WITH_TALK,
      sources: [
        { _id: 'hevc', name: 'main', role: 'high-resolution', videoCodec: 'H265' } as CameraSource,
        { _id: 'avc', name: 'sub', role: 'low-resolution', videoCodec: 'H264' } as CameraSource,
      ],
    });
    await conn.start();
    expect(conn.hasBackchannel.value).toBe(true);
    probeStream.mockRejectedValueOnce(new Error('boom'));

    await negotiate(ws.handles[0], H265_MIME);
    video.readyState = 1;
    video.fail(3, 'PIPELINE_ERROR_DECODE');
    await vi.advanceTimersByTimeAsync(1000);

    expect(ws.handles[1].spec.query?.src).toBe('Garage_sub');
    expect(conn.hasBackchannel.value).toBe(false);
    scope.stop();
  });
});

describe('StreamConnection MJPEG', () => {
  const JPEG_SOURCE = { _id: 'main', name: 'main', role: 'high-resolution', videoCodec: 'JPEG' } as CameraSource;
  const JPEG_PROBE = { video: [{ direction: 'sendonly', codec: 'JPEG' }], audio: [] } as unknown as ProbeStream;
  const JPEG_PCMA_PROBE = {
    video: [{ direction: 'sendonly', codec: 'JPEG' }],
    audio: [{ direction: 'sendonly', codec: 'PCMA' }],
  } as unknown as ProbeStream;
  const AAC_MIME = 'video/mp4; codecs="mp4a.40.2"';
  const AUDIO_TRACK = { id: 1, kind: 'audio', timescale: 48_000 } as const;

  let canvases: FakeCanvas[];
  let audios: FakeVideo[];
  let decoder: FakeImageDecoder;

  beforeEach(() => {
    canvases = [];
    audios = [];
    decoder = new FakeImageDecoder();
    vi.stubGlobal('HTMLCanvasElement', FakeCanvas);
    vi.stubGlobal('createImageBitmap', decoder.createImageBitmap);
    vi.stubGlobal('document', {
      createElement: (tag: string) => {
        if (tag === 'canvas') {
          canvases.push(new FakeCanvas());
          return canvases.at(-1);
        }
        audios.push(new FakeVideo());
        return audios.at(-1);
      },
    });
  });

  async function openMjpeg(handle: FakeWsHandle): Promise<void> {
    handle.serverOpen();
    await settle();
    handle.serverText({ type: 'mjpeg' });
  }

  it.each(['auto', 'webrtc', 'mse'] as const)('plays a JPEG source as MJPEG in %s mode', async (mode) => {
    const { conn, ws, video, scope } = setup({ mode, sources: [JPEG_SOURCE], probe: JPEG_PROBE });
    await conn.start();
    const handle = ws.handles[0];

    await openMjpeg(handle);
    handle.serverBinary(jpegFrame(1));
    await settle();
    video.presentFrame();

    expect(handle.sentMessages()).toEqual([{ type: 'mjpeg' }]);
    expect(FakePeerConnection.instances).toHaveLength(0);
    expect(video.srcObject).toBe(canvases[0].stream);
    expect(canvases[0].drawn).toEqual([1]);
    expect([canvases[0].width, canvases[0].height]).toEqual([640, 480]);
    expect(conn.activeMode.value).toBe('mjpeg');
    expect(conn.status.value).toBe('connected');
    expect(conn.isPlaying.value).toBe(true);
    scope.stop();
  });

  it('goes by the probe when the source has no codec yet', async () => {
    const { conn, ws, scope } = setup({ mode: 'auto', sources: [{ ...JPEG_SOURCE, videoCodec: undefined } as CameraSource], probe: JPEG_PROBE });
    await conn.start();

    await openMjpeg(ws.handles[0]);

    expect(ws.handles[0].sentMessages()).toEqual([{ type: 'mjpeg' }]);
    scope.stop();
  });

  it('draws only the newest of the frames that arrived during a decode', async () => {
    const { conn, ws, scope } = setup({ sources: [JPEG_SOURCE], probe: JPEG_PROBE });
    await conn.start();
    const handle = ws.handles[0];
    await openMjpeg(handle);

    decoder.hold();
    for (const id of [1, 2, 3, 4]) handle.serverBinary(jpegFrame(id));
    await settle();
    decoder.release();
    await settle();

    expect(canvases[0].drawn).toEqual([1, 4]);
    expect(decoder.calls).toBe(2);
    scope.stop();
  });

  it('plays the sound over MSE next to the picture and asks for audio codecs only', async () => {
    const { conn, ws, scope } = setup({ sources: [JPEG_SOURCE], probe: JPEG_PCMA_PROBE });
    await conn.start();
    const handle = ws.handles[0];
    await openMjpeg(handle);

    handle.serverText({ type: 'mse', value: AAC_MIME });
    handle.serverBinary(initSegment([AUDIO_TRACK]));
    handle.serverBinary(jpegFrame(1));
    handle.serverBinary(fragment({ dts: 0, trackId: 1, kind: 'audio', timescale: 48_000, samples: [{ duration: 1024, key: true }] }));
    await settle();

    expect(handle.sentMessages()).toEqual([{ type: 'mjpeg' }, { type: 'mse', value: 'mp4a.40.2,mp4a.40.5,flac,opus' }]);
    expect(canvases[0].drawn).toEqual([1]);
    expect(audios[0].sourceBuffer?.appendCalls).toBe(2);
    expect(audios[0].paused).toBe(false);
    expect(audios[0].muted).toBe(true);

    conn.setMuted(false);
    expect(audios[0].muted).toBe(false);
    conn.pause();
    expect(audios[0].paused).toBe(true);
    scope.stop();
  });

  it('keeps the picture when go2rtc refuses the sound', async () => {
    const { conn, ws, video, scope } = setup({ sources: [JPEG_SOURCE], probe: JPEG_PCMA_PROBE });
    await conn.start();
    const handle = ws.handles[0];
    await openMjpeg(handle);

    handle.serverText({ type: 'error', value: 'mse: streams: codecs not matched' });
    handle.serverBinary(jpegFrame(1));
    await settle();
    video.presentFrame();

    expect(audios[0].src).toBe('');
    expect(handle.sentMessages()).not.toContainEqual({ type: 'mse/stop' });
    expect(handle.disposed).toBe(false);
    expect(canvases[0].drawn).toEqual([1]);
    expect(conn.isPlaying.value).toBe(true);
    scope.stop();
  });

  it('reconnects an MJPEG stream whose frames stopped', async () => {
    const { conn, ws, video, scope } = setup({ sources: [JPEG_SOURCE], probe: JPEG_PROBE });
    await conn.start();
    const handle = ws.handles[0];
    await openMjpeg(handle);
    handle.serverBinary(jpegFrame(1));
    await settle();
    video.presentFrame();

    for (let i = 2; i < 6; i++) {
      handle.serverBinary(jpegFrame(i));
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(conn.stalled.value).toBe(false);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(handle.disposed).toBe(true);
    expect(canvases[0].track.readyState).toBe('ended');
    await expectNextSocketAt(ws, 1000);
    scope.stop();
  });

  it('retries a stream whose first MJPEG frame never shows instead of falling back to MSE', async () => {
    const { conn, ws, scope } = setup({ mode: 'auto', sources: [JPEG_SOURCE], probe: JPEG_PROBE });
    await conn.start();
    await openMjpeg(ws.handles[0]);

    await vi.advanceTimersByTimeAsync(STREAM_CONFIG.WEBRTC.CONNECT_TIMEOUT);

    expect(ws.handles[0].disposed).toBe(true);
    expect(ws.handles[0].sentMessages()).toEqual([{ type: 'mjpeg' }]);
    scope.stop();
  });

  it('reports a JPEG source as unsupported where the browser cannot draw it into a stream', async () => {
    vi.stubGlobal('HTMLCanvasElement', undefined);
    const { conn, ws, scope } = setup({ sources: [JPEG_SOURCE], probe: JPEG_PROBE });
    await conn.start();

    expect(conn.status.value).toBe('unsupported');
    expect(ws.handles).toHaveLength(0);
    scope.stop();
  });
});
