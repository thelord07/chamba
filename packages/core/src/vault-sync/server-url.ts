/**
 * vault-sync/server-url.ts — server URL resolution and invite-code parsing.
 * Pure: uses global URL only, no Node imports.
 */

/** Default server URL for parche. */
export const DEFAULT_PARCHE_URL = 'https://parche.chamba.tools';

/** Regex for a valid invite code (XXXX-XXXX, uppercase alphanumeric). */
const INVITE_CODE_RE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;

/** Loopback hostnames that are allowed over http:// */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export class ServerUrlError extends Error {
  override name = 'ServerUrlError';
}

export class InvalidJoinInputError extends Error {
  override name = 'InvalidJoinInputError';
}

/**
 * Validate that `url` is acceptable as a parche server URL.
 * Accepts `https:` unconditionally.
 * Accepts `http:` only if the hostname is loopback (localhost / 127.0.0.1 / [::1]).
 * Throws `ServerUrlError` on any other scheme or http to a non-loopback host.
 */
export function assertAllowedServerUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ServerUrlError(`Invalid URL: ${url}`);
  }

  if (parsed.protocol === 'https:') return;

  if (parsed.protocol === 'http:') {
    if (LOOPBACK_HOSTS.has(parsed.hostname)) return;
    throw new ServerUrlError(
      `http:// is only allowed for loopback addresses (localhost, 127.0.0.1, [::1]). ` +
        `Got: ${url}`,
    );
  }

  throw new ServerUrlError(`Unsupported protocol "${parsed.protocol}" in URL: ${url}`);
}

export interface ParsedJoinInput {
  code: string;
  /** Server extracted from the link, if the input was a link. */
  server?: string;
}

/**
 * Parse an invite code or a join link into `{code, server?}`.
 * Accepts:
 *   - `XXXX-XXXX` (bare code, uppercased)
 *   - `https://<server>/j/XXXX-XXXX` (link; sets server to origin)
 *
 * Throws `InvalidJoinInputError` for unrecognised formats or rejected server URLs.
 */
export function parseJoinInput(codeOrLink: string): ParsedJoinInput {
  const trimmed = codeOrLink.trim();

  // Try to parse as a URL first
  let parsed: URL | null = null;
  try {
    parsed = new URL(trimmed);
  } catch {
    // not a URL — fall through to bare-code check
  }

  if (parsed !== null) {
    // Validate the server URL
    const origin = parsed.origin;
    assertAllowedServerUrl(origin); // throws ServerUrlError if bad

    // Extract code from path /j/XXXX-XXXX
    const match = parsed.pathname.match(/^\/j\/([A-Z0-9]{4}-[A-Z0-9]{4})$/i);
    if (!match?.[1]) {
      throw new InvalidJoinInputError(
        `Could not extract invite code from link. Expected path like /j/XXXX-XXXX, got: ${parsed.pathname}`,
      );
    }
    const code = (match[1] as string).toUpperCase();
    return { code, server: origin };
  }

  // Bare code
  const upper = trimmed.toUpperCase();
  if (INVITE_CODE_RE.test(upper)) {
    return { code: upper };
  }

  throw new InvalidJoinInputError(
    `Invalid invite code or link: "${codeOrLink}". ` +
      `Expected XXXX-XXXX or https://<server>/j/XXXX-XXXX.`,
  );
}

export interface ResolveServerUrlOptions {
  /** Server extracted from a link (parseJoinInput). */
  linkServer?: string;
  /** Value of CHAMBA_PARCHE_URL environment variable. */
  envUrl?: string;
  /** Explicit --server flag from CLI. */
  flagServer?: string;
}

/**
 * Resolve the final server URL from available sources.
 * Priority: linkServer > flagServer > envUrl > DEFAULT_PARCHE_URL.
 * Validates the chosen URL with assertAllowedServerUrl.
 */
export function resolveServerUrl(opts: ResolveServerUrlOptions): string {
  const url = opts.linkServer ?? opts.flagServer ?? opts.envUrl ?? DEFAULT_PARCHE_URL;
  assertAllowedServerUrl(url);
  return url;
}
