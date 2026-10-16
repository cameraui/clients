import { watchDetached } from './useRpc.js';

import type { RPCClient } from '@camera.ui/rpc';
import type { ShallowRef } from 'vue';

type BulkLane = Readonly<ShallowRef<RPCClient | undefined>>;

interface DeadMark {
  client: RPCClient;
  since: number;
  stop: () => void;
}

const PROBE_TIMEOUT_MS = 2_000;
const RECHECK_AFTER_MS = 60_000;

const deadMarks = new WeakMap<BulkLane, DeadMark>();
const runningProbes = new WeakMap<RPCClient, Promise<boolean>>();

export function liveBulkClient(lane: BulkLane | undefined): RPCClient | undefined {
  const client = lane?.value;
  if (!lane || !client) return undefined;
  const mark = deadMarks.get(lane);
  if (!mark || mark.client !== client) return client;
  // a congested lane misses the probe too, a later one in the background lets it back in without a caller waiting
  if (performance.now() - mark.since >= RECHECK_AFTER_MS && !runningProbes.has(client)) recheck(lane, mark);
  return undefined;
}

export function markBulkDead(lane: BulkLane, client: RPCClient): void {
  // a call that started before a reconnect probed the old client
  if (lane.value !== client || deadMarks.has(lane)) return;
  // the transport sets the lane to undefined on a drop, even when the same client comes back
  const stop = watchDetached(lane, () => clearMark(lane), { flush: 'sync' });
  deadMarks.set(lane, { client, since: performance.now(), stop });
}

// the caller already has its error, it never waits for the probe
export function noticeBulkTimeout(lane: BulkLane, client: RPCClient): void {
  if (lane.value !== client || deadMarks.has(lane)) return;
  void probeBulkClient(client).then((alive) => {
    if (!alive) markBulkDead(lane, client);
  });
}

export function probeBulkClient(client: RPCClient): Promise<boolean> {
  let alive = runningProbes.get(client);
  if (!alive) {
    alive = answersPing(client);
    runningProbes.set(client, alive);
    void alive.then(() => runningProbes.delete(client));
  }
  return alive;
}

async function answersPing(client: RPCClient): Promise<boolean> {
  try {
    await client.flush(PROBE_TIMEOUT_MS);
    return true;
  } catch {
    return false;
  }
}

function recheck(lane: BulkLane, mark: DeadMark): void {
  void probeBulkClient(mark.client).then((alive) => {
    if (deadMarks.get(lane) !== mark) return;
    if (alive) clearMark(lane);
    else mark.since = performance.now();
  });
}

function clearMark(lane: BulkLane): void {
  deadMarks.get(lane)?.stop();
  deadMarks.delete(lane);
}
