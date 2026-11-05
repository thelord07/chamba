/**
 * obsidian/knowledge/safe-path.ts — input validation for vault-relative paths.
 *
 * `safeVaultRelPath(input, style?)` validates that a user-supplied string is
 * a safe vault-relative path:
 *   1. Not empty.
 *   2. NFC-normalised, `\` → `/`.
 *   3. Not absolute (posix or win32: `/`, `C:/`, `C:\`, UNC `\\srv\share`).
 *   4. No `..` segments (would escape the vault).
 *   5. No hidden segments (starting with `.`): covers `.obsidian`, `.git`, etc.
 *   6. Must end with `.md`.
 *   7. No Windows-invalid file names.
 *
 * Returns `{ ok: rel }` on success (rel = normalised relative path, `/`-separated)
 * or `{ error: string }` on failure.
 *
 * Pure TypeScript: no `node:` imports, no external dependencies.
 */

import { assertNotUnsupportedPath, isAbsoluteLocal, isInvalidPath } from '../../util/local-path.js';

export type { PathStyle } from '../../util/local-path.js';

import type { PathStyle } from '../../util/local-path.js';

// ─── Public types ─────────────────────────────────────────────────────────────

export type SafePathResult = { ok: string } | { error: string };

// ─── Implementation ───────────────────────────────────────────────────────────

/**
 * Validate and normalise a user-supplied vault-relative path.
 *
 * @param input - The raw path string from user input.
 * @param style - Path style for Windows-name validation (default `'posix'`).
 *   Pass `'win32'` to also check for Windows-reserved names and trailing dots.
 *   The absolute/`..` checks always use `'win32'` (most restrictive).
 * @returns `{ ok: rel }` with the normalised `/`-separated relative path,
 *   or `{ error: message }` with a human-readable Spanish error.
 */
export function safeVaultRelPath(input: string, style: PathStyle = 'posix'): SafePathResult {
  // 1. Empty input
  if (!input || input.trim() === '') {
    return { error: 'La ruta no puede estar vacía.' };
  }

  // 2. NFC + replace \ → /
  const normalised = input.normalize('NFC').replace(/\\/g, '/');

  // 3. Reject device paths and drive-relative (win32-specific)
  try {
    assertNotUnsupportedPath(normalised, 'win32');
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Ruta inválida.' };
  }

  // 3b. Reject absolute paths (check with win32 to catch C:/, //srv/share, /foo)
  if (isAbsoluteLocal(normalised, 'win32')) {
    return {
      error: `La ruta "${input}" es absoluta; usa una ruta relativa al vault.`,
    };
  }

  // 4. Split by '/': discard '' and '.'; any '..' → error
  const rawSegments = normalised.split('/');
  const segments: string[] = [];
  for (const seg of rawSegments) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      return {
        error: `La ruta "${input}" sale del vault (contiene ".."); usa una ruta relativa al vault.`,
      };
    }
    segments.push(seg);
  }

  if (segments.length === 0) {
    return { error: `La ruta "${input}" está vacía tras normalizar.` };
  }

  // 5. Reject hidden segments (starting with '.')
  for (const seg of segments) {
    if (seg.startsWith('.')) {
      return {
        error: `La ruta "${input}" contiene una carpeta o archivo oculto "${seg}"; acceso no permitido.`,
      };
    }
  }

  // 6. Require .md extension
  const last = segments[segments.length - 1] ?? '';
  if (!last.toLowerCase().endsWith('.md')) {
    return {
      error: `La ruta "${input}" no es un archivo Markdown (.md).`,
    };
  }

  // 7. Check for Windows-invalid file names
  const rel = segments.join('/');
  if (isInvalidPath(rel, style)) {
    return {
      error: `La ruta "${input}" contiene un nombre de archivo inválido en Windows.`,
    };
  }

  // 8. OK
  return { ok: rel };
}
