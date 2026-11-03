/**
 * Test 2 — vocabulary (CHAMBA-016 ola 1)
 *
 * Covers: 3-level tree, missing parent (clear error), duplicate alias,
 * invalid slug, depth > 4, thresholds from frontmatter, generar_bases,
 * resolveTopic (alias→canonical, unknown+suggestions), determinism.
 */
import { describe, expect, it } from 'vitest';
import {
  ancestors,
  children,
  editDistance,
  emptyVocabularyTemplate,
  parseVocabulary,
  resolveTopic,
} from './vocabulary.js';

// ─── Fixture ──────────────────────────────────────────────────────────────────

const BASIC_VOCAB = [
  '---',
  'title: "Vocabulario de temas"',
  'source: human',
  'umbral_promover: 5',
  'umbral_dividir: 30',
  'generar_bases: true',
  '---',
  '# Vocabulario de temas',
  '',
  '- `lms` — LMS de Lapzo. Alias: plataforma',
  '  - `lms/cursos` — Cursos y su ciclo de vida.',
  '    - `lms/cursos/creacion` — Alta de cursos, módulos y lecciones. Alias: crear-cursos',
  '    - `lms/cursos/gestion` — Edición, publicación, archivado.',
  '  - `lms/gamificacion` — Puntos, insignias, rankings. Alias: gamification',
  '- `soporte` — Bugs y tareas de soporte.',
].join('\n');

// ─── parseVocabulary ─────────────────────────────────────────────────────────

describe('parseVocabulary', () => {
  it('parses a valid 3-level tree without errors', () => {
    const { vocabulary, errors } = parseVocabulary(BASIC_VOCAB);

    // Only INDENT_MISMATCH warnings are acceptable for now (none expected with 2-space indent)
    const blocking = errors.filter((e) => e.code !== 'INDENT_MISMATCH');
    expect(blocking).toHaveLength(0);

    expect(vocabulary.nodes.size).toBe(6);
    expect(vocabulary.nodes.has('lms')).toBe(true);
    expect(vocabulary.nodes.has('lms/cursos')).toBe(true);
    expect(vocabulary.nodes.has('lms/cursos/creacion')).toBe(true);
    expect(vocabulary.nodes.has('lms/cursos/gestion')).toBe(true);
    expect(vocabulary.nodes.has('lms/gamificacion')).toBe(true);
    expect(vocabulary.nodes.has('soporte')).toBe(true);
  });

  it('reads correct node metadata', () => {
    const { vocabulary } = parseVocabulary(BASIC_VOCAB);

    const lms = vocabulary.nodes.get('lms');
    expect(lms).toBeDefined();
    expect(lms?.description).toBe('LMS de Lapzo');
    expect(lms?.aliases).toEqual(['plataforma']);
    expect(lms?.parent).toBeNull();

    const cursos = vocabulary.nodes.get('lms/cursos');
    expect(cursos).toBeDefined();
    expect(cursos?.parent).toBe('lms');
    expect(cursos?.aliases).toEqual([]);

    const creacion = vocabulary.nodes.get('lms/cursos/creacion');
    expect(creacion).toBeDefined();
    expect(creacion?.aliases).toEqual(['crear-cursos']);
    expect(creacion?.parent).toBe('lms/cursos');
  });

  it('reads thresholds and generar_bases from frontmatter', () => {
    const { vocabulary } = parseVocabulary(BASIC_VOCAB);

    expect(vocabulary.umbral_promover).toBe(5);
    expect(vocabulary.umbral_dividir).toBe(30);
    expect(vocabulary.generar_bases).toBe(true);
  });

  it('uses default thresholds when frontmatter is absent', () => {
    const minimal = '- `lms` — LMS.\n';
    const { vocabulary } = parseVocabulary(minimal);

    expect(vocabulary.umbral_promover).toBe(3);
    expect(vocabulary.umbral_dividir).toBe(25);
    expect(vocabulary.generar_bases).toBe(true);
  });

  it('respects generar_bases: false', () => {
    const content = ['---', 'generar_bases: false', '---', '- `lms` — LMS.'].join('\n');

    const { vocabulary } = parseVocabulary(content);
    expect(vocabulary.generar_bases).toBe(false);
  });

  it('reports MISSING_PARENT with a clear message when parent not declared', () => {
    const content = [
      '---',
      '---',
      '- `lms` — LMS.',
      '  - `lms/cursos/gestion` — Gestión.', // parent lms/cursos not declared
    ].join('\n');

    const { vocabulary, errors } = parseVocabulary(content);

    const err = errors.find((e) => e.code === 'MISSING_PARENT');
    expect(err).toBeDefined();
    expect(err?.message).toContain('lms/cursos');
    expect(err?.path).toBe('lms/cursos/gestion');

    // The invalid node is excluded
    expect(vocabulary.nodes.has('lms/cursos/gestion')).toBe(false);
    // Valid nodes still present
    expect(vocabulary.nodes.has('lms')).toBe(true);
  });

  it('reports DUPLICATE_ALIAS when two nodes share an alias', () => {
    const content = [
      '---',
      '---',
      '- `lms` — LMS. Alias: plataforma',
      '- `soporte` — Soporte. Alias: plataforma', // same alias
    ].join('\n');

    const { errors } = parseVocabulary(content);

    const err = errors.find((e) => e.code === 'DUPLICATE_ALIAS');
    expect(err).toBeDefined();
    expect(err?.message).toContain('plataforma');
  });

  it('reports DUPLICATE_ALIAS when an alias clashes with another node slug', () => {
    const content = [
      '---',
      '---',
      '- `lms` — LMS.',
      '- `soporte` — Soporte. Alias: lms', // alias = slug of another node
    ].join('\n');

    const { errors } = parseVocabulary(content);

    const err = errors.find((e) => e.code === 'DUPLICATE_ALIAS');
    expect(err).toBeDefined();
  });

  it('reports INVALID_SEGMENT for paths with uppercase or special chars', () => {
    const badPaths = [
      '- `LMS` — Uppercase.',
      '- `my_topic` — Underscore.',
      '- `my topic` — Space.',
      '- `my.topic` — Dot.',
    ];

    for (const line of badPaths) {
      const { errors } = parseVocabulary(line);
      const err = errors.find((e) => e.code === 'INVALID_SEGMENT');
      expect(err, `Expected INVALID_SEGMENT for: ${line}`).toBeDefined();
    }
  });

  it('reports DEPTH_EXCEEDED for paths with more than 4 levels', () => {
    const content = [
      '---',
      '---',
      '- `a` — A.',
      '  - `a/b` — B.',
      '    - `a/b/c` — C.',
      '      - `a/b/c/d` — D.', // depth 4 — OK
      '        - `a/b/c/d/e` — E.', // depth 5 — INVALID
    ].join('\n');

    const { vocabulary, errors } = parseVocabulary(content);

    const depthErr = errors.find((e) => e.code === 'DEPTH_EXCEEDED');
    expect(depthErr).toBeDefined();
    expect(depthErr?.path).toBe('a/b/c/d/e');

    // Depth 4 is valid
    expect(vocabulary.nodes.has('a/b/c/d')).toBe(true);
    // Depth 5 excluded
    expect(vocabulary.nodes.has('a/b/c/d/e')).toBe(false);
  });

  it('reports DUPLICATE_PATH for the same path declared twice', () => {
    const content = ['---', '---', '- `lms` — First.', '- `lms` — Second.'].join('\n');

    const { errors } = parseVocabulary(content);
    const err = errors.find((e) => e.code === 'DUPLICATE_PATH');
    expect(err).toBeDefined();
    expect(err?.path).toBe('lms');
  });

  it('accepts valid path patterns including hyphens', () => {
    const content = [
      '---',
      '---',
      '- `my-area` — With hyphen.',
      '  - `my-area/sub-topic` — Hyphenated sub.',
      '    - `my-area/sub-topic/a1b2` — Alphanumeric.',
    ].join('\n');

    const { vocabulary, errors } = parseVocabulary(content);
    const blocking = errors.filter((e) => e.code !== 'INDENT_MISMATCH');
    expect(blocking).toHaveLength(0);
    expect(vocabulary.nodes.size).toBe(3);
  });

  it('is deterministic: same input → same output', () => {
    const { vocabulary: v1, errors: e1 } = parseVocabulary(BASIC_VOCAB);
    const { vocabulary: v2, errors: e2 } = parseVocabulary(BASIC_VOCAB);

    expect(v1.nodes.size).toBe(v2.nodes.size);
    expect(e1.length).toBe(e2.length);
    expect([...v1.nodes.keys()].sort()).toEqual([...v2.nodes.keys()].sort());
  });
});

// ─── resolveTopic ─────────────────────────────────────────────────────────────

describe('resolveTopic', () => {
  it('resolves an exact path', () => {
    const { vocabulary } = parseVocabulary(BASIC_VOCAB);
    const result = resolveTopic(vocabulary, 'lms/cursos');
    expect(result).toEqual({ path: 'lms/cursos' });
  });

  it('resolves an alias to its canonical path', () => {
    const { vocabulary } = parseVocabulary(BASIC_VOCAB);
    const result = resolveTopic(vocabulary, 'plataforma');
    expect(result).toEqual({ path: 'lms' });
  });

  it('resolves alias to canonical: crear-cursos → lms/cursos/creacion', () => {
    const { vocabulary } = parseVocabulary(BASIC_VOCAB);
    const result = resolveTopic(vocabulary, 'crear-cursos');
    expect(result).toEqual({ path: 'lms/cursos/creacion' });
  });

  it('strips leading tema/ prefix before resolving', () => {
    const { vocabulary } = parseVocabulary(BASIC_VOCAB);
    const result = resolveTopic(vocabulary, 'tema/lms');
    expect(result).toEqual({ path: 'lms' });
  });

  it('is case-insensitive', () => {
    const { vocabulary } = parseVocabulary(BASIC_VOCAB);
    const result = resolveTopic(vocabulary, 'LMS');
    expect(result).toEqual({ path: 'lms' });
  });

  it('returns unknown with suggestions for close misses', () => {
    const { vocabulary } = parseVocabulary(BASIC_VOCAB);
    // 'lmss' is edit distance 1 from 'lms'
    const result = resolveTopic(vocabulary, 'lmss');
    expect('unknown' in result).toBe(true);
    if ('unknown' in result) {
      expect(result.unknown).toBe('lmss');
      expect(result.suggestions).toContain('lms');
    }
  });

  it('returns empty suggestions when no close match exists', () => {
    const { vocabulary } = parseVocabulary(BASIC_VOCAB);
    const result = resolveTopic(vocabulary, 'completelydifferent');
    expect('unknown' in result).toBe(true);
    if ('unknown' in result) {
      expect(result.suggestions).toHaveLength(0);
    }
  });
});

// ─── ancestors ───────────────────────────────────────────────────────────────

describe('ancestors', () => {
  it('returns empty array for root nodes', () => {
    expect(ancestors('lms')).toEqual([]);
  });

  it('returns one ancestor for depth-2 paths', () => {
    expect(ancestors('lms/cursos')).toEqual(['lms']);
  });

  it('returns two ancestors for depth-3 paths', () => {
    expect(ancestors('lms/cursos/creacion')).toEqual(['lms', 'lms/cursos']);
  });

  it('returns three ancestors for depth-4 paths', () => {
    expect(ancestors('a/b/c/d')).toEqual(['a', 'a/b', 'a/b/c']);
  });
});

// ─── children ────────────────────────────────────────────────────────────────

describe('children', () => {
  it('returns direct children of a node', () => {
    const { vocabulary } = parseVocabulary(BASIC_VOCAB);
    expect(children(vocabulary, 'lms').sort()).toEqual(['lms/cursos', 'lms/gamificacion']);
    expect(children(vocabulary, 'lms/cursos').sort()).toEqual([
      'lms/cursos/creacion',
      'lms/cursos/gestion',
    ]);
  });

  it('returns empty array for leaf nodes', () => {
    const { vocabulary } = parseVocabulary(BASIC_VOCAB);
    expect(children(vocabulary, 'lms/cursos/creacion')).toEqual([]);
  });

  it('returns empty array for non-existent paths', () => {
    const { vocabulary } = parseVocabulary(BASIC_VOCAB);
    expect(children(vocabulary, 'no-existe')).toEqual([]);
  });
});

// ─── editDistance ─────────────────────────────────────────────────────────────

describe('editDistance', () => {
  it('returns 0 for equal strings', () => {
    expect(editDistance('lms', 'lms')).toBe(0);
  });

  it('returns 1 for a single substitution', () => {
    expect(editDistance('lms', 'lmx')).toBe(1);
  });

  it('returns 1 for a single insertion', () => {
    expect(editDistance('lms', 'lmss')).toBe(1);
  });

  it('returns 1 for a single deletion', () => {
    expect(editDistance('lmss', 'lms')).toBe(1);
  });

  it('handles empty strings', () => {
    expect(editDistance('', 'abc')).toBe(3);
    expect(editDistance('abc', '')).toBe(3);
    expect(editDistance('', '')).toBe(0);
  });
});

// ─── emptyVocabularyTemplate ─────────────────────────────────────────────────

describe('emptyVocabularyTemplate', () => {
  it('produces valid frontmatter with default thresholds', () => {
    const tmpl = emptyVocabularyTemplate();
    expect(tmpl).toContain('umbral_promover: 3');
    expect(tmpl).toContain('umbral_dividir: 25');
    expect(tmpl).toContain('generar_bases: true');
    expect(tmpl).toContain('source: human');
  });

  it('is parseable by parseVocabulary with no errors', () => {
    const tmpl = emptyVocabularyTemplate();
    const { vocabulary, errors } = parseVocabulary(tmpl);
    const blocking = errors.filter((e) => e.code !== 'INDENT_MISMATCH');
    expect(blocking).toHaveLength(0);
    expect(vocabulary.nodes.size).toBe(0);
  });

  it('contains instructions without inventing topics', () => {
    const tmpl = emptyVocabularyTemplate();
    // Should contain instructions but NO entry lines (backtick-path format)
    const lines = tmpl.split('\n').filter((l) => /^- `[a-z]/.test(l));
    expect(lines).toHaveLength(0);
  });

  it('is deterministic', () => {
    expect(emptyVocabularyTemplate()).toBe(emptyVocabularyTemplate());
  });
});

// ─── M12: non-integer umbral uses default and reports error ──────────────────

describe('M12: non-integer umbral uses default', () => {
  it('umbral_promover: 3.5 uses default 3 and reports error', () => {
    const content = [
      '---',
      'title: "Vocabulario"',
      'source: human',
      'umbral_promover: 3.5',
      'umbral_dividir: 25',
      '---',
      '# Vocabulario',
      '- `test` — Test.',
    ].join('\n');

    const result = parseVocabulary(content);
    // Should use the default value for umbral_promover
    expect(result.vocabulary.umbral_promover).toBe(3);
    // Should report an error
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.message.includes('umbral_promover'))).toBe(true);
  });

  it('umbral_dividir: 25.5 uses default 25 and reports error', () => {
    const content = [
      '---',
      'title: "Vocabulario"',
      'source: human',
      'umbral_promover: 3',
      'umbral_dividir: 25.5',
      '---',
      '# Vocabulario',
      '- `test` — Test.',
    ].join('\n');

    const result = parseVocabulary(content);
    expect(result.vocabulary.umbral_dividir).toBe(25);
    expect(result.errors.some((e) => e.message.includes('umbral_dividir'))).toBe(true);
  });

  it('valid integer umbral parses without error', () => {
    const content = [
      '---',
      'title: "Vocabulario"',
      'source: human',
      'umbral_promover: 5',
      'umbral_dividir: 30',
      '---',
      '# Vocabulario',
      '- `test` — Test.',
    ].join('\n');

    const result = parseVocabulary(content);
    expect(result.vocabulary.umbral_promover).toBe(5);
    expect(result.vocabulary.umbral_dividir).toBe(30);
    // No frontmatter errors
    expect(result.errors.filter((e) => e.message.includes('umbral'))).toHaveLength(0);
  });
});
