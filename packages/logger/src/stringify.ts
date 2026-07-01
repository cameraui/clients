export function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (value instanceof Error) {
    return `${value.name}: ${value.message}${value.stack ? `\n${value.stack}` : ''}`;
  }
  if (typeof value !== 'object') return String(value);

  try {
    const seen = new WeakSet<object>();
    return JSON.stringify(value, (_key, val) => {
      if (typeof val === 'bigint') return `${val}n`;
      if (typeof val === 'function') return `[Function ${(val as { name?: string }).name || 'anonymous'}]`;
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
      }
      return val;
    });
  } catch {
    try {
      return String(value);
    } catch {
      return '[Unserializable]';
    }
  }
}

const FORMAT_SPEC = /%[sdifoOjc%]/g;
const HAS_SPEC = /%[sdifoOjc]/;

export function formatMessage(args: readonly unknown[]): string {
  const first = args[0];
  if (typeof first !== 'string' || !HAS_SPEC.test(first)) {
    return args.map(safeStringify).join(' ');
  }

  const rest = args.slice(1);
  let idx = 0;
  const out = first.replace(FORMAT_SPEC, (spec) => {
    if (spec === '%%') return '%';
    if (idx >= rest.length) return spec;
    const arg = rest[idx++];
    switch (spec) {
      case '%s':
        return typeof arg === 'string' ? arg : safeStringify(arg);
      case '%d':
      case '%i': {
        const n = typeof arg === 'number' ? arg : Number(arg);
        return Number.isNaN(n) ? 'NaN' : String(Math.trunc(n));
      }
      case '%f': {
        const n = typeof arg === 'number' ? arg : Number(arg);
        return Number.isNaN(n) ? 'NaN' : String(n);
      }
      case '%c':
        return '';
      default:
        return safeStringify(arg);
    }
  });

  const leftover = rest.slice(idx).map(safeStringify).join(' ');
  return leftover ? `${out} ${leftover}` : out;
}
