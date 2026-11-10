const PROBE_STUN_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }, { urls: 'stun:stun.l.google.com:19302' }];
const PROBE_SETTLE_MS = 1_500;
const PROBE_TIMEOUT_MS = 4_000;
const PROBE_REUSE_MS = 60_000;
const RELAY_WAIT_MS = 3_000;
const RELAY_HEAD_START_MS = 500;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

let lastProbe: { startedAt: number; address: Promise<string | undefined> } | undefined;

export function relayFirstAddress(iceServers: RTCIceServer[] | undefined): Promise<string | undefined> {
  // the server lists a STUN server for IPv6 alone only while it offers its relay to a remote viewer
  if (!usesWebKitNetworking() || !iceServers?.some((server) => urlsOf(server).some(isIPv6OnlyStun))) return Promise.resolve(undefined);
  if (!lastProbe || Date.now() - lastProbe.startedAt > PROBE_REUSE_MS) {
    lastProbe = { startedAt: Date.now(), address: probeSingleIPv4Target() };
  }
  return lastProbe.address;
}

export function relayFirstIceServers(iceServers: RTCIceServer[] | undefined): RTCIceServer[] {
  // STUN over IPv4 would take the one IPv4 address WebKit reaches, the relay needs it
  return (iceServers ?? [])
    .map((server) => ({ ...server, urls: urlsOf(server).filter((url) => !/^stuns?:/i.test(url) || isIPv6OnlyStun(url)) }))
    .filter((server) => server.urls.length > 0);
}

export function relayPermitCandidate(address: string): string {
  // the relay forwards nothing from an address go2rtc never named, the port does not matter to it
  return `candidate:1 1 udp 1 ${address} 9 typ srflx raddr 0.0.0.0 rport 0`;
}

export function orderRelayFirst(add: (candidate: string) => Promise<void>): (candidate: string) => Promise<void> {
  const held: string[] = [];
  let relaySeen = false;
  let open = false;

  function release(): void {
    if (open) return;
    open = true;
    clearTimeout(wait);
    for (const candidate of held.splice(0)) add(candidate).catch(() => {});
  }

  const wait = setTimeout(release, RELAY_WAIT_MS);

  return async (candidate) => {
    if (open || !isUdpIPv4(candidate)) return add(candidate);
    if (relaySeen || !/ typ relay\b/.test(candidate)) {
      held.push(candidate);
      return;
    }
    relaySeen = true;
    setTimeout(release, RELAY_HEAD_START_MS);
    return add(candidate);
  };
}

function probeSingleIPv4Target(): Promise<string | undefined> {
  return new Promise((resolve) => {
    let pc: RTCPeerConnection;
    try {
      pc = new RTCPeerConnection({ iceServers: PROBE_STUN_SERVERS });
    } catch {
      resolve(undefined);
      return;
    }

    let address: string | undefined;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => finish(undefined), PROBE_TIMEOUT_MS);

    function finish(result: string | undefined): void {
      clearTimeout(timeout);
      clearTimeout(settle);
      pc.onicecandidate = null;
      pc.close();
      resolve(result);
    }

    pc.onicecandidate = (event) => {
      if (!event.candidate) {
        finish(undefined);
        return;
      }
      const found = event.candidate.address ?? event.candidate.candidate.split(' ')[4];
      if (address || event.candidate.type !== 'srflx' || !found || !IPV4.test(found)) return;
      address = found;
      // both STUN servers answer at once elsewhere, WebKit in a NAT64 network never sends to the second
      settle = setTimeout(() => finish(address), PROBE_SETTLE_MS);
    };

    pc.createDataChannel('probe');
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .catch(() => finish(undefined));
  });
}

function usesWebKitNetworking(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /AppleWebKit/i.test(navigator.userAgent) && !/Chrome|Chromium|Android|Edg/i.test(navigator.userAgent);
}

function urlsOf(server: RTCIceServer): string[] {
  return Array.isArray(server.urls) ? server.urls : [server.urls];
}

function isIPv6OnlyStun(url: string): boolean {
  return /^stuns?:\[/i.test(url);
}

function isUdpIPv4(candidate: string): boolean {
  const fields = candidate.split(' ');
  return fields[2]?.toLowerCase() === 'udp' && IPV4.test(fields[4] ?? '');
}
