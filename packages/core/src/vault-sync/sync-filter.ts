/**
 * vault-sync/sync-filter.ts — determines which vault paths should be synced.
 * Pure: no Node APIs, no LLM. Defense-in-depth: denylist then allowlist.
 */

import { extname } from '../util/path.js';

const ALLOWED_EXTENSIONS = new Set([
  '.md',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.pdf',
  '.canvas',
  '.base',
]);

/**
 * Returns true if the vault-relative path should be included in sync.
 * Applies a denylist first, then an extension allowlist.
 */
export function isSyncable(path: string): boolean {
  const lower = path.toLowerCase();

  // ── Denylist: per-segment checks ──────────────────────────────────────────
  const segments = path.split('/');
  for (const seg of segments) {
    const segLower = seg.toLowerCase();
    if (segLower === '.ds_store') return false;
    if (segLower === '.trash') return false;
    if (segLower.startsWith('.chamba-sync')) return false;
    // .env, .env.*, .envrc (narrow — does NOT block .environment.md)
    if (segLower === '.env') return false;
    if (segLower.startsWith('.env.')) return false;
    if (segLower === '.envrc') return false;
  }

  // ── Denylist: path-level checks ───────────────────────────────────────────
  if (lower.startsWith('.obsidian/workspace')) return false;
  if (lower.startsWith('.obsidian/cache')) return false;

  // ── Allowlist: extension ──────────────────────────────────────────────────
  const ext = extname(path).toLowerCase();
  return ALLOWED_EXTENSIONS.has(ext);
}
