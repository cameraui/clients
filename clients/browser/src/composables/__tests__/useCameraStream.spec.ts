import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, effectScope, nextTick, ref } from 'vue';

import { CAMERA_UI_INJECTION_KEY } from '../../plugin.js';
import * as connections from '../../streaming/streamConnection.js';
import { streamManager } from '../../streaming/streamManager.js';
import { useCameraStream } from '../useCameraStream.js';

import type { Mock } from 'vitest';
import type { Ref } from 'vue';
import type { CameraUiContext, ReactiveCameraDevice } from '../../types.js';
import type { UseCameraStreamOptions } from '../useCameraStream.js';

interface FakeStream {
  status: Ref<string>;
  isPlaying: Ref<boolean>;
  paused: Ref<boolean>;
  start: Mock;
  stop: Mock;
}

vi.mock('../useCameraById.js', async () => {
  const { computed, shallowRef } = await import('vue');
  return { useCameraById: () => ({ camera: shallowRef(undefined), isLoading: computed(() => false) }) };
});

vi.mock('../useFullscreen.js', async () => {
  const { ref } = await import('vue');
  return { useCuiFullscreen: () => ({ isFullscreen: ref(false), toggle: async () => {} }) };
});

vi.mock('../../streaming/streamConnection.js', async () => {
  const { ref } = await import('vue');
  const created: unknown[] = [];
  function createStreamConnection() {
    const stream = {
      status: ref('idle'),
      isPlaying: ref(false),
      stalled: ref(false),
      activeMode: ref('webrtc'),
      activeResolution: ref('high-resolution'),
      degradedFrom: ref(null),
      hasAudio: ref(false),
      hasBackchannel: ref(false),
      error: ref(undefined),
      muted: ref(true),
      paused: ref(false),
      nativeWidth: ref(0),
      nativeHeight: ref(0),
      start: vi.fn(async () => {
        stream.status.value = 'connected';
        stream.isPlaying.value = true;
      }),
      stop: vi.fn(() => {
        stream.status.value = 'closed';
        stream.isPlaying.value = false;
      }),
      restart: vi.fn(async () => {}),
      destroy: vi.fn(() => stream.stop()),
      setMuted: vi.fn(),
      setMode: vi.fn(async () => {}),
      setResolution: vi.fn(async () => {}),
      setMicrophone: vi.fn(async () => {}),
      play: vi.fn(async () => {}),
      pause: vi.fn(),
    };
    created.push(stream);
    return stream;
  }
  return { createStreamConnection, created };
});

const OFFSCREEN_STOP_MS = 10_000;
const EMPTY_POSTER_PREFIX = 'data:image/png;base64,';

type Listener = () => void;

class FakeElement {
  parentElement: FakeElement | null = null;
  children: FakeElement[] = [];
  style: Record<string, string> = {};
  isConnected = true;
  visible = true;
  width = 360;
  height = 200;
  private listeners = new Map<string, Set<Listener>>();

  get clientWidth(): number {
    return this.width;
  }

  appendChild(child: FakeElement): FakeElement {
    child.parentElement?.removeChild(child);
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  removeChild(child: FakeElement): FakeElement {
    this.children = this.children.filter((c) => c !== child);
    child.parentElement = null;
    return child;
  }

  checkVisibility(): boolean {
    return this.visible;
  }

  getBoundingClientRect(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set();
    this.listeners.set(type, set);
    set.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
  }
}

class FakeVideoElement extends FakeElement {
  autoplay = false;
  playsInline = false;
  muted = true;
  disablePictureInPicture = true;
  preload = '';
  poster = '';
  webkitPresentationMode = 'inline';
  readyState = 0;
  videoWidth = 0;
  videoHeight = 0;
  srcObject: unknown = null;

  play(): Promise<void> {
    return Promise.resolve();
  }

  pause(): void {}
}

class FakeCanvas {
  width = 0;
  height = 0;

  getContext(): { drawImage: () => void } {
    return { drawImage: () => {} };
  }

  toDataURL(type: string): string {
    return `data:${type};base64,frame${this.width}x${this.height}`;
  }
}

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly targets = new Set<unknown>();
  disconnected = false;

  constructor(
    private callback: (entries: { target: unknown; isIntersecting: boolean }[]) => void,
    public options?: { rootMargin?: string },
  ) {
    FakeIntersectionObserver.instances.push(this);
  }

  observe(target: unknown): void {
    this.targets.add(target);
  }

  unobserve(target: unknown): void {
    this.targets.delete(target);
  }

  disconnect(): void {
    this.disconnected = true;
    this.targets.clear();
  }

  fire(isIntersecting: boolean): void {
    this.callback([...this.targets].map((target) => ({ target, isIntersecting })));
  }
}

const device = { name: ref('Front'), disabled: ref(false) } as unknown as ReactiveCameraDevice;
const created = (connections as unknown as { created: FakeStream[] }).created;
const unmounts: (() => void)[] = [];

function observerOf(container: FakeElement): FakeIntersectionObserver {
  const observer = FakeIntersectionObserver.instances.findLast((o) => !o.disconnected && o.targets.has(container));
  if (!observer) throw new Error('container is not observed');
  return observer;
}

// the first observer report follows mounting, like in a browser
async function mountTile(options: Partial<UseCameraStreamOptions> & { visible?: boolean; connected?: Ref<boolean> } = {}) {
  const { visible = true, connected = ref(true), ...streamOptions } = options;
  const app = createApp({});
  app.provide(CAMERA_UI_INJECTION_KEY, { isConnected: connected, on: () => {}, off: () => {} } as unknown as CameraUiContext);
  const scope = effectScope();
  const tile = app.runWithContext(() => scope.run(() => useCameraStream({ camera: device, startDelay: 0, ...streamOptions }))!);
  const container = new FakeElement();
  tile.containerElement.value = container as unknown as HTMLElement;
  await nextTick();
  const stream = created.at(-1)!;
  const video = tile.videoElement.value as unknown as FakeVideoElement | undefined;
  if (video) {
    video.readyState = 2;
    video.videoWidth = 1280;
    video.videoHeight = 720;
  }
  unmounts.push(() => scope.stop());

  async function scroll(inView: boolean): Promise<void> {
    observerOf(container).fire(inView);
    await nextTick();
  }

  await scroll(visible);
  return { tile, container, stream, video: video!, scroll };
}

async function elapse(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal('document', {
    createElement: (tag: string) => (tag === 'canvas' ? new FakeCanvas() : new FakeVideoElement()),
    pictureInPictureEnabled: false,
    pictureInPictureElement: null,
  });
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
  vi.stubGlobal('MediaStream', class {});
});

afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount();
  streamManager.clear();
  created.length = 0;
  FakeIntersectionObserver.instances.length = 0;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useCameraStream offscreen tiles', () => {
  it('stops a tile about 10 s after it left the viewport, last frame as poster, and resumes it on return', async () => {
    const { stream, video, scroll } = await mountTile();
    expect(stream.status.value).toBe('connected');

    await scroll(false);
    await elapse(OFFSCREEN_STOP_MS - 100);
    expect(stream.stop).not.toHaveBeenCalled();

    await elapse(200);
    expect(stream.stop).toHaveBeenCalledOnce();
    expect(video.poster).toMatch(/^data:image\/jpeg;base64,frame360x/);

    const starts = stream.start.mock.calls.length;
    await scroll(true);
    await elapse(1000);
    expect(stream.start).toHaveBeenCalledTimes(starts + 1);
    expect(video.poster.startsWith(EMPTY_POSTER_PREFIX)).toBe(true);
  });

  it('observes with a margin of about one tile height', async () => {
    const { container } = await mountTile();

    expect(observerOf(container).options?.rootMargin).toBe('200px 0px');
  });

  it('does not connect a tile that has never been in view and starts it once it scrolls in', async () => {
    const { stream, scroll } = await mountTile({ startDelay: 100, visible: false });
    await elapse(OFFSCREEN_STOP_MS);
    expect(stream.start).not.toHaveBeenCalled();

    await scroll(true);
    await elapse(1000);

    expect(stream.start).toHaveBeenCalledOnce();
    expect(stream.status.value).toBe('connected');
  });

  it.each([false, true])('does not connect a tile whose connection arrives after it was reported out of view (isolated: %s)', async (isolated) => {
    const connected = ref(false);
    const { tile, stream, scroll } = await mountTile({ visible: false, connected, isolated });

    connected.value = true;
    await nextTick();
    await elapse(OFFSCREEN_STOP_MS);
    expect(tile.videoElement.value).toBeDefined();
    expect(stream.start).not.toHaveBeenCalled();

    await scroll(true);
    await elapse(1000);
    expect(stream.start).toHaveBeenCalledOnce();
  });

  it('stops right away a tile that connected before it was reported out of view', async () => {
    const { stream } = await mountTile({ visible: false });
    expect(stream.start).toHaveBeenCalled();

    await elapse(10);

    expect(stream.stop).toHaveBeenCalledOnce();
  });

  it('keeps a tile that comes back before the delay', async () => {
    const { stream, scroll } = await mountTile();

    await scroll(false);
    await elapse(OFFSCREEN_STOP_MS / 2);
    await scroll(true);
    await elapse(OFFSCREEN_STOP_MS * 2);

    expect(stream.stop).not.toHaveBeenCalled();
  });

  it('staggers the resume of tiles that return together', async () => {
    const tiles = [await mountTile(), await mountTile({ isolated: true }), await mountTile({ isolated: true })];
    for (const tile of tiles) await tile.scroll(false);
    await elapse(OFFSCREEN_STOP_MS + 100);
    const resumedAt: number[] = [];
    for (const { stream } of tiles) {
      stream.start.mockImplementation(async () => {
        resumedAt.push(Date.now());
        stream.status.value = 'connected';
      });
    }

    for (const tile of tiles) await tile.scroll(true);
    await elapse(5000);

    expect(resumedAt).toHaveLength(3);
    expect(Math.min(...resumedAt.slice(1).map((at, i) => at - resumedAt[i]))).toBeGreaterThanOrEqual(75);
  });

  it('never stops a tile in picture-in-picture, and stops it once it leaves while still offscreen', async () => {
    const { stream, video, scroll } = await mountTile();
    video.emit('enterpictureinpicture');

    await scroll(false);
    await elapse(OFFSCREEN_STOP_MS * 2);
    expect(stream.stop).not.toHaveBeenCalled();

    video.emit('leavepictureinpicture');
    await nextTick();
    await elapse(OFFSCREEN_STOP_MS + 100);
    expect(stream.stop).toHaveBeenCalledOnce();
  });

  it('leaves standby alone: no stop on top of it and no start when the tile returns', async () => {
    const { tile, stream, scroll } = await mountTile({ activityMode: 'standby', activityConfig: { standbyTimeout: 1000 } });
    await elapse(1500);
    expect(tile.inStandby.value).toBe(true);
    const stops = stream.stop.mock.calls.length;
    const starts = stream.start.mock.calls.length;

    await scroll(false);
    await elapse(OFFSCREEN_STOP_MS * 2);
    await scroll(true);
    await elapse(1000);

    expect(stream.stop).toHaveBeenCalledTimes(stops);
    expect(stream.start).toHaveBeenCalledTimes(starts);
    expect(tile.inStandby.value).toBe(true);
  });

  it('keeps a paused tile', async () => {
    const { stream, scroll } = await mountTile();
    stream.paused.value = true;

    await scroll(false);
    await elapse(OFFSCREEN_STOP_MS * 2);

    expect(stream.stop).not.toHaveBeenCalled();
  });

  it('keeps a shared stream while another consumer holds it and stops it once that one lets go', async () => {
    const { stream, video, scroll } = await mountTile();
    streamManager.acquire('Front');

    await scroll(false);
    await elapse(OFFSCREEN_STOP_MS * 2);
    expect(stream.stop).not.toHaveBeenCalled();
    expect(video.poster.startsWith(EMPTY_POSTER_PREFIX)).toBe(true);

    streamManager.release('Front');
    await elapse(OFFSCREEN_STOP_MS + 100);
    expect(stream.stop).toHaveBeenCalledOnce();
    expect(video.poster).toMatch(/^data:image\/jpeg;base64,/);
  });

  it('never stops a tile kept awake, and stops it after the delay once released while offscreen', async () => {
    const { tile, stream, scroll } = await mountTile();
    tile.setKeepAwake(true);

    await scroll(false);
    await elapse(OFFSCREEN_STOP_MS * 2);
    expect(stream.stop).not.toHaveBeenCalled();

    tile.setKeepAwake(false);
    await nextTick();
    await elapse(OFFSCREEN_STOP_MS - 100);
    expect(stream.stop).not.toHaveBeenCalled();
    await elapse(200);
    expect(stream.stop).toHaveBeenCalledOnce();
  });

  it('stops a failing camera offscreen instead of retrying forever, and starts it again on return', async () => {
    const { stream, scroll } = await mountTile();
    stream.status.value = 'error';
    await nextTick();

    await scroll(false);
    for (let i = 0; i < 10 && !stream.stop.mock.calls.length; i++) {
      await elapse(1500);
      if (!stream.stop.mock.calls.length) stream.status.value = stream.status.value === 'error' ? 'reconnecting' : 'error';
      await nextTick();
    }
    expect(stream.stop).toHaveBeenCalledOnce();
    expect(stream.status.value).toBe('closed');

    const starts = stream.start.mock.calls.length;
    await scroll(true);
    await elapse(1000);
    expect(stream.start).toHaveBeenCalledTimes(starts + 1);
  });

  it('never stops a tile in Safari picture-in-picture, and stops it once it leaves while still offscreen', async () => {
    const { tile, stream, video, scroll } = await mountTile();
    video.webkitPresentationMode = 'picture-in-picture';
    video.emit('webkitpresentationmodechanged');
    expect(tile.isPip.value).toBe(true);

    await scroll(false);
    await elapse(OFFSCREEN_STOP_MS * 2);
    expect(stream.stop).not.toHaveBeenCalled();

    video.webkitPresentationMode = 'inline';
    video.emit('webkitpresentationmodechanged');
    await nextTick();
    await elapse(OFFSCREEN_STOP_MS + 100);
    expect(stream.stop).toHaveBeenCalledOnce();
  });

  it('notices a shared video that was already in picture-in-picture when the delay ends', async () => {
    const { tile, stream, video, scroll } = await mountTile();
    video.webkitPresentationMode = 'picture-in-picture';

    await scroll(false);
    await elapse(OFFSCREEN_STOP_MS * 2);
    expect(stream.stop).not.toHaveBeenCalled();
    expect(tile.isPip.value).toBe(true);

    video.webkitPresentationMode = 'inline';
    video.emit('webkitpresentationmodechanged');
    await nextTick();
    await elapse(OFFSCREEN_STOP_MS + 100);
    expect(stream.stop).toHaveBeenCalledOnce();
  });

  it('does not resume a tile its owner no longer wants started', async () => {
    const autoStart = ref(true);
    const { stream, scroll } = await mountTile({ autoStart });

    await scroll(false);
    await elapse(OFFSCREEN_STOP_MS + 100);
    expect(stream.stop).toHaveBeenCalledOnce();
    autoStart.value = false;
    const starts = stream.start.mock.calls.length;

    await scroll(true);
    await elapse(1000);

    expect(stream.start).toHaveBeenCalledTimes(starts);
  });

  it('arms the delay again when a stream starts while its tile is offscreen', async () => {
    const { tile, stream, scroll } = await mountTile();
    await scroll(false);
    await elapse(OFFSCREEN_STOP_MS + 100);
    expect(stream.stop).toHaveBeenCalledOnce();

    await tile.start();
    await nextTick();
    await elapse(OFFSCREEN_STOP_MS + 100);

    expect(stream.stop).toHaveBeenCalledTimes(2);
  });
});
