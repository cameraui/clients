import { vi } from 'vitest';

export const VIDEO_TIMESCALE = 90_000;
export const H264_MIME = 'video/mp4; codecs="avc1.640029"';
export const H265_MIME = 'video/mp4; codecs="hvc1.1.6.L153.B0"';

const SYNC_SAMPLE = 0x02000000;
const NON_SYNC_SAMPLE = 0x01010000;
// mdat payload per sample, read back by FakeSourceBuffer: f64 pts, f64 duration, u8 key, u8 video
const RECORD_SIZE = 18;

const encoder = new TextEncoder();

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function u8(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

function u16(value: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value);
  return out;
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0);
  return out;
}

function i32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, value);
  return out;
}

function u64(value: number): Uint8Array {
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setUint32(0, Math.floor(value / 2 ** 32));
  view.setUint32(4, value >>> 0);
  return out;
}

function zeros(n: number): Uint8Array {
  return new Uint8Array(n);
}

function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const body = concat(parts);
  return concat([u32(8 + body.byteLength), encoder.encode(type), body]);
}

function fullBox(type: string, version: number, flags: number, ...parts: Uint8Array[]): Uint8Array {
  return box(type, u8(version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff), ...parts);
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function joinMessages(...messages: ArrayBuffer[]): ArrayBuffer {
  return toArrayBuffer(concat(messages.map((m) => new Uint8Array(m))));
}

export interface TrackSpec {
  id: number;
  kind: 'video' | 'audio';
  timescale: number;
  version?: 0 | 1;
  trexDuration?: number;
  trexFlags?: number;
}

export function initSegment(tracks: TrackSpec[] = [{ id: 1, kind: 'video', timescale: VIDEO_TIMESCALE }]): ArrayBuffer {
  const traks = tracks.map((track) => {
    const v1 = track.version === 1;
    const tkhd = fullBox('tkhd', v1 ? 1 : 0, 3, zeros(v1 ? 16 : 8), u32(track.id), zeros(v1 ? 72 : 68));
    const mdhd = fullBox('mdhd', v1 ? 1 : 0, 0, zeros(v1 ? 16 : 8), u32(track.timescale), zeros(v1 ? 8 : 4), u16(0x55c4), u16(0));
    const hdlr = fullBox('hdlr', 0, 0, zeros(4), encoder.encode(track.kind === 'video' ? 'vide' : 'soun'), zeros(12), encoder.encode('handler'), u8(0));
    return box('trak', tkhd, box('mdia', mdhd, hdlr, box('minf')));
  });
  const trex = tracks.map((track) => fullBox('trex', 0, 0, u32(track.id), u32(1), u32(track.trexDuration ?? 0), u32(0), u32(track.trexFlags ?? 0)));
  const moov = box('moov', fullBox('mvhd', 0, 0, zeros(96)), ...traks, box('mvex', ...trex));
  return toArrayBuffer(concat([box('ftyp', encoder.encode('isom'), u32(512), encoder.encode('isom')), moov]));
}

export interface SampleSpec {
  duration: number;
  key: boolean;
  cts?: number;
}

// tfhd-defaults is what go2rtc writes: one sample, duration and flags in tfhd
export type FragmentLayout = 'tfhd-defaults' | 'first-sample-flags' | 'per-sample' | 'trex-defaults';

export interface FragmentSpec {
  dts: number;
  samples: SampleSpec[];
  trackId?: number;
  kind?: 'video' | 'audio';
  timescale?: number;
  layout?: FragmentLayout;
  tfdtVersion?: 0 | 1;
}

export function fragment(spec: FragmentSpec): ArrayBuffer {
  const { dts, samples, trackId = 1, kind = 'video', timescale = VIDEO_TIMESCALE, layout = 'tfhd-defaults', tfdtVersion = 1 } = spec;
  function flagsOf(sample: SampleSpec): number {
    return sample.key ? SYNC_SAMPLE : NON_SYNC_SAMPLE;
  }
  const hasCts = samples.some((s) => s.cts !== undefined);
  const first = samples[0];

  let tfhdFlags = 0x020000;
  const tfhdFields = [u32(trackId)];
  let trunFlags = 0x000001;
  const trunHead: Uint8Array[] = [];

  if (layout === 'tfhd-defaults') {
    tfhdFlags |= 0x08 | 0x10 | 0x20;
    tfhdFields.push(u32(first.duration), u32(RECORD_SIZE), u32(flagsOf(first)));
  } else if (layout === 'first-sample-flags') {
    tfhdFlags |= 0x08 | 0x20;
    tfhdFields.push(u32(first.duration), u32(NON_SYNC_SAMPLE));
    trunFlags |= 0x004;
    trunHead.push(u32(flagsOf(first)));
  } else if (layout === 'per-sample') {
    trunFlags |= 0x100 | 0x200 | 0x400;
  }
  if (hasCts) trunFlags |= 0x800;

  const perSample: Uint8Array[] = [];
  const records: Uint8Array[] = [];
  let time = dts;
  for (const sample of samples) {
    if (layout === 'per-sample') perSample.push(u32(sample.duration), u32(RECORD_SIZE), u32(flagsOf(sample)));
    if (hasCts) perSample.push(i32(sample.cts ?? 0));

    const record = new Uint8Array(RECORD_SIZE);
    const view = new DataView(record.buffer);
    view.setFloat64(0, (time + (sample.cts ?? 0)) / timescale);
    view.setFloat64(8, sample.duration / timescale);
    view.setUint8(16, sample.key || kind === 'audio' ? 1 : 0);
    view.setUint8(17, kind === 'video' ? 1 : 0);
    records.push(record);
    time += sample.duration;
  }

  const tfdt = tfdtVersion === 1 ? fullBox('tfdt', 1, 0, u64(dts)) : fullBox('tfdt', 0, 0, u32(dts));
  const trun = fullBox('trun', hasCts ? 1 : 0, trunFlags, u32(samples.length), u32(0), ...trunHead, ...perSample);
  const moof = box('moof', fullBox('mfhd', 0, 0, u32(1)), box('traf', fullBox('tfhd', 0, tfhdFlags, ...tfhdFields), tfdt, trun));
  return toArrayBuffer(concat([moof, box('mdat', ...records)]));
}

export function videoFrame(index: number, gopSeconds: number, fps = 25): ArrayBuffer {
  const duration = VIDEO_TIMESCALE / fps;
  return fragment({ dts: index * duration, samples: [{ duration, key: index % Math.round(gopSeconds * fps) === 0 }] });
}

export interface FakeFrame {
  pts: number;
  dur: number;
  key: boolean;
  video: boolean;
  gop: number;
}

type Listener = (event: Event) => void;

class Emitter {
  private listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener, options?: { once?: boolean }): void {
    const set = this.listeners.get(type) ?? new Set();
    this.listeners.set(type, set);
    if (options?.once) {
      const wrapped: Listener = (event) => {
        set.delete(wrapped);
        listener(event);
      };
      set.add(wrapped);
    } else {
      set.add(listener);
    }
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  emit(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(new Event(type));
    }
  }
}

function ranges(list: [number, number][]): TimeRanges {
  return {
    length: list.length,
    start: (i: number) => list[i][0],
    end: (i: number) => list[i][1],
  };
}

const EMPTY_RANGES = ranges([]);

// coded frame removal per the MSE spec: removing a keyframe also drops every frame that depends on it
export class FakeSourceBuffer extends Emitter {
  mode = 'sequence';
  updating = false;
  frames: FakeFrame[] = [];
  appendCalls = 0;
  removes: [number, number][] = [];
  throwOnce: Error | undefined;
  throwAlways: Error | undefined;

  private lastKey: number | undefined;
  private cachedRanges: TimeRanges | undefined;

  get buffered(): TimeRanges {
    if (this.cachedRanges) return this.cachedRanges;
    const list: [number, number][] = [];
    for (const frame of this.frames) {
      const last = list.at(-1);
      if (last && frame.pts <= last[1] + 0.001) {
        last[1] = Math.max(last[1], frame.pts + frame.dur);
      } else {
        list.push([frame.pts, frame.pts + frame.dur]);
      }
    }
    this.cachedRanges = ranges(list);
    return this.cachedRanges;
  }

  appendBuffer(data: BufferSource): void {
    this.appendCalls++;
    if (this.updating) throw new DOMException('still updating', 'InvalidStateError');
    const error = this.throwOnce ?? this.throwAlways;
    this.throwOnce = undefined;
    if (error) throw error;

    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data.slice(0)) : new Uint8Array((data as Uint8Array).slice());
    this.updating = true;
    queueMicrotask(() => {
      this.ingest(bytes);
      this.updating = false;
      this.emit('updateend');
    });
  }

  remove(start: number, end: number): void {
    if (this.updating) throw new DOMException('still updating', 'InvalidStateError');
    this.removes.push([start, end]);
    this.updating = true;
    queueMicrotask(() => {
      const kept = this.frames.filter((f) => f.pts < start || f.pts >= end);
      const keys = new Set(kept.filter((f) => f.key).map((f) => f.pts));
      this.frames = kept.filter((f) => f.key || keys.has(f.gop));
      this.cachedRanges = undefined;
      this.updating = false;
      this.emit('updateend');
    });
  }

  frameAt(time: number): FakeFrame | undefined {
    return this.frames.find((f) => f.pts - 1e-9 <= time && time < f.pts + f.dur - 1e-9);
  }

  private ingest(bytes: Uint8Array): void {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let offset = 0; offset + 8 <= bytes.byteLength;) {
      const size = view.getUint32(offset);
      if (size < 8) return;
      if (String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)) === 'mdat') {
        for (let p = offset + 8; p + RECORD_SIZE <= offset + size; p += RECORD_SIZE) {
          this.add(view.getFloat64(p), view.getFloat64(p + 8), view.getUint8(p + 16) === 1, view.getUint8(p + 17) === 1);
        }
      }
      offset += size;
    }
  }

  private add(pts: number, dur: number, key: boolean, video: boolean): void {
    if (key) this.lastKey = pts;
    const gop = key ? pts : this.lastKey;
    // a frame whose keyframe is gone cannot be decoded, browsers drop it until the next keyframe
    if (gop === undefined || (!key && !this.frames.some((f) => f.key && f.pts === gop))) return;
    this.frames = this.frames.filter((f) => Math.abs(f.pts - pts) > 1e-9);
    const index = this.frames.findIndex((f) => f.pts > pts);
    this.frames.splice(index === -1 ? this.frames.length : index, 0, { pts, dur, key, video, gop });
    this.cachedRanges = undefined;
  }
}

export class FakeMediaSource extends Emitter {
  static isTypeSupported = vi.fn((_mime: string) => true);
  static nextAddSourceBufferError: Error | undefined;

  readyState: 'closed' | 'open' | 'ended' = 'open';
  sourceBuffers: FakeSourceBuffer[] = [];
  liveSeekableRange: [number, number] | undefined;

  addSourceBuffer(_mime: string): FakeSourceBuffer {
    const error = FakeMediaSource.nextAddSourceBufferError;
    FakeMediaSource.nextAddSourceBufferError = undefined;
    if (error) throw error;
    const sourceBuffer = new FakeSourceBuffer();
    this.sourceBuffers.push(sourceBuffer);
    return sourceBuffer;
  }

  removeSourceBuffer(_sourceBuffer: FakeSourceBuffer): void {}

  endOfStream(): void {
    this.readyState = 'ended';
  }

  setLiveSeekableRange(start: number, end: number): void {
    this.liveSeekableRange = [start, end];
  }
}

const objectUrls = new Map<string, FakeMediaSource>();
let objectUrlSeq = 0;

// plays through decodable frames only, a playhead on a missing frame stalls like a real element
export class FakeVideo extends Emitter {
  currentTime = 0;
  playbackRate = 1;
  readyState = 0;
  error: { code: number; message: string } | null = null;
  muted = true;
  paused = true;
  videoWidth = 0;
  videoHeight = 0;
  disableRemotePlayback = false;
  style: Record<string, string> = {};
  shown = new Set<number>();
  decodedFrames = 0;
  mediaSource: FakeMediaSource | undefined;

  private source = '';
  private stream: unknown = null;
  private lastPresented: number | undefined;
  private frameCallbacks = new Map<number, () => void>();
  private frameCallbackSeq = 0;

  get src(): string {
    return this.source;
  }

  set src(url: string) {
    this.source = url;
    this.mediaSource = objectUrls.get(url);
    this.error = null;
    this.resetMedia();
  }

  get srcObject(): unknown {
    return this.stream;
  }

  set srcObject(stream: unknown) {
    this.stream = stream;
    this.resetMedia();
  }

  get sourceBuffer(): FakeSourceBuffer | undefined {
    return this.mediaSource?.sourceBuffers[0];
  }

  get buffered(): TimeRanges {
    return this.sourceBuffer?.buffered ?? EMPTY_RANGES;
  }

  play(): Promise<void> {
    this.paused = false;
    return Promise.resolve();
  }

  pause(): void {
    this.paused = true;
  }

  load(): void {
    this.currentTime = 0;
    this.error = null;
    this.resetMedia();
  }

  removeAttribute(name: string): void {
    if (name === 'src') {
      this.source = '';
      this.mediaSource = undefined;
    }
  }

  fail(code: number, message: string): void {
    this.error = { code, message };
    this.emit('error');
  }

  requestVideoFrameCallback(callback: () => void): number {
    const id = ++this.frameCallbackSeq;
    this.frameCallbacks.set(id, callback);
    return id;
  }

  cancelVideoFrameCallback(id: number): void {
    this.frameCallbacks.delete(id);
  }

  getVideoPlaybackQuality(): { totalVideoFrames: number } {
    return { totalVideoFrames: this.decodedFrames };
  }

  // a decoded frame reaches the screen: counters, readyState and frame callbacks move like in a browser
  presentFrame(): void {
    this.decodedFrames++;
    if (this.readyState < 2) {
      this.readyState = 2;
      this.emit('loadeddata');
    }
    const callbacks = [...this.frameCallbacks.values()];
    this.frameCallbacks.clear();
    for (const callback of callbacks) callback();
  }

  advance(ms: number): void {
    const sourceBuffer = this.sourceBuffer;
    if (!sourceBuffer) return;
    let budget = (ms / 1000) * this.playbackRate;
    while (budget > 1e-9) {
      const frame = sourceBuffer.frameAt(this.currentTime);
      if (!frame) return;
      this.shown.add(Math.round(frame.pts * 1000));
      if (this.lastPresented !== frame.pts) {
        this.lastPresented = frame.pts;
        this.presentFrame();
      }
      const step = Math.min(budget, frame.pts + frame.dur - this.currentTime);
      this.currentTime += step;
      budget -= step;
    }
  }

  private resetMedia(): void {
    this.readyState = 0;
    this.decodedFrames = 0;
    this.lastPresented = undefined;
  }
}

export function installMediaGlobals(): void {
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('MediaSource', FakeMediaSource);
  vi.spyOn(URL, 'createObjectURL').mockImplementation((object: unknown) => {
    const url = `blob:fake/${++objectUrlSeq}`;
    objectUrls.set(url, object as FakeMediaSource);
    return url;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => {
    objectUrls.delete(url);
  });
  FakeMediaSource.isTypeSupported.mockImplementation(() => true);
  FakeMediaSource.nextAddSourceBufferError = undefined;
}

export function restoreMediaGlobals(): void {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  objectUrls.clear();
}

export async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

type WsListener = (payload?: unknown) => void;

export class FakeWsHandle {
  readyState = 0;
  url: string | null = null;
  sent: string[] = [];
  disposed = false;

  private listeners = new Map<string, Set<WsListener>>();

  constructor(public readonly spec: { path: string; query?: Record<string, string> }) {}

  on(event: string, listener: WsListener): () => void {
    const set = this.listeners.get(event) ?? new Set();
    this.listeners.set(event, set);
    set.add(listener);
    return () => set.delete(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.dispose();
  }

  dispose(): void {
    this.disposed = true;
    this.readyState = 3;
    this.listeners.clear();
  }

  serverOpen(): void {
    this.readyState = 1;
    this.emit('open');
  }

  serverClose(code: number, reason = ''): void {
    this.readyState = 3;
    this.emit('close', { code, reason, wasClean: false });
  }

  serverText(message: object): void {
    this.emit('message', { data: JSON.stringify(message) });
  }

  serverBinary(data: ArrayBuffer): void {
    this.emit('message', { data });
  }

  sentMessages(): { type: string; value?: unknown }[] {
    return this.sent.map((s) => JSON.parse(s));
  }

  private emit(event: string, payload?: unknown): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(payload);
  }
}

export class FakeWsTransport {
  handles: FakeWsHandle[] = [];
  // the real transport reports CLOSED while its resolveUrl hook is still pending
  hangResolve = false;

  get handleCount(): number {
    return this.handles.filter((h) => !h.disposed).length;
  }

  open(spec: { path: string; query?: Record<string, string> }): FakeWsHandle {
    const handle = new FakeWsHandle(spec);
    if (this.hangResolve) handle.readyState = 3;
    this.handles.push(handle);
    return handle;
  }
}

export interface FakeTrack {
  kind: 'video' | 'audio';
  readyState: 'live' | 'ended';
  stop?: () => void;
}

export class FakeMediaStream {
  constructor(private readonly trackList: FakeTrack[] = []) {}

  get active(): boolean {
    return this.trackList.some((t) => t.readyState === 'live');
  }

  getTracks(): FakeTrack[] {
    return this.trackList;
  }

  getVideoTracks(): FakeTrack[] {
    return this.trackList.filter((t) => t.kind === 'video');
  }

  getAudioTracks(): FakeTrack[] {
    return this.trackList.filter((t) => t.kind === 'audio');
  }
}

// SOI, frame id, size, EOI: enough for FakeImageDecoder to tell frames apart
export function jpegFrame(id: number, width = 640, height = 480): ArrayBuffer {
  const bytes = new Uint8Array(10);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 0xffd8);
  view.setUint16(2, id);
  view.setUint16(4, width);
  view.setUint16(6, height);
  view.setUint16(8, 0xffd9);
  return bytes.buffer;
}

export class FakeCanvas {
  width = 300;
  height = 150;
  drawn: number[] = [];

  readonly track: FakeTrack = {
    kind: 'video',
    readyState: 'live',
    stop: () => {
      this.track.readyState = 'ended';
    },
  };

  readonly stream = new FakeMediaStream([this.track]);

  getContext(): { drawImage: (bitmap: { id: number }) => void } {
    return { drawImage: (bitmap) => this.drawn.push(bitmap.id) };
  }

  captureStream(): FakeMediaStream {
    return this.stream;
  }
}

// a held decoder keeps its frame until release(), the frames behind it queue up in the handler
export class FakeImageDecoder {
  calls = 0;

  private waiting: (() => void)[] = [];
  private held = false;

  readonly createImageBitmap = vi.fn(async (blob: Blob) => {
    this.calls++;
    const view = new DataView(await blob.arrayBuffer());
    const bitmap = { id: view.getUint16(2), width: view.getUint16(4), height: view.getUint16(6), close: vi.fn() };
    if (this.held) await new Promise<void>((resolve) => this.waiting.push(resolve));
    return bitmap;
  });

  hold(): void {
    this.held = true;
  }

  release(): void {
    this.held = false;
    for (const resolve of this.waiting.splice(0)) resolve();
  }
}

export interface FakeTransceiver {
  kind: string;
  direction: string;
  sender: { track: unknown; replaceTrack: (track: unknown) => Promise<void> };
}

export class FakePeerConnection {
  static instances: FakePeerConnection[] = [];

  connectionState = 'new';
  onicecandidate: ((event: unknown) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  closed = false;
  transceivers: FakeTransceiver[] = [];
  remoteAnswer: string | undefined;
  remoteCandidates: string[] = [];

  private received: FakeTrack['kind'][] = [];

  constructor() {
    FakePeerConnection.instances.push(this);
  }

  addTransceiver(kind: string, init?: { direction?: string }): FakeTransceiver {
    const transceiver: FakeTransceiver = {
      kind,
      direction: init?.direction ?? 'sendrecv',
      sender: {
        track: null,
        replaceTrack: async (track: unknown) => {
          transceiver.sender.track = track;
        },
      },
    };
    this.transceivers.push(transceiver);
    return transceiver;
  }

  async createOffer(): Promise<{ type: string; sdp: string }> {
    return { type: 'offer', sdp: 'v=0' };
  }

  async setLocalDescription(): Promise<void> {}

  async setRemoteDescription(description: { sdp: string }): Promise<void> {
    this.remoteAnswer = description.sdp;
  }

  async addIceCandidate(init: { candidate: string }): Promise<void> {
    this.remoteCandidates.push(init.candidate);
  }

  emitCandidate(candidate: string, protocol: 'udp' | 'tcp' = 'udp'): void {
    this.onicecandidate?.({ candidate: { protocol, toJSON: () => ({ candidate }) } });
  }

  sendsTrack(track: unknown): boolean {
    return this.transceivers.some((t) => t.direction === 'sendonly' && t.sender.track === track);
  }

  getTransceivers(): unknown[] {
    return this.received.map((kind) => ({ currentDirection: 'recvonly', receiver: { track: { kind, readyState: 'live' } } }));
  }

  connect(kinds: FakeTrack['kind'][] = ['video', 'audio']): void {
    this.received = kinds;
    this.setState('connected');
  }

  setState(state: string): void {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }

  close(): void {
    this.closed = true;
  }
}
