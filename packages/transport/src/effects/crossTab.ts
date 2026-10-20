import type { Kernel } from '../core/kernel.js';
import type { ConnectionTarget } from '../core/types.js';

export type Detach = () => void;

export interface CrossTabSource extends EventTarget {}

export interface CrossTabPayload {
  readonly endpoint?: ConnectionTarget['endpoint'];
  readonly tokens: ConnectionTarget['tokens'];
}

export interface CrossTabOptions {
  readonly kernel: Kernel;
  readonly key?: string;
  readonly source?: CrossTabSource;
  readonly accept?: (payload: CrossTabPayload, current: ConnectionTarget | null) => boolean;
  readonly absorb?: (target: ConnectionTarget | null) => void;
  readonly onTokensReceived?: (tokens: ConnectionTarget['tokens']) => void;
  readonly onTokensIgnored?: (payload: CrossTabPayload) => void;
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
    const e = event as StorageEvent;
    if (e.key !== key) return;

    if (e.newValue === null) {
      // another tab logged out: a live session resets, the other phases only drop their cached tokens
      options.absorb?.(null);
      const k = options.kernel.phase.kind;
      if (k !== 'online') return;
      options.kernel.dispatch({ type: 'RESET' });
      options.onResetReceived?.();
      return;
    }

    let parsed: ParsedPayload;
    try {
      parsed = JSON.parse(e.newValue) as ParsedPayload;
    } catch (err) {
      options.onError?.('parse', err);
      return;
    }
    if (!parsed?.tokens?.access) return;

    const payload: CrossTabPayload = { endpoint: parsed.endpoint, tokens: parsed.tokens };
    const phase = options.kernel.phase;
    if (options.accept && !options.accept(payload, phase.kind === 'online' ? phase.target : null)) {
      options.onTokensIgnored?.(payload);
      return;
    }

    const k = phase.kind;
    if (k !== 'online') {
      if (parsed.endpoint?.url) {
        options.absorb?.({ endpoint: parsed.endpoint, tokens: parsed.tokens });
        // still notify, the app may retry from needs-auth now that another tab logged in
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
