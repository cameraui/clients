/* eslint-disable @stylistic/indent-binary-ops */
/* eslint-disable @stylistic/indent */
export type EndpointMode = 'direct-lan' | 'direct-wan';

export interface Endpoint {
  readonly url: string;
  readonly mode: EndpointMode;
  readonly priority?: number;
}

export interface Tokens {
  readonly access: string;
  readonly accessExpiresAt?: number;
  readonly refresh?: string;
  readonly refreshExpiresAt?: number;
  readonly proxySession?: string;
  readonly proxySessionExpiresAt?: number;
  readonly proxyRefresh?: string;
}

export interface ConnectionTarget {
  readonly endpoint: Endpoint;
  readonly tokens: Tokens;
  readonly meta?: Readonly<Record<string, unknown>>;
}

export type TransportId = string;

export type TransportKind = 'persistent' | 'request' | 'per-resource';

export interface TransportSpec {
  readonly id: TransportId;
  readonly kind: TransportKind;
  readonly phaseGating: boolean;
  readonly graceMs?: number;
}

export interface TransportStatus {
  readonly up: boolean;
  readonly lastError?: string;
  readonly downSince?: number;
}

export type ReconnectCause = 'transport-down' | 'auth-error' | 'network-change' | 'user-retry' | 'endpoint-swap';

export type ConnectionPhase =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'discovering';
      readonly instanceId: string;
      readonly attempt: number;
      readonly transports?: ReadonlyMap<TransportId, TransportStatus>;
    }
  | {
      readonly kind: 'online';
      readonly instanceId: string;
      readonly target: ConnectionTarget;
      readonly transports: ReadonlyMap<TransportId, TransportStatus>;
    }
  | {
      readonly kind: 'reconnecting';
      readonly instanceId: string;
      readonly lastTarget: ConnectionTarget | null;
      readonly cause: ReconnectCause;
      readonly since: number;
      readonly transports: ReadonlyMap<TransportId, TransportStatus>;
    }
  | {
      readonly kind: 'needs-auth';
      readonly instanceId: string | null;
      readonly reason: string;
    }
  | {
      readonly kind: 'offline';
      readonly instanceId: string | null;
      readonly lastError: string;
      readonly nextRetryAt: number;
      readonly backoffHint?: BackoffHint;
    };

export interface BackoffHint {
  readonly retryAfterMs: number;
  readonly setAt: number;
  readonly source?: string;
}

export type Action =
  | { readonly type: 'BOOT'; readonly instanceId: string }
  | { readonly type: 'PROBE_SUCCEEDED'; readonly endpoint: Endpoint; readonly tokens: Tokens }
  | { readonly type: 'PROBE_FAILED_ALL'; readonly error: string }
  | { readonly type: 'TRANSPORT_UP'; readonly id: TransportId }
  | { readonly type: 'TRANSPORT_DOWN'; readonly id: TransportId; readonly reason: string }
  | { readonly type: 'TRANSPORT_DOWN_CONFIRMED'; readonly id: TransportId }
  | { readonly type: 'TOKENS_REFRESHED'; readonly tokens: Tokens }
  | {
      readonly type: 'TOKENS_INVALID';
      readonly reason: string;
      readonly transient?: boolean;
    }
  | { readonly type: 'USER_RETRY' }
  | { readonly type: 'RESET' }
  | { readonly type: 'BACKOFF_HINT'; readonly retryAfterMs: number; readonly source?: string };

export interface ReducerContext {
  readonly specs: ReadonlyMap<TransportId, TransportSpec>;
  readonly now: () => number;
  readonly retryBackoffMs?: (attempt: number) => number;
}
