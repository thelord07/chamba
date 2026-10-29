import { describe, expect, it } from 'vitest';
import {
  assertAllowedServerUrl,
  DEFAULT_PARCHE_URL,
  InvalidJoinInputError,
  parseJoinInput,
  resolveServerUrl,
  ServerUrlError,
} from './server-url.js';

describe('assertAllowedServerUrl', () => {
  it('accepts https URLs', () => {
    expect(() => assertAllowedServerUrl('https://parche.chamba.tools')).not.toThrow();
    expect(() => assertAllowedServerUrl('https://example.com:8080')).not.toThrow();
  });

  it('accepts http to localhost', () => {
    expect(() => assertAllowedServerUrl('http://localhost:8787')).not.toThrow();
    expect(() => assertAllowedServerUrl('http://127.0.0.1:8787')).not.toThrow();
  });

  it('rejects http to non-loopback hosts', () => {
    expect(() => assertAllowedServerUrl('http://evil.com/j/…')).toThrow(ServerUrlError);
    expect(() => assertAllowedServerUrl('http://parche.chamba.tools')).toThrow(ServerUrlError);
  });

  it('rejects DNS-rebinding lookalikes (localhost-prefixed non-loopback hosts)', () => {
    // These hostnames look like loopback but are not — they must be rejected
    expect(() => assertAllowedServerUrl('http://localhost.evil.com')).toThrow(ServerUrlError);
    expect(() => assertAllowedServerUrl('http://127.0.0.1.nip.io')).toThrow(ServerUrlError);
  });

  it('rejects http://[::1].evil.com if parseable (otherwise also rejects as invalid URL)', () => {
    // [::1] in a hostname is only valid as a bare IPv6 literal, e.g. http://[::1]:8080.
    // Appending .evil.com is not valid — the URL constructor throws, so we get ServerUrlError.
    expect(() => assertAllowedServerUrl('http://[::1].evil.com')).toThrow(ServerUrlError);
  });

  it('rejects non-http/https schemes', () => {
    expect(() => assertAllowedServerUrl('ftp://parche.chamba.tools')).toThrow(ServerUrlError);
  });

  it('rejects invalid URLs', () => {
    expect(() => assertAllowedServerUrl('not-a-url')).toThrow(ServerUrlError);
  });
});

describe('parseJoinInput', () => {
  it('parses a bare code', () => {
    const result = parseJoinInput('K7QX-M2RP');
    expect(result.code).toBe('K7QX-M2RP');
    expect(result.server).toBeUndefined();
  });

  it('parses a bare code case-insensitively', () => {
    const result = parseJoinInput('k7qx-m2rp');
    expect(result.code).toBe('K7QX-M2RP');
  });

  it('parses a join link and extracts server and code', () => {
    const result = parseJoinInput('https://parche.chamba.tools/j/K7QX-M2RP');
    expect(result.code).toBe('K7QX-M2RP');
    expect(result.server).toBe('https://parche.chamba.tools');
  });

  it('parses a link with custom server', () => {
    const result = parseJoinInput('https://myserver.example.com/j/ABCD-1234');
    expect(result.code).toBe('ABCD-1234');
    expect(result.server).toBe('https://myserver.example.com');
  });

  it('rejects http to evil host', () => {
    expect(() => parseJoinInput('http://evil.com/j/K7QX-M2RP')).toThrow(ServerUrlError);
  });

  it('rejects link with missing code', () => {
    expect(() => parseJoinInput('https://parche.chamba.tools/join/K7QX-M2RP')).toThrow(
      InvalidJoinInputError,
    );
  });

  it('rejects garbage input', () => {
    expect(() => parseJoinInput('not-a-code-or-link')).toThrow(InvalidJoinInputError);
  });
});

describe('resolveServerUrl', () => {
  it('uses linkServer first', () => {
    expect(
      resolveServerUrl({
        linkServer: 'https://link.example.com',
        envUrl: 'https://env.example.com',
        flagServer: 'https://flag.example.com',
      }),
    ).toBe('https://link.example.com');
  });

  it('uses flagServer over envUrl', () => {
    expect(
      resolveServerUrl({
        envUrl: 'https://env.example.com',
        flagServer: 'https://flag.example.com',
      }),
    ).toBe('https://flag.example.com');
  });

  it('uses envUrl over default', () => {
    expect(resolveServerUrl({ envUrl: 'https://custom.example.com' })).toBe(
      'https://custom.example.com',
    );
  });

  it('falls back to DEFAULT_PARCHE_URL', () => {
    expect(resolveServerUrl({})).toBe(DEFAULT_PARCHE_URL);
  });

  it('rejects http non-loopback server', () => {
    expect(() => resolveServerUrl({ flagServer: 'http://evil.com' })).toThrow(ServerUrlError);
  });
});
