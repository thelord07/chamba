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
