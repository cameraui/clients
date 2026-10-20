import type { Action, ConnectionPhase, ReducerContext, Tokens } from './types.js';

const DEFAULT_BACKOFF_MS = 5000;

export function reducer(phase: ConnectionPhase, action: Action, ctx: ReducerContext): ConnectionPhase {
  switch (action.type) {
    case 'RESET':
      return phase.kind === 'idle' ? phase : { kind: 'idle' };

    case 'BOOT': {
      if (phase.kind !== 'idle' && phase.kind !== 'offline' && phase.kind !== 'needs-auth') return phase;
      return withPending({ kind: 'discovering', instanceId: action.instanceId }, phase);
    }

    case 'USER_RETRY': {
      if (phase.kind === 'offline' || phase.kind === 'needs-auth') {
        return withPending({ kind: 'discovering', instanceId: phase.instanceId ?? '' }, phase);
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
      // from online this is the degraded-recovery escalation, the only case that tears down live state
      if (phase.kind !== 'discovering' && phase.kind !== 'online') return phase;
      // no backoff for needs-auth, no probe can succeed before the user acts
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
        // same reference for identical tokens, otherwise cross-tab persistence ping-pongs forever
        if (tokensEqual(phase.target.tokens, action.tokens)) return phase;
        return { ...phase, target: { ...phase.target, tokens: action.tokens } };
      }
      // a refresh that lands after the phase moved on still rotated the refresh token server-side
      if (phase.kind === 'discovering' || phase.kind === 'offline') {
        if (phase.pendingTokens && tokensEqual(phase.pendingTokens, action.tokens)) return phase;
        return { ...phase, pendingTokens: action.tokens };
      }
      return phase;
    }

    case 'TOKENS_INVALID': {
      if (phase.kind !== 'online') return phase;
      // network failure: the tokens are likely still valid, backoff retries with them
      if (action.transient === true) {
        return {
          kind: 'offline',
          instanceId: phase.instanceId,
          lastError: `tokens invalid: ${action.reason}`,
          nextRetryAt: ctx.now() + DEFAULT_BACKOFF_MS,
        };
      }
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
      if (phase.kind !== 'offline') return phase;
      const now = ctx.now();
      const candidate = now + action.retryAfterMs;
      // until a first hint lands nextRetryAt is only the flat default, backoff takes the later of hint and schedule
      if (phase.backoffHint && candidate <= phase.nextRetryAt) return phase;
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

function withPending(next: Extract<ConnectionPhase, { kind: 'discovering' }>, prev: ConnectionPhase): ConnectionPhase {
  return prev.kind === 'offline' && prev.pendingTokens ? { ...next, pendingTokens: prev.pendingTokens } : next;
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
