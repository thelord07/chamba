/**
 * Test 1 — note-metadata (CHAMBA-016 ola 1)
 *
 * Covers: complete frontmatter, partial, absent, YAML-invalid (no crash),
 * unknown fields preserved byte-for-byte in upsert, CRLF preserved,
 * body identical byte-for-byte, quoting round-trip.
 */
import { describe, expect, it } from 'vitest';
import { readNoteMetadata, upsertNoteMetadata } from './note-metadata.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function crlf(s: string): string {
  return s.replace(/\n/g, '\r\n');
}

// ─── readNoteMetadata ─────────────────────────────────────────────────────────

describe('readNoteMetadata', () => {
  it('parses a complete frontmatter correctly', () => {
    const content = [
      '---',
      'title: "HU LMS API 01 — cursos y módulos"',
      'date: 2026-10-29',
      'type: plan',
      'summary: "Endpoints de creación y gestión de cursos."',
      'tags:',
      '  - tema/lms/cursos/creacion',
      '  - tema/lms/cursos/gestion',
      '  - chamba',
      'keywords: [POST /courses, módulos, api key]',
      'aliases: ["cursos LMS API"]',
      'work_item: hu-lms-api-01',
      'project: lapzo-lms-api',
      'related:',
      '  - plans/2026-10-29-hu-lms-api-01.md',
      'temas_propuestos: [lms/certificados]',
      'source: chamba',
      'generated: false',
      '---',
      '',
      '# Título',
      '',
      'Primer párrafo del cuerpo.',
    ].join('\n');

    const meta = readNoteMetadata(content, 'proyectos/nota.md');

    expect(meta.title).toBe('HU LMS API 01 — cursos y módulos');
    expect(meta.date).toBe('2026-10-29');
    expect(meta.type).toBe('plan');
    expect(meta.summary).toBe('Endpoints de creación y gestión de cursos.');
    expect(meta.tags).toEqual(['tema/lms/cursos/creacion', 'tema/lms/cursos/gestion', 'chamba']);
    expect(meta.temas).toEqual(['lms/cursos/creacion', 'lms/cursos/gestion']);
    expect(meta.keywords).toEqual(['POST /courses', 'módulos', 'api key']);
    expect(meta.aliases).toEqual(['cursos LMS API']);
    expect(meta.work_item).toBe('hu-lms-api-01');
    expect(meta.project).toBe('lapzo-lms-api');
    expect(meta.related).toEqual(['plans/2026-10-29-hu-lms-api-01.md']);
    expect(meta.temas_propuestos).toEqual(['lms/certificados']);
    expect(meta.source).toBe('chamba');
    expect(meta.generated).toBe(false);
  });

  it('handles partial frontmatter with sensible defaults', () => {
    const content = ['---', 'title: Solo el título', '---', '', 'Párrafo de descripción.'].join(
      '\n',
    );

    const meta = readNoteMetadata(content, 'notas/parcial.md');

    expect(meta.title).toBe('Solo el título');
    expect(meta.type).toBe('nota');
    expect(meta.tags).toEqual([]);
    expect(meta.temas).toEqual([]);
    expect(meta.keywords).toEqual([]);
    expect(meta.aliases).toEqual([]);
    expect(meta.related).toEqual([]);
    expect(meta.temas_propuestos).toEqual([]);
    expect(meta.date).toBeUndefined();
    expect(meta.source).toBeUndefined();
    expect(meta.generated).toBeUndefined();
    // Summary from first body paragraph
    expect(meta.summary).toBe('Párrafo de descripción.');
  });

  it('handles absent frontmatter with basename-derived title', () => {
    const content = '# Nota sin frontmatter\n\nContenido de la nota.\n';

    const meta = readNoteMetadata(content, 'proyectos/2026-10-29-mi-nota.md');

    expect(meta.title).toBe('2026-10-29-mi-nota');
    expect(meta.type).toBe('nota');
    expect(meta.tags).toEqual([]);
    expect(meta.temas).toEqual([]);
    // First non-heading paragraph
    expect(meta.summary).toBe('Contenido de la nota.');
  });

  it('does not crash on invalid YAML and returns defaults', () => {
    const content = [
      '---',
      ':: invalid yaml ::',
      'title: [unclosed',
      'tags: {bad',
      '---',
      'Body stays.',
    ].join('\n');

    // Must not throw
    let meta: ReturnType<typeof readNoteMetadata> | undefined;
    expect(() => {
      meta = readNoteMetadata(content, 'broken.md');
    }).not.toThrow();

    expect(meta?.type).toBe('nota');
    expect(meta?.title).toBe('broken');
  });

  it('falls back to first body paragraph for summary when absent', () => {
    const content = [
      '---',
      'title: Sin summary',
      '---',
      '',
      '# Encabezado ignorado',
      '',
      'Este es el primer párrafo real.',
      'Continúa en la misma línea.',
    ].join('\n');

    const meta = readNoteMetadata(content, 'x.md');
    expect(meta.summary).toBe('Este es el primer párrafo real. Continúa en la misma línea.');
  });

  it('truncates summary to 200 chars', () => {
    const longSummary = 'a'.repeat(250);
    const content = `---\ntitle: T\nsummary: ${longSummary}\n---\nbody\n`;
    const meta = readNoteMetadata(content, 'x.md');
    expect(meta.summary).toHaveLength(200);
  });

  it('extracts temas without prefix, deduped and ordered', () => {
    const content = [
      '---',
      'title: T',
      'tags:',
      '  - tema/lms',
      '  - chamba',
      '  - tema/lms', // duplicate
      '  - tema/devops/ci',
      '---',
    ].join('\n');

    const meta = readNoteMetadata(content, 'x.md');
    expect(meta.temas).toEqual(['lms', 'devops/ci']);
  });

  it('clamps keywords to 10 and truncates each to 40 chars', () => {
    const kws = Array.from({ length: 12 }, (_, i) => `keyword-${i.toString().padStart(2, '0')}`);
    const longKw = 'a'.repeat(50);
    const content = `---\ntitle: T\nkeywords: [${[...kws, longKw].join(', ')}]\n---\n`;
    const meta = readNoteMetadata(content, 'x.md');
    expect(meta.keywords.length).toBeLessThanOrEqual(10);
    for (const kw of meta.keywords) {
      expect(kw.length).toBeLessThanOrEqual(40);
    }
  });

  it('parses inline list tags', () => {
    const content = '---\ntitle: T\ntags: [chamba, tema/lms, "tema/lms/cursos"]\n---\n';
    const meta = readNoteMetadata(content, 'x.md');
    expect(meta.tags).toEqual(['chamba', 'tema/lms', 'tema/lms/cursos']);
    expect(meta.temas).toEqual(['lms', 'lms/cursos']);
  });

  it('parses generated: true correctly', () => {
    const content = '---\ntitle: T\nsource: chamba\ngenerated: true\n---\nbody\n';
    const meta = readNoteMetadata(content, 'x.md');
    expect(meta.source).toBe('chamba');
    expect(meta.generated).toBe(true);
  });

  it('handles block list with single quotes', () => {
    const content = ['---', 'title: T', 'tags:', "  - 'tema/lms'", '  - chamba', '---'].join('\n');
    const meta = readNoteMetadata(content, 'x.md');
    expect(meta.tags).toEqual(['tema/lms', 'chamba']);
  });

  it('ignores #-comments in frontmatter lines', () => {
    const content = [
      '---',
      'title: Mi nota # esto es un comentario',
      'type: plan # tipo',
      '---',
      'body',
    ].join('\n');
    const meta = readNoteMetadata(content, 'x.md');
    expect(meta.title).toBe('Mi nota');
    expect(meta.type).toBe('plan');
  });
});

// ─── upsertNoteMetadata ───────────────────────────────────────────────────────

describe('upsertNoteMetadata', () => {
  it('modifies only the patched keys, leaves others byte-for-byte intact', () => {
    const original = [
      '---',
      'title: Original',
      'type: nota',
      '# a comment that must survive',
      'unknown_key: preserved value',
      'date: 2026-01-01',
      '---',
      '',
      'Body intact.',
    ].join('\n');

    const updated = upsertNoteMetadata(original, { type: 'plan' });

    // type must be updated
    expect(updated).toContain('type: plan');
    // title untouched
    expect(updated).toContain('title: Original');
    // comment preserved
    expect(updated).toContain('# a comment that must survive');
    // unknown key preserved
    expect(updated).toContain('unknown_key: preserved value');
    // date preserved
    expect(updated).toContain('date: 2026-01-01');
    // body intact
    expect(updated).toContain('\nBody intact.');
  });

  it('preserves CRLF line endings on unchanged lines', () => {
    const original = crlf(['---', 'title: T', 'type: nota', '---', '', 'Body.'].join('\n'));

    const updated = upsertNoteMetadata(original, { type: 'resumen' });

    // All \n should be \r\n
    const lines = updated.split('\r\n');
    // At least 4 lines (fences + title + type + empty + body)
    expect(lines.length).toBeGreaterThanOrEqual(4);
    // Should NOT contain bare \n that is not \r\n
    const bareNewlines = updated.replace(/\r\n/g, '').includes('\n');
    expect(bareNewlines).toBe(false);
  });

  it('body is identical byte-for-byte after upsert', () => {
    const body = '\n# Title\n\nParagraph one.\n\nParagraph two with `code` and *emphasis*.\n';
    const original = `---\ntitle: T\n---${body}`;

    const updated = upsertNoteMetadata(original, { type: 'informe' });

    // Everything after the closing fence should be exactly `body`
    const closeFenceIdx = updated.indexOf('\n---\n', 4);
    const bodyInUpdated = updated.slice(closeFenceIdx + 5);
    const bodyExpected = body.slice(1); // body starts with \n, closeFenceIdx+5 skips it
    expect(bodyInUpdated).toBe(bodyExpected);
  });

  it('appends new key to frontmatter when absent', () => {
    const original = '---\ntitle: T\n---\nbody\n';
    const updated = upsertNoteMetadata(original, { source: 'chamba' });

    expect(updated).toContain('source: chamba');
    expect(updated).toContain('title: T');
    expect(updated).toContain('body\n');
  });

  it('creates frontmatter block when none exists', () => {
    const original = 'This is a plain markdown file.\n\nNo frontmatter.\n';
    const updated = upsertNoteMetadata(original, { title: 'New Title', type: 'guia' });

    expect(updated.startsWith('---\n')).toBe(true);
    expect(updated).toContain('title: New Title');
    expect(updated).toContain('type: guia');
    expect(updated).toContain('This is a plain markdown file.');
  });

  it('renders block lists correctly for tags and related', () => {
    const original = '---\ntitle: T\n---\nbody\n';
    const updated = upsertNoteMetadata(original, {
      tags: ['tema/lms', 'chamba'],
      related: ['plans/2026.md'],
    });

    expect(updated).toContain('tags:\n  - tema/lms\n  - chamba\n');
    expect(updated).toContain('related:\n  - plans/2026.md\n');
  });

  it('renders inline lists for keywords, aliases, temas_propuestos', () => {
    const original = '---\ntitle: T\n---\nbody\n';
    const updated = upsertNoteMetadata(original, {
      keywords: ['POST /courses', 'módulos'],
      aliases: ['cursos LMS'],
      temas_propuestos: ['lms/cert'],
    });

    expect(updated).toContain('keywords: [');
    expect(updated).toContain('aliases: [');
    expect(updated).toContain('temas_propuestos: [');
  });

  it('replaces an existing block list in-place', () => {
    const original = [
      '---',
      'title: T',
      'tags:',
      '  - old-tag',
      'date: 2026-01-01',
      '---',
      'body',
    ].join('\n');

    const updated = upsertNoteMetadata(original, {
      tags: ['tema/lms', 'chamba'],
    });

    expect(updated).toContain('tags:\n  - tema/lms\n  - chamba\n');
    expect(updated).not.toContain('old-tag');
    expect(updated).toContain('date: 2026-01-01');
    expect(updated).toContain('title: T');
  });

  it('quoting round-trip: what upsert writes, readNoteMetadata reads back identically', () => {
    const patch = {
      title: 'Plan: cursos y módulos',
      summary: 'Tiene "comillas" y #hashtags especiales.',
      type: 'plan' as const,
      tags: ['tema/lms', 'chamba'],
      keywords: ['POST /courses', 'api key'],
      aliases: ['cursos LMS'],
      work_item: 'hu-001',
      source: 'chamba',
      generated: false,
    };

    const original = '---\ntitle: Old\n---\nbody\n';
    const updated = upsertNoteMetadata(original, patch);
    const meta = readNoteMetadata(updated, 'x.md');

    expect(meta.title).toBe(patch.title);
    expect(meta.summary).toBe(patch.summary);
    expect(meta.type).toBe(patch.type);
    expect(meta.tags).toEqual(patch.tags);
    expect(meta.keywords).toEqual(patch.keywords);
    expect(meta.aliases).toEqual(patch.aliases);
    expect(meta.work_item).toBe(patch.work_item);
    expect(meta.source).toBe(patch.source);
    expect(meta.generated).toBe(patch.generated);
  });

  it('quoting round-trip survives values with colons and special chars', () => {
    const special = [
      '', // empty
      'true', // bool-like
      'null', // null-like
      '123', // number-like
      'foo: bar', // colon
      '#hashtag', // hash
      ' leading', // leading space
      'trailing ', // trailing space
      '"quoted"', // embedded quotes
    ];

    for (const val of special) {
      const updated = upsertNoteMetadata('---\ntitle: T\n---\nbody\n', {
        summary: val,
      });
      const meta = readNoteMetadata(updated, 'x.md');
      // Empty string → summary falls back to body paragraph, so skip that case
      if (val !== '') {
        expect(meta.summary).toBe(val);
      }
    }
  });

  it('unknown keys in frontmatter are preserved byte-for-byte during upsert', () => {
    const original = [
      '---',
      'title: T',
      'my_custom_field: some value',
      'another: 42',
      '---',
      'body',
    ].join('\n');

    const updated = upsertNoteMetadata(original, { type: 'informe' });

    expect(updated).toContain('my_custom_field: some value');
    expect(updated).toContain('another: 42');
  });

  it('preserves CRLF in new keys added to CRLF file', () => {
    const original = crlf('---\ntitle: T\n---\nbody\n');
    const updated = upsertNoteMetadata(original, { source: 'chamba' });

    expect(updated).toContain('source: chamba\r\n');
    const bareNewlines = updated.replace(/\r\n/g, '').includes('\n');
    expect(bareNewlines).toBe(false);
  });

  it('new keys appended in KEY_ORDER (title before date before type)', () => {
    const original = '---\n---\nbody\n';
    const updated = upsertNoteMetadata(original, {
      type: 'resumen',
      date: '2026-01-01',
      title: 'My Note',
    });

    const titleIdx = updated.indexOf('title:');
    const dateIdx = updated.indexOf('date:');
    const typeIdx = updated.indexOf('type:');

    expect(titleIdx).toBeLessThan(dateIdx);
    expect(dateIdx).toBeLessThan(typeIdx);
  });

  it('generated: true writes as unquoted boolean', () => {
    const updated = upsertNoteMetadata('---\ntitle: T\n---\n', { generated: true });
    expect(updated).toContain('generated: true');
    expect(updated).not.toContain('generated: "true"');
  });

  it('determinism: same input → same output string', () => {
    const original = ['---', 'title: T', 'tags:', '  - chamba', '---', 'body'].join('\n');
    const patch = { type: 'plan' as const, summary: 'desc', keywords: ['k1', 'k2'] };

    const out1 = upsertNoteMetadata(original, patch);
    const out2 = upsertNoteMetadata(original, patch);
    expect(out1).toBe(out2);
  });
});

// ─── M5: parseInlineList with escaped double-quote and backslash ──────────────

describe('M5: parseInlineList handles " and \\ in quoted items', () => {
  it('round-trip: keyword with double-quote inside', () => {
    // A keyword that contains a double quote
    const kwWithQuote = 'say "hello"';
    const content = [
      '---',
      `keywords: ["${kwWithQuote.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`,
      '---',
      '',
      'Body.',
    ].join('\n');
    const meta = readNoteMetadata(content, 'test.md');
    expect(meta.keywords).toEqual([kwWithQuote]);
  });

  it('round-trip: keyword with backslash inside', () => {
    const kwWithBackslash = 'path\\to\\file';
    const content = [
      '---',
      `keywords: ["${kwWithBackslash.replace(/\\/g, '\\\\')}"]`,
      '---',
      '',
      'Body.',
    ].join('\n');
    const meta = readNoteMetadata(content, 'test.md');
    expect(meta.keywords).toEqual([kwWithBackslash]);
  });

  it('round-trip: keyword with comma inside double quotes', () => {
    // A comma inside a double-quoted item should NOT split the item
    const content = ['---', 'keywords: ["hello, world", plain]', '---', '', 'Body.'].join('\n');
    const meta = readNoteMetadata(content, 'test.md');
    expect(meta.keywords).toHaveLength(2);
    expect(meta.keywords[0]).toBe('hello, world');
    expect(meta.keywords[1]).toBe('plain');
  });

  it('round-trip via upsert: keyword with quote survives write and re-read', () => {
    const base = '---\ntitle: Test\n---\nBody.\n';
    const kwWithQuote = 'a "quoted" word';
    const patched = upsertNoteMetadata(base, { keywords: [kwWithQuote] });
    const meta = readNoteMetadata(patched, 'test.md');
    expect(meta.keywords).toEqual([kwWithQuote]);
  });
});

// ─── M6: NFC normalization ────────────────────────────────────────────────────

describe('M6: NFC normalization', () => {
  // NFD form: é composed from 'e' + combining accent (U+0301)
  const titleNFD = 'café'; // 'cafe' + combining accent = 'café' in NFD
  const titleNFC = 'café'; // 'café' as precomposed NFC

  it('readNoteMetadata: NFD title is returned as NFC', () => {
    const content = ['---', `title: "${titleNFD}"`, '---', '', 'Body.'].join('\n');
    const meta = readNoteMetadata(content, 'test.md');
    expect(meta.title).toBe(titleNFC);
    // Verify they're actually different
    expect(titleNFD).not.toBe(titleNFC);
  });

  it('upsertNoteMetadata: NFD patch value written as NFC', () => {
    const base = '---\ntitle: Original\n---\nBody.\n';
    const patched = upsertNoteMetadata(base, { title: titleNFD });
    const meta = readNoteMetadata(patched, 'test.md');
    expect(meta.title).toBe(titleNFC);
  });

  it('upsertNoteMetadata: body remains byte-for-byte intact', () => {
    const bodyNFD = `Cuerpo con é sin cambiar.`;
    const base = `---\ntitle: Original\n---\n${bodyNFD}`;
    const patched = upsertNoteMetadata(base, { title: 'Nuevo' });
    // Body should be unchanged
    expect(patched).toContain(bodyNFD);
  });
});

// ─── M10: keyword truncation by code points ───────────────────────────────────

describe('M10: keyword truncation by code points', () => {
  it('keyword with 41 ASCII chars is truncated to 40', () => {
    const longKw = 'a'.repeat(41);
    const content = ['---', `keywords: [${longKw}]`, '---', '', 'Body.'].join('\n');
    const meta = readNoteMetadata(content, 'test.md');
    expect(meta.keywords[0]?.length).toBe(40);
  });

  it('keyword with emoji: truncation counts emoji as one code point', () => {
    // Each emoji is 2 UTF-16 code units but 1 code point
    // Build a keyword with 38 ASCII chars + 2 emoji = 40 code points but 42 UTF-16 units
    const emoji = '🎯'; // 2 UTF-16 code units, 1 code point
    const kwWith40CodePoints = 'a'.repeat(38) + emoji + emoji; // 40 code points
    const kwWith41CodePoints = kwWith40CodePoints + emoji; // 41 code points

    const content = ['---', `keywords: ["${kwWith41CodePoints}"]`, '---', '', 'Body.'].join('\n');
    const meta = readNoteMetadata(content, 'test.md');
    const result = meta.keywords[0] ?? '';
    // Should be truncated to 40 code points
    expect([...result].length).toBe(40);
    // UTF-16 length would be 40 (38 ascii + 2 emoji × 2 units = 42) — not 40
    // So the truncation was by code points, not .length
    expect([...result].length).toBe(40);
    expect(result).toBe(kwWith40CodePoints);
  });
});
