import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { orderRelayFirst, relayFirstIceServers, relayPermitCandidate } from '../relayFirst.js';

const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const RELAY_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }, { urls: ['stun:[2606:4700:49::]:3478'] }];

const HOST = 'candidate:1 1 udp 2130706431 192.168.178.133 2004 typ host';
const SRFLX = 'candidate:2 1 udp 1694498815 87.168.52.62 46385 typ srflx raddr 192.168.178.133 rport 46385';
const RELAY = 'candidate:3 1 udp 1023 104.30.136.124 40159 typ relay raddr 192.168.178.133 rport 56291';
const HOST6 = 'candidate:4 1 udp 2130706429 2003:f6:4f12:7a00::1 2004 typ host';
const TCP = 'candidate:5 1 tcp 1671430143 192.168.178.133 2004 typ host tcptype passive';

class ProbePeerConnection {
  static instances: ProbePeerConnection[] = [];
  onicecandidate: ((event: { candidate: { type: string; address: string; candidate: string } | null }) => void) | null = null;
  closed = false;

  constructor(public config: RTCConfiguration) {
    ProbePeerConnection.instances.push(this);
  }

  createDataChannel(): void {}
  async createOffer(): Promise<{ type: string; sdp: string }> {
    return { type: 'offer', sdp: 'v=0' };
  }

  async setLocalDescription(): Promise<void> {}
  close(): void {
    this.closed = true;
  }

  gather(type: string, address: string): void {
    this.onicecandidate?.({ candidate: { type, address, candidate: `candidate:1 1 udp 1 ${address} 5000 typ ${type}` } });
  }

  complete(): void {
    this.onicecandidate?.({ candidate: null });
  }
}

async function loadProbe(userAgent: string) {
  vi.resetModules();
  vi.stubGlobal('navigator', { userAgent });
  return import('../relayFirst.js');
}

beforeEach(() => {
  vi.useFakeTimers();
  ProbePeerConnection.instances = [];
  vi.stubGlobal('RTCPeerConnection', ProbePeerConnection);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('orderRelayFirst', () => {
  it('adds the relay before the other IPv4 UDP candidates', async () => {
    const added: string[] = [];
    const handle = orderRelayFirst(async (candidate) => {
      added.push(candidate);
    });

    await handle(HOST);
    await handle(HOST6);
    await handle(TCP);
    await handle(SRFLX);
    expect(added).toEqual([HOST6, TCP]);

    await handle(RELAY);
    expect(added).toEqual([HOST6, TCP, RELAY]);

    await vi.advanceTimersByTimeAsync(500);
    expect(added).toEqual([HOST6, TCP, RELAY, HOST, SRFLX]);
  });

  it('lets the held candidates in when no relay comes', async () => {
    const added: string[] = [];
    const handle = orderRelayFirst(async (candidate) => {
      added.push(candidate);
    });

    await handle(HOST);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(added).toEqual([HOST]);
    await handle(SRFLX);
    expect(added).toEqual([HOST, SRFLX]);
  });
});

describe('relayFirstIceServers', () => {
  it('keeps STUN for IPv6 alone and TURN', () => {
    const turn = { urls: ['turn:turn.example.com:3478'], username: 'u', credential: 'c' };
    expect(relayFirstIceServers([...RELAY_SERVERS, turn])).toEqual([{ urls: ['stun:[2606:4700:49::]:3478'] }, turn]);
  });
});

describe('relayPermitCandidate', () => {
  it('names the address as a server reflexive candidate', () => {
    expect(relayPermitCandidate('80.187.113.20')).toBe('candidate:1 1 udp 1 80.187.113.20 9 typ srflx raddr 0.0.0.0 rport 0');
  });
});

describe('relayFirstAddress', () => {
  it('does not probe outside WebKit or without the relay', async () => {
    const chrome = await loadProbe(CHROME);
    expect(await chrome.relayFirstAddress(RELAY_SERVERS)).toBeUndefined();

    const safari = await loadProbe(SAFARI);
    expect(await safari.relayFirstAddress([{ urls: 'stun:stun.cloudflare.com:3478' }])).toBeUndefined();
    expect(ProbePeerConnection.instances).toHaveLength(0);
  });

  it('finds nothing when both STUN servers answer', async () => {
    const { relayFirstAddress } = await loadProbe(SAFARI);
    const address = relayFirstAddress(RELAY_SERVERS);
    await vi.advanceTimersByTimeAsync(0);

    const pc = ProbePeerConnection.instances[0];
    pc.gather('srflx', '80.187.113.20');
    pc.complete();
    expect(await address).toBeUndefined();
    expect(pc.closed).toBe(true);
  });

  it('returns the public IPv4 when the second STUN server never answers', async () => {
    const { relayFirstAddress } = await loadProbe(SAFARI);
    const address = relayFirstAddress(RELAY_SERVERS);
    await vi.advanceTimersByTimeAsync(0);

    const pc = ProbePeerConnection.instances[0];
    pc.gather('srflx', '2a01:599:60c:45ec::1');
    pc.gather('srflx', '80.187.113.20');
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await address).toBe('80.187.113.20');

    expect(relayFirstAddress(RELAY_SERVERS)).toBe(address);
    expect(ProbePeerConnection.instances).toHaveLength(1);
  });
});
