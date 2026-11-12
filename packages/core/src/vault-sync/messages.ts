/**
 * vault-sync/messages.ts — canonical CLI constant and message helpers.
 *
 * PARCHE-011: single source of truth for actionable command strings shown to users.
 * Every message that suggests running a CLI command MUST use these helpers so the
 * correct `npx @chamba/mcp vault` prefix is always present.
 *
 * Pure: no node: imports.
 */

/** The canonical CLI invocation prefix for all vault subcommands. */
export const VAULT_CLI = 'npx @chamba/mcp vault';

/**
 * Hint for re-linking a vault to a new directory.
 * @example linkHint('team-alpha', '/home/user/vault')
 * // → 'npx @chamba/mcp vault link team-alpha --dir "/home/user/vault"'
 */
export function linkHint(slug: string, dir: string, opts: { yes?: boolean } = {}): string {
  return `${VAULT_CLI} link ${slug} --dir "${dir}"${opts.yes ? ' --yes' : ''}`;
}

/**
 * Hint for re-linking when the exact dir is not yet known.
 * @example linkDirPlaceholderHint('team-alpha')
 * // → 'npx @chamba/mcp vault link team-alpha --dir <ruta>'
 */
export function linkDirPlaceholderHint(slug: string): string {
  return `${VAULT_CLI} link ${slug} --dir <ruta>`;
}

/**
 * Hint for a manual sync.
 * @example syncManualHint()
 * // → 'npx @chamba/mcp vault sync'
 */
export function syncManualHint(): string {
  return `${VAULT_CLI} sync`;
}

/**
 * Hint for joining a vault inside a repo (requires --allow-in-repo).
 * @example joinInRepoHint('/path/to/repo')
 * // → 'npx @chamba/mcp vault join <code> --dir "/path/to/repo" --allow-in-repo'
 */
export function joinInRepoHint(dir: string): string {
  return `${VAULT_CLI} join <code> --dir "${dir}" --allow-in-repo`;
}

/**
 * Hint for unlinking the workspace parche binding.
 * @example unlinkWorkspaceHint()
 * // → 'npx @chamba/mcp vault unlink --scope workspace'
 */
export function unlinkWorkspaceHint(): string {
  return `${VAULT_CLI} unlink --scope workspace`;
}

/**
 * Hint for the first join (no existing binding).
 * @example joinFirstHint()
 * // → 'npx @chamba/mcp vault join <código>'
 */
export function joinFirstHint(): string {
  return `${VAULT_CLI} join <código>`;
}

// ─── Network error message (CHAMBA-014) ──────────────────────────────────────

import type { Finding } from '../secrets/scanner.js';
import type { ParcheNetworkError } from './parche-client.js';

/**
 * Produces the canonical user-facing message for a `ParcheNetworkError`.
 *
 * Format (CHAMBA-014 §4.3):
 *   parche: no se pudo conectar a <host> tras <n> intento(s) (<code>: <shortMessage>).
 *   Lo ya subido queda guardado; vuelve a correr `npx @chamba/mcp vault sync <slug>`.
 *
 * Never includes query strings, headers, tokens or body.
 *
 * @param err  The network error.
 * @param opts Optional overrides: `slug` for the sync command hint, or
 *             `retryHint` to replace the entire retry command string (e.g. for join).
 */
export function parcheNetworkErrorMessage(
  err: ParcheNetworkError,
  opts?: { slug?: string; retryHint?: string },
): string {
  const plural = err.attempts === 1 ? 'intento' : 'intentos';
  const retryCmd = opts?.retryHint
    ? opts.retryHint
    : opts?.slug
      ? `${VAULT_CLI} sync ${opts.slug}`
      : `${VAULT_CLI} sync <slug>`;
  return (
    `parche: no se pudo conectar a ${err.host} tras ${err.attempts} ${plural} ` +
    `(${err.code}: ${err.shortMessage}). ` +
    `Lo ya subido queda guardado; vuelve a correr \`${retryCmd}\`.`
  );
}

// ─── Secret-scanner messages (CHAMBA-021) ────────────────────────────────────
// Never include the detected value — only path, line, kind, fingerprint.

/**
 * Canonical placeholder the user should paste in place of a detected secret
 * value. Shared with `isPlaceholder` in `secrets/entropy.ts` so it is never
 * flagged as a secret itself.
 */
export { REDACTED_PLACEHOLDER } from '../secrets/entropy.js';

/**
 * Hint for marking a specific finding as a false positive via the CLI.
 * @example allowSecretHint('a1b2c3d4e5f6', 'informes/x.md')
 * // → 'npx @chamba/mcp vault allow-secret a1b2c3d4e5f6 --path "informes/x.md"'
 */
export function allowSecretHint(fingerprint: string, path: string): string {
  return `${VAULT_CLI} allow-secret ${fingerprint} --path "${path}"`;
}

/**
 * The canonical "blocked by possible secret" message shown in sync summaries,
 * `vault status`, and adoption gates (CHAMBA-021 §2.2). Never includes the value.
 */
export function blockedSecretMessage(f: Finding): string {
  return (
    `⛔ bloqueado por posible secreto: ${f.path}:${f.line} (${f.kind}). ` +
    `Quita el valor o márcalo como falso positivo con \`${allowSecretHint(f.fingerprint, f.path)}\`.`
  );
}

/**
 * A multi-line summary of blocked findings, capped at 10 detail lines plus a
 * "y N más" tail. Returns `[]` when `blocked` is empty.
 */
export function blockedSecretsSummary(blocked: Finding[]): string[] {
  if (blocked.length === 0) return [];
  const lines = [
    `⛔ ${blocked.length} archivo(s) con posible secreto — no se subirán hasta resolverlos:`,
  ];
  const shown = blocked.slice(0, 10);
  for (const f of shown) lines.push(blockedSecretMessage(f));
  if (blocked.length > shown.length) {
    lines.push(`y ${blocked.length - shown.length} más`);
  }
  return lines;
}

// ─── Server-side rejection messages (CHAMBA-023 S6, D-Q1) ────────────────────
// A server rejection (`422 secret_detected`) only carries `kinds` — no
// fingerprint — so there is NO `allow-secret` hint here (§1.7/OQ4): the user
// can't allowlist something with no fingerprint. Never include the value.

/**
 * The canonical "server rejected it as a possible secret" message
 * (CHAMBA-023 D-Q1(a), owner decision). Suggests updating chamba — the
 * server may have newer rules than this client's own `scanText` — or
 * removing the value. `kinds` empty → the parenthetical is omitted.
 */
export function serverBlockedSecretMessage(f: { path: string; kinds: string[] }): string {
  const kindsSuffix = f.kinds.length > 0 ? ` (${f.kinds.join(', ')})` : '';
  return (
    `⛔ el servidor rechazó por posible secreto: ${f.path}${kindsSuffix}. ` +
    `Revisa el archivo y quita el valor; si crees que es un falso positivo, ` +
    `actualiza chamba (\`npx -y @chamba/mcp@latest\`) y avisa al dueño del parche.`
  );
}

/**
 * A multi-line summary of server-rejected paths, capped at 10 detail lines
 * plus a "y N más" tail — same shape as `blockedSecretsSummary`.
 */
export function serverBlockedSecretsSummary(
  blocked: Array<{ path: string; kinds: string[] }>,
): string[] {
  if (blocked.length === 0) return [];
  const lines = [`⛔ ${blocked.length} archivo(s) rechazados por el servidor por posible secreto:`];
  const shown = blocked.slice(0, 10);
  for (const f of shown) lines.push(serverBlockedSecretMessage(f));
  if (blocked.length > shown.length) {
    lines.push(`y ${blocked.length - shown.length} más`);
  }
  return lines;
}

/**
 * D-Q1 (owner decision §9): rejection message shown when a write-time scan
 * (summarize_to_vault, save_plan, remember) finds a secret in the content
 * before anything is written. No allow-secret hint — there is no path yet.
 */
export function writeBlockedSecretMessage(f: {
  field: string;
  line: number;
  kind: string;
}): string {
  const location = f.field === 'content' ? 'el contenido' : f.field;
  return (
    `⛔ no se escribió la nota: posible secreto en ${location} línea ${f.line} (${f.kind}). ` +
    `Reemplaza el valor por <REDACTADO> y vuelve a intentarlo.`
  );
}
