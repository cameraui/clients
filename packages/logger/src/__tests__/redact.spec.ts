import { describe, expect, it } from 'vitest';

import { buildExport } from '../export.js';
import { redact } from '../redact.js';

import type { LogEntry } from '../types.js';

describe('redact', () => {
  it('masks bearer tokens', () => {
    expect(redact('Authorization: Bearer abc.def-123')).not.toContain('abc.def-123');
  });

  it('masks bare JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
    expect(redact(`session ${jwt} end`)).not.toContain(jwt);
  });

  it('masks credentials in URLs', () => {
    expect(redact('rtsp://user:secret@cam.local/stream')).toBe('rtsp://user:***@cam.local/stream');
  });

  it('masks cookies', () => {
    expect(redact('cookie: session=abc123')).not.toContain('abc123');
  });

  it('masks password fields', () => {
    expect(redact('{"password":"hunter2"}')).not.toContain('hunter2');
  });
});

describe('buildExport', () => {
  const entries: LogEntry[] = [{ t: 0, level: 'info', scope: 's', msg: 'Bearer abc123secret' }];

  it('renders a diagnostic header and redacts by default', () => {
    const out = buildExport({ entries, context: { app: '1.0.0' } });
    expect(out).toContain('camera.ui diagnostics');
    expect(out).toContain('app: 1.0.0');
    expect(out).not.toContain('abc123secret');
  });

  it('leaves text intact when redact is false', () => {
    expect(buildExport({ entries, redact: false })).toContain('abc123secret');
  });
});
