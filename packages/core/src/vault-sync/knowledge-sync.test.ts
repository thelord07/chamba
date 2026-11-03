/**
 * knowledge-sync.test.ts — Tests for CHAMBA-016 OLA 4: derived-path conflict
 * resolution in vault-sync (test 11 a/b/c/d + Windows interaction).
 *
 * Portable: no node: imports, uses FakeParche + MemoryFilesystem.
 */

import { describe, expect, it } from 'vitest';
import { VaultReindexer } from '../obsidian/knowledge/reindexer.js';
import type { ClockPort } from '../ports/clock.js';
import { FakeHash } from '../testing/fake-hash.js';
import { FakeParche } from '../testing/fake-parche.js';
import { MemoryFilesystem } from '../testing/memory-filesystem.js';
import { syncOnce } from './runner.js';
import { writeState } from './state-store.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const VAULT = '/vault';
const SERVER = 'https://parche.example.com';
const SLUG = 'test-knowledge';

function makeClock(iso = '2026-10-29T12:00:00Z'): ClockPort {
  return {
    now: () => new Date(iso),
    today: () => iso.slice(0, 10),
    sleep: () => Promise.resolve(),
  };
}

function setupGroup(parche: FakeParche) {
  const group = parche.seedGroup({ slug: SLUG, name: 'Knowledge Group' });
  parche.addInvite({ code: 'KN01-0001', groupId: group.id, role: 'editor' });
  return group;
}

function makeToken(
  parche: FakeParche,
  group: ReturnType<FakeParche['seedGroup']>,
  label = 'laptop',
) {
  const userId = `usr-${label}`;
  return parche.addDevice(group.id, { userId, label, role: 'editor' });
}

function makeSyncOpts(token: string, author = 'joys', device = 'laptop') {
  return {
    vaultDir: VAULT,
    server: SERVER,
    slug: SLUG,
    token,
    localAuthor: author,
    device,
  };
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Generated INDEX.md content (source: chamba + generated: true). */
function makeGeneratedIndex(title: string): string {
  return [
    '---',
    `title: "${title}"`,
    'source: chamba',
    'generated: true',
    '---',
    '',
    '> Generado por chamba desde los metadatos de las notas. No editar.',
    '',
    `# ${title}`,
  ].join('\n');
}

/** Generated hub content (temas/*.md). */
function makeGeneratedHub(slug: string): string {
  return [
    '---',
    `title: "Hub ${slug}"`,
    'source: chamba',
    'generated: true',
    '---',
    '',
    '> Generado por chamba. No editar.',
  ].join('\n');
}

/** Generated .base content. */
function makeGeneratedBase(name: string): string {
  return [
    '# generated: true',
    `# source: chamba`,
    `# Base: ${name}`,
    'filter: file.hasTag("tema/x")',
    'columns: [file.name, type, summary]',
  ].join('\n');
}

/** Manual INDEX.md (no source: chamba). */
function makeManualIndex(title: string): string {
  return ['---', `title: "${title}"`, '---', '', `# ${title}`, '', '- nota manual aquí'].join('\n');
}

/**
 * Run syncOnce and then reindex if needsReindex (simulates what callers do).
 * Returns the sync summary.
 */
async function syncAndReindex(
  parche: FakeParche,
  fs: MemoryFilesystem,
  hash: FakeHash,
  token: string,
  author = 'joys',
  device = 'laptop',
) {
  const deps = { fs, http: parche, hash, clock: makeClock() };
  const summary = await syncOnce(deps, makeSyncOpts(token, author, device));
  if (summary.needsReindex) {
    await new VaultReindexer(fs, VAULT).reindex();
  }
  return summary;
}

// ─── All files in a MemoryFilesystem (for convergence comparison) ─────────────

async function allVaultFiles(
  fs: MemoryFilesystem,
  vaultDir: string,
  hash: FakeHash,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const SKIP = new Set(['.chamba-sync', '.trash', '.obsidian']);

  async function walk(dir: string, rel: string) {
    let entries: Awaited<ReturnType<MemoryFilesystem['readDir']>>;
    try {
      entries = await fs.readDir(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const childAbs = `${dir}/${e.name}`;
      if (e.isDirectory) {
        if (!SKIP.has(e.name)) await walk(childAbs, childRel);
      } else if (e.isFile) {
        const bytes = await fs.readBytes(childAbs);
        const h = await hash.sha256(bytes);
        result.set(childRel, h);
      }
    }
  }

  await walk(vaultDir, '');
  return result;
}

// ─── Test 11a: derived conflict resolved silently ─────────────────────────────

describe('Test 11a — derived conflicts accepted without copy', () => {
  it('conflict on hub temas/x.md, proyectos/INDEX.md (generated), and temas/x.base → no copy, needsReindex, derivedConflictsResolved', async () => {
    const parche = new FakeParche(makeClock());
    const group = setupGroup(parche);
    const hash = new FakeHash();
    const fs = new MemoryFilesystem();
    const token = makeToken(parche, group);

    // Base blobs (common ancestor)
    const baseTema = enc.encode(makeGeneratedHub('x-old'));
    const baseTemaHash = await hash.sha256(baseTema);
    const baseIndex = enc.encode(makeGeneratedIndex('Index old'));
    const baseIndexHash = await hash.sha256(baseIndex);
    const baseBase = enc.encode(makeGeneratedBase('x-old'));
    const baseBaseHash = await hash.sha256(baseBase);

    // Local files (chamba-generated, differ from base)
    const localTema = enc.encode(makeGeneratedHub('x-local'));
    const localIndex = enc.encode(makeGeneratedIndex('Index local'));
    const localBase = enc.encode(makeGeneratedBase('x-local'));

    // Remote blobs (different from both base and local)
    const remoteTema = enc.encode(makeGeneratedHub('x-remote'));
    const remoteTemaHash = await hash.sha256(remoteTema);
    const remoteIndex = enc.encode(makeGeneratedIndex('Index remote'));
    const remoteIndexHash = await hash.sha256(remoteIndex);
    const remoteBase = enc.encode(makeGeneratedBase('x-remote'));
    const remoteBaseHash = await hash.sha256(remoteBase);

    // Seed local files
    await fs.writeBytes(`${VAULT}/temas/x.md`, localTema);
    await fs.writeBytes(`${VAULT}/proyectos/INDEX.md`, localIndex);
    await fs.writeBytes(`${VAULT}/temas/x.base`, localBase);

    // State: all three were synced at the base hash
    await writeState(fs, VAULT, {
      server: SERVER,
      slug: SLUG,
      cursor: 0,
      files: {
        'temas/x.md': { syncedHash: baseTemaHash },
        'proyectos/INDEX.md': { syncedHash: baseIndexHash },
        'temas/x.base': { syncedHash: baseBaseHash },
      },
    });

    // Seed remote blobs
    parche.seedBlob(group.id, remoteTemaHash, remoteTema);
    parche.seedBlob(group.id, remoteIndexHash, remoteIndex);
    parche.seedBlob(group.id, remoteBaseHash, remoteBase);

    // Remote changes
    parche.seedChange(group.id, {
      path: 'temas/x.md',
      hash: remoteTemaHash,
      author: 'other',
      device: 'other-laptop',
      at: '2026-10-29T10:01:00Z',
    });
    parche.seedChange(group.id, {
      path: 'proyectos/INDEX.md',
      hash: remoteIndexHash,
      author: 'other',
      device: 'other-laptop',
      at: '2026-10-29T10:01:00Z',
    });
    parche.seedChange(group.id, {
      path: 'temas/x.base',
      hash: remoteBaseHash,
      author: 'other',
      device: 'other-laptop',
      at: '2026-10-29T10:01:00Z',
    });

    const deps = { fs, http: parche, hash, clock: makeClock() };
    const summary = await syncOnce(deps, makeSyncOpts(token));

    // No conflict copies created
    expect(summary.conflicts).toHaveLength(0);

    // Files on disk = remote versions
    const temaBytes = await fs.readBytes(`${VAULT}/temas/x.md`);
    expect(dec.decode(temaBytes)).toBe(makeGeneratedHub('x-remote'));

    const indexBytes = await fs.readBytes(`${VAULT}/proyectos/INDEX.md`);
    expect(dec.decode(indexBytes)).toBe(makeGeneratedIndex('Index remote'));

    const baseBytes = await fs.readBytes(`${VAULT}/temas/x.base`);
    expect(dec.decode(baseBytes)).toBe(makeGeneratedBase('x-remote'));

    // needsReindex = true
    expect(summary.needsReindex).toBe(true);

    // derivedConflictsResolved lists all three (sorted alphabetically by plan)
    const resolved = summary.derivedConflictsResolved ?? [];
    expect(resolved).toHaveLength(3);
    expect(resolved).toContain('temas/x.md');
    expect(resolved).toContain('proyectos/INDEX.md');
    expect(resolved).toContain('temas/x.base');

    // No files with "conflict" or "conflicto" in name
    const allFiles = await allVaultFiles(fs, VAULT, hash);
    for (const path of allFiles.keys()) {
      expect(path.toLowerCase()).not.toContain('conflict');
      expect(path.toLowerCase()).not.toContain('conflicto');
    }
  });
});

// ─── Test 11b: VOCABULARIO.md → normal conflict ───────────────────────────────

describe('Test 11b — VOCABULARIO.md conflict follows normal flow (copy)', () => {
  it('conflict on temas/VOCABULARIO.md → copy created normally', async () => {
    const parche = new FakeParche(makeClock());
    const group = setupGroup(parche);
    const hash = new FakeHash();
    const fs = new MemoryFilesystem();
    const token = makeToken(parche, group);

    const baseVocab = enc.encode('---\ntitle: "Vocabulario"\nsource: human\n---\n- `x`\n');
    const baseHash = await hash.sha256(baseVocab);
    const localVocab = enc.encode(
      '---\ntitle: "Vocabulario"\nsource: human\n---\n- `x`\n- `y-local`\n',
    );
    const remoteVocab = enc.encode(
      '---\ntitle: "Vocabulario"\nsource: human\n---\n- `x`\n- `y-remote`\n',
    );
    const remoteHash = await hash.sha256(remoteVocab);

    await fs.writeBytes(`${VAULT}/temas/VOCABULARIO.md`, localVocab);
    await writeState(fs, VAULT, {
      server: SERVER,
      slug: SLUG,
      cursor: 0,
      files: { 'temas/VOCABULARIO.md': { syncedHash: baseHash } },
    });

    parche.seedBlob(group.id, remoteHash, remoteVocab);
    parche.seedChange(group.id, {
      path: 'temas/VOCABULARIO.md',
      hash: remoteHash,
      author: 'other',
      device: 'other-laptop',
      at: '2026-10-29T10:01:00Z',
    });

    const deps = { fs, http: parche, hash, clock: makeClock() };
    const summary = await syncOnce(deps, makeSyncOpts(token));

    // Normal conflict: copy was created
    expect(summary.conflicts).toHaveLength(1);
    expect(summary.conflicts[0]?.path).toBe('temas/VOCABULARIO.md');
    expect(summary.conflicts[0]?.copyPath).toContain('conflicto');

    // NOT in derivedConflictsResolved
    expect(summary.derivedConflictsResolved ?? []).not.toContain('temas/VOCABULARIO.md');

    // needsReindex = true (a .md conflict occurred)
    expect(summary.needsReindex).toBe(true);
  });
});

// ─── Test 11c: manual INDEX.md → normal conflict (AC4 bytes intact) ───────────

describe('Test 11c — manual INDEX.md conflict follows normal flow (human file protected)', () => {
  it('proyectos/INDEX.md manual (no source:chamba) → copy, local untouched', async () => {
    const parche = new FakeParche(makeClock());
    const group = setupGroup(parche);
    const hash = new FakeHash();
    const fs = new MemoryFilesystem();
    const token = makeToken(parche, group);

    const baseContent = enc.encode(makeManualIndex('Proyectos manual'));
    const baseHash = await hash.sha256(baseContent);
    const localContent = enc.encode(makeManualIndex('Proyectos manual editado'));
    // Remote is a generated version (but local is manual → should NOT be auto-resolved)
    const remoteContent = enc.encode(makeGeneratedIndex('Proyectos generado'));
    const remoteHash = await hash.sha256(remoteContent);

    await fs.writeBytes(`${VAULT}/proyectos/INDEX.md`, localContent);
    await writeState(fs, VAULT, {
      server: SERVER,
      slug: SLUG,
      cursor: 0,
      files: { 'proyectos/INDEX.md': { syncedHash: baseHash } },
    });

    parche.seedBlob(group.id, remoteHash, remoteContent);
    parche.seedChange(group.id, {
      path: 'proyectos/INDEX.md',
      hash: remoteHash,
      author: 'other',
      device: 'other-laptop',
      at: '2026-10-29T10:01:00Z',
    });

    const deps = { fs, http: parche, hash, clock: makeClock() };
    const summary = await syncOnce(deps, makeSyncOpts(token));

    // Normal conflict: copy was created
    expect(summary.conflicts).toHaveLength(1);
    expect(summary.conflicts[0]?.path).toBe('proyectos/INDEX.md');

    // The copy path contains the conflict marker
    const copyPath = summary.conflicts[0]?.copyPath ?? '';
    expect(copyPath).toContain('conflicto');

    // NOT in derivedConflictsResolved
    expect(summary.derivedConflictsResolved ?? []).not.toContain('proyectos/INDEX.md');

    // The copy content should be the local bytes (byte-for-byte, AC4)
    const copyBytes = await fs.readBytes(`${VAULT}/${copyPath}`);
    // The copy is the local content with conflict frontmatter prepended (for .md)
    // The raw local text should appear in the copy
    const copyText = dec.decode(copyBytes);
    expect(copyText).toContain('Proyectos manual editado');
  });
});

// ─── Test 11d: convergence of two clients ─────────────────────────────────────

describe('Test 11d — two-client convergence (no copies, point-fix in ≤ 3 rounds)', () => {
  it('A writes N1, B writes N2; both reindex; converge in ≤ 3 rounds each with identical bytes', async () => {
    const clock = makeClock();
    const parche = new FakeParche(clock);
    const group = setupGroup(parche);
    const hashA = new FakeHash();
    const hashB = new FakeHash();
    const fsA = new MemoryFilesystem();
    const fsB = new MemoryFilesystem();

    const tokenA = makeToken(parche, group, 'laptop-a');
    const tokenB = makeToken(parche, group, 'laptop-b');

    // A writes nota-a.md (no tema → sin clasificar)
    const notaA = '---\ntitle: "Nota A"\nsource: chamba\n---\nContenido de nota A.\n';
    await fsA.writeBytes(`${VAULT}/nota-a.md`, enc.encode(notaA));

    // B writes nota-b.md (no tema → sin clasificar)
    const notaB = '---\ntitle: "Nota B"\nsource: chamba\n---\nContenido de nota B.\n';
    await fsB.writeBytes(`${VAULT}/nota-b.md`, enc.encode(notaB));

    // Both reindex locally before sync
    await new VaultReindexer(fsA, VAULT).reindex();
    await new VaultReindexer(fsB, VAULT).reindex();

    // Helper: sync + reindex if needed
    async function roundA() {
      return syncAndReindex(parche, fsA, hashA, tokenA, 'joys-a', 'laptop-a');
    }
    async function roundB() {
      return syncAndReindex(parche, fsB, hashB, tokenB, 'joys-b', 'laptop-b');
    }

    // Run ≤ 3 rounds alternating (A1, B1, A2, B2, A3, B3)
    const summaries: Array<{ client: 'A' | 'B'; pushed: number; pulled: number }> = [];
    for (let round = 0; round < 3; round++) {
      const sA = await roundA();
      summaries.push({ client: 'A', pushed: sA.pushed, pulled: sA.pulled });
      const sB = await roundB();
      summaries.push({ client: 'B', pushed: sB.pushed, pulled: sB.pulled });
    }

    // Check convergence: both vaults have identical files
    const mapA = await allVaultFiles(fsA, VAULT, hashA);
    const mapB = await allVaultFiles(fsB, VAULT, hashB);

    // Both must have the same set of paths
    const pathsA = new Set(mapA.keys());
    const pathsB = new Set(mapB.keys());
    expect(pathsA).toEqual(pathsB);

    // Same bytes for all paths
    for (const [path, hA] of mapA) {
      const hB = mapB.get(path);
      expect(hB).toBe(hA);
    }

    // No conflict copies in either vault
    for (const path of mapA.keys()) {
      expect(path.toLowerCase()).not.toContain('conflicto');
      expect(path.toLowerCase()).not.toContain('conflict');
    }

    // Both vaults have nota-a and nota-b
    expect(mapA.has('nota-a.md')).toBe(true);
    expect(mapA.has('nota-b.md')).toBe(true);

    // Point-fix: extra round produces no pushes and no writes
    const extraA = await syncOnce(
      { fs: fsA, http: parche, hash: hashA, clock },
      {
        vaultDir: VAULT,
        server: SERVER,
        slug: SLUG,
        token: tokenA,
        localAuthor: 'joys-a',
        device: 'laptop-a',
      },
    );
    expect(extraA.pushed).toBe(0);
    expect(extraA.pulled).toBe(0);

    const extraB = await syncOnce(
      { fs: fsB, http: parche, hash: hashB, clock },
      {
        vaultDir: VAULT,
        server: SERVER,
        slug: SLUG,
        token: tokenB,
        localAuthor: 'joys-b',
        device: 'laptop-b',
      },
    );
    expect(extraB.pushed).toBe(0);
    expect(extraB.pulled).toBe(0);
  });

  it('cross-client: A pushes note + derived files; B has own note and reindexes before receiving → converge', async () => {
    const clock = makeClock();
    const parche = new FakeParche(clock);
    const group = setupGroup(parche);
    const hashA = new FakeHash();
    const hashB = new FakeHash();
    const fsA = new MemoryFilesystem();
    const fsB = new MemoryFilesystem();

    const tokenA = makeToken(parche, group, 'cross-a');
    const tokenB = makeToken(parche, group, 'cross-b');

    // A writes and syncs first
    const notaA = '---\ntitle: "Nota A"\nsource: chamba\n---\nNota de A.\n';
    await fsA.writeBytes(`${VAULT}/nota-a.md`, enc.encode(notaA));
    await new VaultReindexer(fsA, VAULT).reindex();

    // A sync 1: push nota-a + derived files
    await syncAndReindex(parche, fsA, hashA, tokenA, 'joys-a', 'cross-a');

    // B writes nota-b and reindexes BEFORE syncing (has local-only derived files)
    const notaB = '---\ntitle: "Nota B"\nsource: chamba\n---\nNota de B.\n';
    await fsB.writeBytes(`${VAULT}/nota-b.md`, enc.encode(notaB));
    await new VaultReindexer(fsB, VAULT).reindex();

    // B sync 1: push nota-b + B's derived files, pull A's note + A's derived (conflict on derived)
    await syncAndReindex(parche, fsB, hashB, tokenB, 'joys-b', 'cross-b');

    // A sync 2: pull B's note + B's derived (conflict on derived)
    await syncAndReindex(parche, fsA, hashA, tokenA, 'joys-a', 'cross-a');

    // A sync 3: push A's new derived (from reindex after sync 2)
    await syncAndReindex(parche, fsA, hashA, tokenA, 'joys-a', 'cross-a');

    // B sync 2: pull latest
    await syncAndReindex(parche, fsB, hashB, tokenB, 'joys-b', 'cross-b');

    // Check convergence
    const mapA = await allVaultFiles(fsA, VAULT, hashA);
    const mapB = await allVaultFiles(fsB, VAULT, hashB);

    const pathsA = new Set(mapA.keys());
    const pathsB = new Set(mapB.keys());
    expect(pathsA).toEqual(pathsB);

    for (const [path, hA] of mapA) {
      expect(mapB.get(path)).toBe(hA);
    }

    for (const path of mapA.keys()) {
      expect(path.toLowerCase()).not.toContain('conflicto');
      expect(path.toLowerCase()).not.toContain('conflict');
    }

    expect(mapA.has('nota-a.md')).toBe(true);
    expect(mapA.has('nota-b.md')).toBe(true);
  });
});

// ─── Windows interaction: invalid name in derived path ────────────────────────

describe('Windows interaction — invalid derived path skips gracefully', () => {
  it('derived remote with Windows-invalid name is skipped and does not break needsReindex for valid paths', async () => {
    const parche = new FakeParche(makeClock());
    const group = setupGroup(parche);
    const hash = new FakeHash();
    const fs = new MemoryFilesystem();
    const token = makeToken(parche, group);

    // An invalid Windows name (contains colon)
    const invalidName = 'temas/x:invalid.md';

    // For a CONFLICT to occur: local was modified since last sync (localHash ≠ baseHash) AND
    // remote also changed (remoteHash ≠ baseHash AND remoteHash ≠ localHash).
    const baseDerived = enc.encode(makeGeneratedHub('x-base'));
    const baseHash = await hash.sha256(baseDerived);

    const localDerived = enc.encode(makeGeneratedHub('x-local'));
    await fs.writeBytes(`${VAULT}/temas/x.md`, localDerived);

    // A valid derived file remote (different from both base and local → conflict)
    const validDerived = enc.encode(makeGeneratedHub('x-remote'));
    const validHash = await hash.sha256(validDerived);

    await writeState(fs, VAULT, {
      server: SERVER,
      slug: SLUG,
      cursor: 0,
      files: {
        // State records the BASE hash — local was modified since (localHash ≠ baseHash)
        'temas/x.md': { syncedHash: baseHash },
      },
    });

    // Seed valid remote
    parche.seedBlob(group.id, validHash, validDerived);
    parche.seedChange(group.id, {
      path: 'temas/x.md',
      hash: validHash,
      author: 'other',
      device: 'other-laptop',
      at: '2026-10-29T10:01:00Z',
    });

    // Seed invalid-name remote (write action — no local = write, not conflict)
    const invalidDerived = enc.encode(makeGeneratedHub('invalid'));
    const invalidHash = await hash.sha256(invalidDerived);
    parche.seedBlob(group.id, invalidHash, invalidDerived);
    parche.seedChange(group.id, {
      path: invalidName,
      hash: invalidHash,
      author: 'other',
      device: 'other-laptop',
      at: '2026-10-29T10:01:00Z',
    });

    const deps = { fs, http: parche, hash, clock: makeClock() };
    const summary = await syncOnce(deps, {
      vaultDir: VAULT,
      server: SERVER,
      slug: SLUG,
      token,
      localAuthor: 'joys',
      device: 'laptop',
      platform: 'win32',
    });

    // Valid derived conflict resolved silently
    expect(summary.derivedConflictsResolved ?? []).toContain('temas/x.md');
    // needsReindex true (valid derived was resolved)
    expect(summary.needsReindex).toBe(true);
    // Invalid name was skipped
    expect(summary.skippedInvalidNames ?? []).toContain(invalidName);
    // No conflict copies
    expect(summary.conflicts).toHaveLength(0);
  });
});
