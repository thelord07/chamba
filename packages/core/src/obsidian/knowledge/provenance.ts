/**
 * obsidian/knowledge/provenance.ts — CHAMBA-021 S11: write-time provenance
 * (`author`, `agent`, `written_at`) and the single add-only rule that protects
 * human notes from being silently re-labelled by a chamba write.
 *
 * Pure TypeScript — no `node:` imports, no IO. Callers in `packages/mcp`
 * resolve `author` (credential/git config) and `version` (package.json) and
 * pass them in; this module never reaches into the OS itself.
 */

export interface Provenance {
  /** Human name behind the write. Never an email — callers must strip it. */
  author?: string;
  /** `chamba/<tool>@<version>`. */
  agent: string;
  /** ISO timestamp of the write. */
  written_at: string;
}

export interface BuildProvenanceInput {
  /** Raw author string (may include `Name <email>` — the email is stripped). */
  author?: string;
  /** Tool slug, e.g. `summarize_to_vault`, `remember`, `classify`. */
  tool: string;
  /** chamba/mcp package version. */
  version: string;
  /** Current time. */
  now: Date;
}

/**
 * Build a `Provenance` record. `author` is omitted when empty/whitespace-only,
 * and any `<email>` suffix is cut (never stored, never guessed).
 */
export function buildProvenance(input: BuildProvenanceInput): Provenance {
  const trimmed = input.author?.trim();
  const author = trimmed ? trimmed.split(' <')[0]?.trim() : undefined;
  return {
    ...(author && author.length > 0 ? { author } : {}),
    agent: `chamba/${input.tool}@${input.version}`,
    written_at: input.now.toISOString(),
  };
}

/** Fields considered "provenance" in a note's frontmatter. */
export interface ProvenanceFields {
  author?: string;
  agent?: string;
  written_at?: string;
  estado?: 'propuesto' | 'canonico';
  flag?: string;
}

export interface ApplyProvenancePatchOptions {
  /**
   * True when the write target is already chamba's (source: chamba or
   * generated: true), or is brand-new (no existing file). False means the
   * target is a pre-existing note chamba doesn't own — the patch becomes
   * strictly add-only (existing scalar/list values are never touched).
   */
  isChamba: boolean;
  /** `estado` to set on a chamba-owned write (default `propuesto`). */
  estado?: 'propuesto' | 'canonico';
  /** Optional `flag` to set (e.g. `'revisar'` for instruction-like content). */
  flag?: string;
}

/**
 * CHAMBA-021 S11 (ronda 2 #2): the ONE place that decides whether provenance
 * keys overwrite or merely fill gaps. Used by `VaultWriter`, `FilesystemMemoryStore`
 * and `classifyApply` instead of each tool re-implementing the rule.
 *
 * - Chamba-owned target: `author`/`agent`/`written_at`/`estado`/`flag` are set
 *   (overwritten) — a chamba write always re-labels its own note as `propuesto`.
 * - Human-owned target: every key is added ONLY if absent from `existing`.
 *   Existing values (scalar or list) are preserved byte-for-byte.
 */
export function applyProvenancePatch(
  existing: ProvenanceFields | undefined,
  provenance: Provenance,
  opts: ApplyProvenancePatchOptions,
): ProvenanceFields {
  const patch: ProvenanceFields = {};

  if (opts.isChamba) {
    if (provenance.author !== undefined) patch.author = provenance.author;
    patch.agent = provenance.agent;
    patch.written_at = provenance.written_at;
    patch.estado = opts.estado ?? 'propuesto';
    if (opts.flag !== undefined) patch.flag = opts.flag;
    return patch;
  }

  // Human-owned: add-only — never touch a key that is already present.
  if (existing?.author === undefined && provenance.author !== undefined) {
    patch.author = provenance.author;
  }
  if (existing?.agent === undefined) patch.agent = provenance.agent;
  if (existing?.written_at === undefined) patch.written_at = provenance.written_at;
  if (existing?.estado === undefined && opts.estado !== undefined) patch.estado = opts.estado;
  if (existing?.flag === undefined && opts.flag !== undefined) patch.flag = opts.flag;
  return patch;
}
