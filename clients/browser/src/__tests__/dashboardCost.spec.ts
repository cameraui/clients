import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, effectScope, ref } from 'vue';

import { resetClientState } from '../composables/resetClientState.js';
import { useCameraById } from '../composables/useCameraById.js';
import { useSnapshot } from '../composables/useSnapshot.js';
import { CAMERA_UI_INJECTION_KEY, createCameraUiPlugin } from '../plugin.js';

import type { RPCClient } from '@camera.ui/rpc';
import type { NatsTransport } from '@camera.ui/transport/transports/nats';
import type { DBCamera } from '../server/index.js';
import type { CameraUiContext } from '../types.js';

type Handler = (msg: unknown) => void;

interface ServerOptions {
  // answers an unchanged snapshot without its bytes and names the cameras of a reconnected sensor
  current: boolean;
  rttMs: number;
}

interface Cost {
  getCamera: number;
  refreshStates: number;
  snapshotWithMeta: number;
  subCamera: number;
  subSensors: number;
  replyKB: number;
  pushMsgs: number;
  pushKB: number;
}

const SNAPSHOT_BYTES = 150_000;
const CAMS = Array.from({ length: 16 }, (_, i) => ({
  _id: `cam-${i}`,
  name: `Cam ${i}`,
  disabled: false,
  sources: [{ _id: `src-${i}`, name: 'main', role: 'high-resolution', useForSnapshot: true }],
}));
const SENSORS = Array.from({ length: 40 }, (_, i) => ({ id: `s-${i}`, type: 'motion', cameraId: `cam-${i % CAMS.length}` }));

function sizeOf(value: unknown): number {
  if (value === undefined) return 0;
  if (value instanceof ArrayBuffer) return value.byteLength;
  let binary = 0;
  const json = JSON.stringify(value, (_key, v: unknown) => {
    if (!(v instanceof ArrayBuffer)) return v;
    binary += v.byteLength;
    return null;
  });
  return json.length + binary;
}

class FakeServer {
  clients = new Set<FakeClient>();
  calls: Record<string, number> = {};
  subs: Record<string, number> = {};
  replyBytes = 0;
  pushMsgs = 0;
  pushBytes = 0;
  snapshots = new Map<string, { data: ArrayBuffer; fetchedAt: number }>();
  sensorConnected = new Map(SENSORS.map((s) => [s.id, true]));

  constructor(public readonly options: ServerOptions) {}

  cost(): Cost {
    const kb = (n: number): number => Math.round(n / 100) / 10;
    const cost = {
      getCamera: this.calls.getCamera ?? 0,
      refreshStates: this.calls.refreshStates ?? 0,
      snapshotWithMeta: this.calls.snapshotWithMeta ?? 0,
      subCamera: this.subs['camera.*.subscriber'] ?? 0,
      subSensors: this.subs['sensors.subject'] ?? 0,
      replyKB: kb(this.replyBytes),
      pushMsgs: this.pushMsgs,
      pushKB: kb(this.pushBytes),
    };
    this.calls = {};
    this.subs = {};
    this.replyBytes = 0;
    this.pushMsgs = 0;
    this.pushBytes = 0;
    return cost;
  }

  handle(ns: string, method: string, args: unknown[]): unknown {
    const camera = CAMS.find((c) => ns.includes(`.${c._id}.`));
    switch (method) {
      case 'getCamera':
        return CAMS.find((c) => c._id === args[0] || c.name === args[0]);
      case 'refreshStates': {
        const states = SENSORS.filter((s) => s.cameraId === camera!._id && this.sensorConnected.get(s.id)).map((s) => [
          s.id,
          { type: s.type, properties: {}, capabilities: [] },
        ]);
        return { camera, cameraState: true, frameWorkerState: true, sensorStates: Object.fromEntries(states) };
      }
      case 'snapshotWithMeta': {
        const entry = this.stored(camera!._id);
        const ageMs = Date.now() - entry.fetchedAt;
        if (!this.options.current) return { data: entry.data, ageMs };
        if (args[1] !== true && args[2] === entry.fetchedAt) return { notModified: true, fetchedAt: entry.fetchedAt, ageMs };
        return { data: entry.data, ageMs, fetchedAt: entry.fetchedAt };
      }
      default:
        throw Object.assign(new Error(`no method ${method}`), { code: 'METHOD_NOT_FOUND' });
    }
  }

  stored(cameraId: string): { data: ArrayBuffer; fetchedAt: number } {
    let entry = this.snapshots.get(cameraId);
    if (!entry) this.snapshots.set(cameraId, (entry = { data: new ArrayBuffer(SNAPSHOT_BYTES), fetchedAt: Date.now() - 2_000 }));
    return entry;
  }

  publish(subject: string, msg: unknown): void {
    const bytes = sizeOf(msg);
    for (const client of this.clients) {
      for (const cb of [...(client.subs.get(subject) ?? [])]) {
        this.pushMsgs++;
        this.pushBytes += bytes;
        cb(msg);
      }
    }
  }

  pushSnapshot(cameraId: string): void {
    const entry = this.stored(cameraId);
    Object.assign(entry, { data: new ArrayBuffer(SNAPSHOT_BYTES), fetchedAt: Date.now() });
    this.publish(`camera.${cameraId}.subscriber`, {
      type: 'snapshot:updated',
      data: { sourceId: `src-${cameraId.slice(4)}`, snapshot: entry.data, fetchedAt: entry.fetchedAt },
    });
  }

  sensorReconnected(sensorId: string, connected: boolean): void {
    this.sensorConnected.set(sensorId, connected);
    const sensor = SENSORS.find((s) => s.id === sensorId)!;
    const data = { sensorId, sensorType: sensor.type, connected, ...(this.options.current ? { assignedCameraIds: [sensor.cameraId] } : {}) };
    this.publish('sensors.subject', { type: 'sensor:connected:changed', data });
  }
}

class FakeClient {
  isConnected = true;
  isClosed = false;
  subs = new Map<string, Set<Handler>>();

  constructor(private readonly server: FakeServer) {
    server.clients.add(this);
  }

  async subscribe(subject: string, cb: Handler): Promise<() => void> {
    const key = subject.replace(/cam-\d+/, '*');
    this.server.subs[key] = (this.server.subs[key] ?? 0) + 1;
    let set = this.subs.get(subject);
    if (!set) this.subs.set(subject, (set = new Set()));
    set.add(cb);
    return () => set.delete(cb);
  }

  createProxy(ns: string): unknown {
    return new Proxy(
      {},
      {
        get: (_target, method: string) => {
          if (method === 'then') return undefined;
          return async (...args: unknown[]) => {
            this.server.calls[method] = (this.server.calls[method] ?? 0) + 1;
            await new Promise((resolve) => setTimeout(resolve, this.server.options.rttMs));
            const result = this.server.handle(ns, method, args);
            this.server.replyBytes += sizeOf(result);
            return result;
          };
        },
      },
    );
  }

  async flush(): Promise<void> {}

  close(): void {
    this.isConnected = false;
    this.isClosed = true;
    this.server.clients.delete(this);
  }
}

function fakeTransport(initial: FakeClient) {
  let current: FakeClient | null = initial;
  const listeners = new Set<(client: RPCClient | null) => void>();
  const transport = {
    getClient: () => current,
    subscribeClient(listener: (client: RPCClient | null) => void) {
      listeners.add(listener);
      listener(current as unknown as RPCClient | null);
      return () => listeners.delete(listener);
    },
    on: () => () => {},
  } as unknown as NatsTransport;
  function link(next: FakeClient | null): void {
    current = next;
    for (const listener of listeners) listener(next as unknown as RPCClient | null);
  }
  return { transport, link };
}

// the cards of a dashboard: the card loads its device by name, its snapshot by the camera object
async function runDashboard(options: ServerOptions): Promise<Record<string, Cost>> {
  const server = new FakeServer(options);
  let main = new FakeClient(server);
  let bulk = new FakeClient(server);
  const mainLink = fakeTransport(main);
  const bulkLink = fakeTransport(bulk);
  let ctx!: CameraUiContext;
  createCameraUiPlugin({ natsTransport: mainLink.transport, bulkTransport: bulkLink.transport, target: ref(null) }).install({
    provide: (_key, value) => (ctx = value as CameraUiContext),
  });

  const scopes = CAMS.map((cam) => {
    const app = createApp({});
    app.provide(CAMERA_UI_INJECTION_KEY, ctx);
    const scope = effectScope();
    app.runWithContext(() =>
      scope.run(() => {
        useCameraById(cam.name);
        useSnapshot(cam as unknown as DBCamera);
      }),
    );
    return scope;
  });
  const cost: Record<string, Cost> = {};

  await vi.advanceTimersByTimeAsync(5_000);
  cost.firstLoad = server.cost();

  for (const cam of CAMS) server.pushSnapshot(cam._id);
  await vi.advanceTimersByTimeAsync(100);
  cost.snapshotPush = server.cost();

  mainLink.link(null);
  bulkLink.link(null);
  await vi.advanceTimersByTimeAsync(1_300);
  mainLink.link(main);
  bulkLink.link(bulk);
  await vi.advanceTimersByTimeAsync(6_000);
  cost.blip = server.cost();

  mainLink.link(null);
  bulkLink.link(null);
  main.close();
  bulk.close();
  await vi.advanceTimersByTimeAsync(1_300);
  main = new FakeClient(server);
  bulk = new FakeClient(server);
  mainLink.link(main);
  bulkLink.link(bulk);
  await vi.advanceTimersByTimeAsync(6_000);
  cost.clientSwitch = server.cost();

  for (const s of SENSORS) server.sensorReconnected(s.id, false);
  await vi.advanceTimersByTimeAsync(500);
  for (const s of SENSORS) {
    server.sensorReconnected(s.id, true);
    await vi.advanceTimersByTimeAsync(25);
  }
  await vi.advanceTimersByTimeAsync(6_000);
  cost.pluginRestart = server.cost();

  scopes.forEach((scope) => scope.stop());
  await vi.advanceTimersByTimeAsync(2_000);
  if (process.env.DASHBOARD_COST_REPORT) console.table(cost);
  return cost;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  resetClientState();
  vi.useRealTimers();
});

describe('dashboard cost, 16 cards, 40 sensors, 40 ms round trip', () => {
  it('loads one device and one sensor subscription per camera', async () => {
    const cost = await runDashboard({ current: false, rttMs: 40 });

    expect(cost.firstLoad).toMatchObject({ getCamera: 16, refreshStates: 16, snapshotWithMeta: 16, subCamera: 16, subSensors: 1 });
    expect(cost.snapshotPush.pushMsgs).toBe(16);
    expect(cost.clientSwitch).toMatchObject({ getCamera: 0, refreshStates: 16, subCamera: 16, subSensors: 1 });
  });

  it('refreshes each camera at most once per round trip while a plugin restarts', async () => {
    const cost = await runDashboard({ current: false, rttMs: 40 });

    expect(cost.pluginRestart.pushMsgs).toBe(80);
    expect(cost.pluginRestart.refreshStates).toBeLessThanOrEqual(416);
  });

  it('refreshes only the cameras of a reconnected sensor when the server names them', async () => {
    const cost = await runDashboard({ current: true, rttMs: 40 });

    expect(cost.pluginRestart.refreshStates).toBeLessThanOrEqual(40);
  });

  it('downloads the snapshots again after a drop only from a server that cannot tell they are unchanged', async () => {
    const before = await runDashboard({ current: false, rttMs: 40 });
    resetClientState();
    const current = await runDashboard({ current: true, rttMs: 40 });

    expect(before.blip).toMatchObject({ refreshStates: 16, snapshotWithMeta: 16 });
    expect(before.blip.replyKB).toBeGreaterThan(2_000);
    expect(current.blip).toMatchObject({ refreshStates: 16, snapshotWithMeta: 16 });
    expect(current.blip.replyKB).toBeLessThan(20);
    expect(current.clientSwitch.replyKB).toBeLessThan(20);
  });
});
