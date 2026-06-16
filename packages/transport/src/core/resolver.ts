import type { Endpoint, EndpointMode } from './types.js';

export function sortByPriority(endpoints: readonly Endpoint[]): Endpoint[] {
  return [...endpoints].sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));
}

export function isSameEndpoint(a: Endpoint, b: Endpoint): boolean {
  return a.mode === b.mode && a.url === b.url;
}

export function endpointKey(ep: Endpoint): string {
  return `${ep.mode}|${ep.url}`;
}

export type { EndpointMode };
