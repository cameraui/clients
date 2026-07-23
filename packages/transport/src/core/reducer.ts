import type { Action, ConnectionPhase, ReducerContext, Tokens } from './types.js';

const DEFAULT_BACKOFF_MS = 5000;

export function reducer(phase: ConnectionPhase, action: Action, ctx: ReducerContext): ConnectionPhase {
  switch (action.type) {
    case 'RESET':
      return phase.kind === 'idle' ? phase : { kind: 'idle' };

    case 'BOOT': {
      if (phase.kind !== 'idle' && phase.kind !== 'offline' && phase.kind !== 'needs-auth') return phase;
      return { kind: 'discovering', instanceId: action.instanceId };
    }

    case 'USER_RETRY': {
      if (phase.kind === 'offline' || phase.kind === 'needs-auth') {
        return { kind: 'discovering', instanceId: phase.instanceId ?? '' };
      }
      return phase;
    }

    case 'PROBE_SUCCEEDED': {
      if (phase.kind !== 'discovering') return phase;
      return {
        kind: 'online',
        instanceId: phase.instanceId,
        target: { endpoint: action.endpoint, tokens: action.tokens },
      };
    }

    case 'PROBE_FAILED_ALL': {
      // from online this is the degraded-recovery escalation: channels are
      // dead AND a probe just proved the endpoint unreachable — only then is
      // tearing down live state justified
      if (phase.kind !== 'discovering' && phase.kind !== 'online') return phase;
      // `needs-auth` short-circuits the offline/backoff path: the user must
      // act before any probe can succeed, so auto-retrying is pure noise.
      if (action.error === 'needs-auth') {
        return {
          kind: 'needs-auth',
          instanceId: phase.instanceId,
          reason: action.error,
        };
      }
      return {
        kind: 'offline',
        instanceId: phase.instanceId,
        lastError: action.error,
        nextRetryAt: ctx.now() + DEFAULT_BACKOFF_MS,
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
      if (phase.kind === 'discovering') {
        if (phase.pendingTokens && tokensEqual(phase.pendingTokens, action.tokens)) return phase;
        return { ...phase, pendingTokens: action.tokens };
      }
      return phase;
    }

    case 'TOKENS_INVALID': {
      if (phase.kind !== 'online') return phase;
      // Transient (network) failure → tokens are still likely valid, route
      // through offline so backoff retries pick them up later.
      if (action.transient === true) {
        return {
          kind: 'offline',
          instanceId: phase.instanceId,
          lastError: `tokens invalid: ${action.reason}`,
          nextRetryAt: ctx.now() + DEFAULT_BACKOFF_MS,
        };
      }
      // Permanent (server-rejected) failure → no retry without user action.
      return {
        kind: 'needs-auth',
        instanceId: phase.instanceId,
        reason: `tokens invalid: ${action.reason}`,
      };
    }

    case 'ENDPOINT_SWAP': {
      if (phase.kind !== 'online') return phase;
      const sameEndpoint = phase.target.endpoint.url === action.endpoint.url && phase.target.endpoint.mode === action.endpoint.mode;
      if (sameEndpoint) {
        if (tokensEqual(phase.target.tokens, action.tokens)) return phase;
        return { ...phase, target: { ...phase.target, tokens: action.tokens } };
      }
      return { ...phase, target: { endpoint: action.endpoint, tokens: action.tokens } };
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
