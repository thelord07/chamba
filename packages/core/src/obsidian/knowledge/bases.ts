/**
 * obsidian/knowledge/bases.ts — generator for Obsidian Bases `.base` files.
 *
 * Generates `temas/<root>.base` for each root-level vocabulary node with at
 * least one note in its subtree. Bases files are YAML with a specific syntax:
 *   - `filters.and[0]`: `file.hasTag("tema/<root>")`
 *   - `views[0]`: table with columns file.name, note.type, note.summary,
 *     note.work_item, note.date; grouped by note.type ASC.
 *
 * Marked as generated with a YAML comment header so `isChambaGenerated` can
 * identify them.
 *
 * Pure TypeScript — no `node:` imports, no external dependencies.
 */

import type { Vocabulary } from './vocabulary.js';

const NOTICE =
  'Generado por chamba desde los metadatos de las notas. No editar: edita las notas o temas/VOCABULARIO.md.';

function nfc(s: string): string {
  return s.normalize('NFC');
}

/**
 * Render a single `temas/<root>.base` file.
 *
 * @param rootPath - The root-level vocabulary path (e.g. `lms`).
 * @returns File content as a string (LF terminated).
 */
export function renderBaseFile(rootPath: string): string {
  const tag = `tema/${nfc(rootPath)}`;
  return [
    `# generated: true — source: chamba — ${nfc(NOTICE)}`,
    'filters:',
    '  and:',
    `    - file.hasTag("${tag}")`,
    'views:',
    '  - type: table',
    `    name: ${nfc(rootPath)}`,
    '    order: [file.name, note.type, note.summary, note.work_item, note.date]',
    '    groupBy:',
    '      property: note.type',
    '      direction: ASC',
    '',
  ].join('\n');
}

/**
 * Build all `.base` files for root-level vocabulary nodes that have at least
 * one note in their subtree.
 *
 * @param vocabulary   - Parsed vocabulary.
 * @param nodeNoteCounts - Map from topic path → number of notes in subtree.
 * @returns Map from vault-relative path (`temas/<root>.base`) → file content.
 */
export function buildBaseFiles(
  vocabulary: Vocabulary,
  nodeNoteCounts: Map<string, number>,
): Map<string, string> {
  const output = new Map<string, string>();

  if (!vocabulary.generar_bases) return output;

  for (const node of vocabulary.nodes.values()) {
    // Only root-level nodes
    if (node.parent !== null) continue;

    const count = nodeNoteCounts.get(node.path) ?? 0;
    if (count === 0) continue;

    const basePath = `temas/${node.path}.base`;
    output.set(basePath, renderBaseFile(node.path));
  }

  return output;
}
