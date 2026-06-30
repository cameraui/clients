export interface RedactRule {
  pattern: RegExp;
  replacement?: string;
}

export const DEFAULT_REDACT_RULES: RedactRule[] = [
  { pattern: /\bBearer\s+[A-Za-z0-9._-]+/gi, replacement: 'Bearer ***' },
  { pattern: /\beyJ[A-Za-z0-9._-]{10,}/g, replacement: '***jwt***' },
  { pattern: /([a-z][a-z0-9+.-]*:\/\/)([^:/@\s]+):([^@/\s]+)@/gi, replacement: '$1$2:***@' },
  { pattern: /\b(set-cookie|cookie)\b\s*[:=]\s*[^\s;]+/gi, replacement: '$1: ***' },
  {
    pattern: /("?\b(?:password|passwd|pwd|secret|token|apikey|api_key|access_token|refresh_token|authorization)\b"?\s*[:=]\s*)"?[^",}\s]+"?/gi,
    replacement: '$1***',
  },
];

export function redact(text: string, rules: RedactRule[] = DEFAULT_REDACT_RULES): string {
  let out = text;
  for (const rule of rules) {
    out = out.replace(rule.pattern, rule.replacement ?? '***');
  }
  return out;
}
