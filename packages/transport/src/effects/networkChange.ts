import type { Kernel } from '../core/kernel.js';

export type Detach = () => void;

export interface NetworkChangeSource extends EventTarget {
  // Opt-in: app supplies an EventTarget that fires 'change' events when the
  // network *type* changes (e.g., WiFi → Cellular). Different from
  // online/offline — connectivity is still there, but the routing path has
  // shifted.
}

export interface NetworkChangeOptions {
  readonly kernel: Kernel;
  readonly source: NetworkChangeSource;
  readonly onChange: (kernel: Kernel, event: Event) => void;
}

export function attachNetworkChange(options: NetworkChangeOptions): Detach {
  let detached = false;

  const handler = (event: Event): void => {
    if (detached) return;
    options.onChange(options.kernel, event);
  };

  options.source.addEventListener('change', handler);

  return () => {
    detached = true;
    options.source.removeEventListener('change', handler);
  };
}
