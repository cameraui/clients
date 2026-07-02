import type { Action, ConnectionPhase, ReducerContext, Tokens, TransportId, TransportStatus } from './types.js';

const EMPTY_TRANSPORTS: ReadonlyMap<TransportId, TransportStatus> = new Map();
const DEFAULT_BACKOFF_MS = 5000;

export function reducer(phase: ConnectionPhase, action: Action, ctx: ReducerContext): ConnectionPhase {
  switch (action.type) {
    case 'RESET':
      return phase.kind === 'idle' ? phase : { kind: 'idle' };

    case 'BOOT': {
      if (phase.kind !== 'idle' && phase.kind !== 'offline' && phase.kind !== 'needs-auth') return phase;
      return {
        kind: 'discovering',
        instanceId: action.instanceId,
        attempt: 1,
      };
    }

    case 'USER_RETRY': {
      if (phase.kind === 'offline') {
        return {
          kind: 'discovering',
          instanceId: phase.instanceId ?? '',
          attempt: 1,
        };
      }
      if (phase.kind === 'reconnecting') {
        return {
          kind: 'discovering',
          instanceId: phase.instanceId,
          attempt: 1,
          transports: phase.transports,
        };
      }
      if (phase.kind === 'needs-auth') {
        // login / seedAndRetry path — fresh tokens were just seeded, retry probe.
        return {
          kind: 'discovering',
          instanceId: phase.instanceId ?? '',
          attempt: 1,
        };
      }
      if (phase.kind === 'online') {
        // Force re-discover from a working connection. Used by the network-
        // change handler when the current target is `direct-wan` and a new
        // network (e.g., joining home WiFi) may have opened a faster
        // direct-LAN path. Costs a brief probe-race but lands on
        // the lowest-latency endpoint going forward.
        return {
          kind: 'discovering',
          instanceId: phase.instanceId,
          attempt: 1,
          transports: phase.transports,
        };
      }
      return phase;
    }

    case 'PROBE_SUCCEEDED': {
      if (phase.kind === 'discovering') {
        return {
          kind: 'online',
          instanceId: phase.instanceId,
          target: { endpoint: action.endpoint, tokens: action.tokens },
          transports: phase.transports ?? EMPTY_TRANSPORTS,
        };
      }
      if (phase.kind === 'reconnecting') {
        return {
          kind: 'online',
          instanceId: phase.instanceId,
          target: { endpoint: action.endpoint, tokens: action.tokens },
          transports: phase.transports,
        };
      }
      return phase;
    }

    case 'PROBE_FAILED_ALL': {
      if (phase.kind !== 'discovering' && phase.kind !== 'reconnecting') return phase;
      // `needs-auth` short-circuits the offline/backoff path: the user must
      // act before any probe can succeed, so auto-retrying is pure noise.
      if (action.error === 'needs-auth') {
        return {
          kind: 'needs-auth',
          instanceId: phase.instanceId,
          reason: action.error,
        };
      }
      const attempt = phase.kind === 'discovering' ? phase.attempt : 1;
      const backoff = ctx.retryBackoffMs?.(attempt) ?? DEFAULT_BACKOFF_MS;
      return {
        kind: 'offline',
        instanceId: phase.instanceId,
        lastError: action.error,
        nextRetryAt: ctx.now() + backoff,
      };
    }

    case 'TRANSPORT_UP': {
      if (phase.kind === 'online') {
        return { ...phase, transports: setStatus(phase.transports, action.id, { up: true }) };
      }
      if (phase.kind === 'reconnecting') {
        const next = setStatus(phase.transports, action.id, { up: true });
        if (phase.lastTarget && allPhaseGatingUp(next, ctx)) {
          return {
            kind: 'online',
            instanceId: phase.instanceId,
            target: phase.lastTarget,
            transports: next,
          };
        }
        return { ...phase, transports: next };
      }
      if (phase.kind === 'discovering') {
        // Keep the carried map current so the eventual PROBE_SUCCEEDED
        // enters `online` with an accurate view of the transports.
        return { ...phase, transports: setStatus(phase.transports ?? EMPTY_TRANSPORTS, action.id, { up: true }) };
      }
      return phase;
    }

    case 'TRANSPORT_DOWN': {
      if (phase.kind === 'online' || phase.kind === 'reconnecting') {
        return {
          ...phase,
          transports: setStatus(phase.transports, action.id, {
            up: false,
            lastError: action.reason,
            downSince: ctx.now(),
          }),
        };
      }
      if (phase.kind === 'discovering') {
        return {
          ...phase,
          transports: setStatus(phase.transports ?? EMPTY_TRANSPORTS, action.id, {
            up: false,
            lastError: action.reason,
            downSince: ctx.now(),
          }),
        };
      }
      return phase;
    }

    case 'TRANSPORT_DOWN_CONFIRMED': {
      if (phase.kind !== 'online') return phase;
      const spec = ctx.specs.get(action.id);
      if (!spec?.phaseGating) return phase;
      return {
        kind: 'reconnecting',
        instanceId: phase.instanceId,
        lastTarget: phase.target,
        cause: 'transport-down',
        since: ctx.now(),
        transports: setStatus(phase.transports, action.id, {
          up: false,
          lastError: 'down-confirmed',
          downSince: ctx.now(),
        }),
      };
    }

    case 'TOKENS_REFRESHED': {
      if (phase.kind === 'online') {
        // Idempotent: identical tokens → keep the same reference so no
        // listener fires. Important for cross-tab ping-pong: tab A persists →
        // tab B receives storage event → would re-dispatch with the same
        // tokens, which would re-fire persist → another storage event → loop.
        if (tokensEqual(phase.target.tokens, action.tokens)) return phase;
        return { ...phase, target: { ...phase.target, tokens: action.tokens } };
      }
      if (phase.kind === 'reconnecting' && phase.lastTarget) {
        if (tokensEqual(phase.lastTarget.tokens, action.tokens)) return phase;
        return { ...phase, lastTarget: { ...phase.lastTarget, tokens: action.tokens } };
      }
      return phase;
    }

    case 'TOKENS_INVALID': {
      if (phase.kind !== 'online' && phase.kind !== 'reconnecting') return phase;
      // Transient (network) failure → tokens are still likely valid, route
      // through offline so backoff retries pick them up later.
      if (action.transient === true) {
        const backoff = ctx.retryBackoffMs?.(1) ?? DEFAULT_BACKOFF_MS;
        return {
          kind: 'offline',
          instanceId: phase.instanceId,
          lastError: `tokens invalid: ${action.reason}`,
          nextRetryAt: ctx.now() + backoff,
        };
      }
      // Permanent (server-rejected) failure → no retry without user action.
      return {
        kind: 'needs-auth',
        instanceId: phase.instanceId,
        reason: `tokens invalid: ${action.reason}`,
      };
    }

    case 'BACKOFF_HINT': {
      // Server-issued retry hint (e.g., proxy 503 with Retry-After). Only
      // meaningful while we're already waiting (offline). Never SHORTEN —
      // if the local schedule already says wait 60s and the server says 5s,
      // we still wait 60s. Premature retries are the bigger risk.
      if (phase.kind !== 'offline') return phase;
      const now = ctx.now();
      const candidate = now + action.retryAfterMs;
      if (candidate <= phase.nextRetryAt) return phase;
      return {
        ...phase,
        nextRetryAt: candidate,
        backoffHint: {
          retryAfterMs: action.retryAfterMs,
          setAt: now,
          source: action.source,
        },
      };
    }
  }
}

function setStatus(map: ReadonlyMap<TransportId, TransportStatus>, id: TransportId, status: TransportStatus): ReadonlyMap<TransportId, TransportStatus> {
  const next = new Map(map);
  next.set(id, status);
  return next;
}

function allPhaseGatingUp(map: ReadonlyMap<TransportId, TransportStatus>, ctx: ReducerContext): boolean {
  for (const [id, spec] of ctx.specs) {
    if (!spec.phaseGating) continue;
    const status = map.get(id);
    if (!status?.up) return false;
  }
  return true;
}

function tokensEqual(a: Tokens, b: Tokens): boolean {
  return (
    a.access === b.access &&
    a.refresh === b.refresh &&
    a.accessExpiresAt === b.accessExpiresAt &&
    a.refreshExpiresAt === b.refreshExpiresAt &&
    a.proxySession === b.proxySession &&
    a.proxySessionExpiresAt === b.proxySessionExpiresAt &&
    a.proxyRefresh === b.proxyRefresh
  );
}
