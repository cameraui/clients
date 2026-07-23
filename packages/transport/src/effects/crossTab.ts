import type { Kernel } from '../core/kernel.js';
import type { ConnectionTarget } from '../core/types.js';

export type Detach = () => void;

export interface CrossTabSource extends EventTarget {
  // Marker so we can be strict about what we accept.
}

export interface CrossTabOptions {
  readonly kernel: Kernel;
  readonly key?: string;
  readonly source?: CrossTabSource;
  readonly absorb?: (target: ConnectionTarget | null) => void;
  readonly onTokensReceived?: (tokens: ConnectionTarget['tokens']) => void;
  readonly onResetReceived?: () => void;
  readonly onError?: (op: 'parse', err: unknown) => void;
}

const DEFAULT_KEY = 'camera.ui:transport:target';

interface ParsedPayload {
  endpoint?: ConnectionTarget['endpoint'];
  tokens?: ConnectionTarget['tokens'];
}

export function attachCrossTab(options: CrossTabOptions): Detach {
  const key = options.key ?? DEFAULT_KEY;
  const source: EventTarget | undefined = options.source ?? (typeof window !== 'undefined' ? window : undefined);

  if (!source) {
    throw new Error('attachCrossTab: no `source` provided and no global `window` available');
  }

  function handle(event: Event): void {
    // Browsers fire StorageEvent; tests synthesize a CustomEvent-like with the
    // same shape. Cast and inspect defensively — duck typing.
    const e = event as StorageEvent;
    if (e.key !== key) return;

    if (e.newValue === null) {
      // Another tab cleared the storage entry — i.e. RESET. Only dispatch if
      // we currently hold a session; idle/discovering/offline just drop their
      // cached copy so a later retry doesn't probe with revoked tokens.
      options.absorb?.(null);
      const k = options.kernel.phase.kind;
      if (k !== 'online') return;
      options.kernel.dispatch({ type: 'RESET' });
      options.onResetReceived?.();
      return;
    }

    // newValue is a JSON-encoded ConnectionTarget. Take just the tokens — the
    // endpoint stays whatever the kernel currently knows.
    let parsed: ParsedPayload;
    try {
      parsed = JSON.parse(e.newValue) as ParsedPayload;
    } catch (err) {
      options.onError?.('parse', err);
      return;
    }
    if (!parsed?.tokens?.access) return;

    const k = options.kernel.phase.kind;
    if (k !== 'online') {
      if (parsed.endpoint?.url) {
        options.absorb?.({ endpoint: parsed.endpoint, tokens: parsed.tokens });
        // Still notify — the app may want to retry from needs-auth/idle now
        // that fresh tokens exist (other-tab login / instance switch).
        options.onTokensReceived?.(parsed.tokens);
      }
      return;
    }

    options.kernel.dispatch({ type: 'TOKENS_REFRESHED', tokens: parsed.tokens });
    options.onTokensReceived?.(parsed.tokens);
  }

  source.addEventListener('storage', handle as EventListener);

  return () => {
    source.removeEventListener('storage', handle as EventListener);
  };
}
