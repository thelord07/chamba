/**
 * tasks/verify-config.ts — CHAMBA-022
 *
 * `verifyCommandSchema` lives in `config/schema.ts` (with the rest of the
 * config surface, N6) — this module only reexports it plus the pure lookup
 * `resolveVerifyCommands`. `tasks/` is allowed to import `config/`; the
 * reverse is never true.
 */

import type { ConfigFile, VerifyCommandConfig } from '../config/schema.js';

export type { VerifyCommandConfig } from '../config/schema.js';
export { verifyCommandSchema } from '../config/schema.js';

/** The subset of a loaded config file that `resolveVerifyCommands` needs. */
export type ReposConfig = Pick<ConfigFile, 'repos'>;

/**
 * Resolve the `verify` commands configured for `repoName`.
 *
 * `layers` is ordered from least to most specific (global, then project —
 * B9: these are the ONLY two layers ever consulted; a repo's own
 * `.chamba/config.json` is never read). A layer that configures the repo
 * REPLACES the previous layer's commands for that repo wholesale (no
 * per-command merge) — the same "later wins" rule `loadConfig` applies to
 * `defaults`/`overrides`.
 */
export function resolveVerifyCommands(
  layers: ReadonlyArray<ReposConfig | undefined>,
  repoName: string,
): VerifyCommandConfig[] {
  let resolved: VerifyCommandConfig[] | undefined;
  for (const layer of layers) {
    const entry = layer?.repos?.[repoName];
    if (entry) resolved = entry.verify;
  }
  return resolved ?? [];
}

/** Repo names that have at least one `verify` command configured in any layer. */
export function reposWithVerifyConfigured(
  layers: ReadonlyArray<ReposConfig | undefined>,
): string[] {
  const names = new Set<string>();
  for (const layer of layers) {
    for (const [name, entry] of Object.entries(layer?.repos ?? {})) {
      if (entry.verify.length > 0) names.add(name);
      else names.delete(name);
    }
  }
  return [...names];
}
