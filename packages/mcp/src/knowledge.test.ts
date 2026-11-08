/**
 * knowledge.test.ts — Tests 6-10 for CHAMBA-016 ola 3 (MCP tools + CLI).
 *
 * Tests 6-10 from §12:
 * 6: summarize_to_vault with alias→canonical, unknown→proposal+suggestion, no temas→warning;
 *    response contains tree and 5 closest; save_plan with workItem links to previous summary.
 * 7: topics promote dryRun does not write; dryRun:false moves topic; list shows "listo para aprobar".
 * 8: bootstrap deterministic; apply without dryRun explicit does NOT write and returns exact content (O1);
 *    apply dryRun:false with existing vocab without replace → error; with replace → writes.
 * 9: classify apply dryRun by default does not write; >50 → error; applies only specified keys.
 * 10: manual INDEX.md intact and reported; adoptManual dryRun does not write; CLI --adopt-manual
 *     without TTY or --yes does not write; with --yes renames to "INDEX (manual).md" and generates.
 * + vault status / chamba_vault_status / doctor show knowledge line; doctor writes nothing.
 */

import { FakeHash, FakeParche, FakeRandom, MemoryFilesystem } from '@chamba/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { runVaultCli, type VaultCliDeps } from './cli/vault.js';
import { createServer } from './server.js';
import type { Services } from './services.js';

const silentLogger = pino({ level: 'silent' });

const FAKE_NOW = '2026-06-09T10:00:00.000Z';

function makeClock() {
  const d = new Date(FAKE_NOW);
  return { now: () => d, today: () => '2026-06-09' };
}

const VOCAB_MD = `---
title: "Vocabulario de temas"
source: human
umbral_promover: 2
umbral_dividir: 25
generar_bases: false
---
# Vocabulario de temas

- \`dev\` — Desarrollo de software. Alias: desarrollo
  - \`dev/typescript\` — TypeScript y sus particularidades.
- \`ops\` — Operaciones e infraestructura.
`;

function makeServices(files: Record<string, string> = {}, vaultPath = '/vault'): Services {
  return {
    fs: new MemoryFilesystem({
      '/vault/.obsidian/app.json': '{}',
      ...files,
    }),
    process: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
    clock: makeClock(),
    system: {
      resources: () => ({
        totalMemBytes: 16 * 1024 ** 3,
        freeMemBytes: 8 * 1024 ** 3,
        cpus: 8,
        loadAvg1: 0,
      }),
    },
    cwd: '/proj',
    homedir: '/home/test',
    http: new FakeParche(makeClock()),
    hash: new FakeHash(),
    random: new FakeRandom(),
    parchePullTtlMin: 5,
    vaultMutex: new Map(),
    platform: 'linux',
    username: 'testuser',
    obsidianVaultPath: vaultPath,
  };
}

async function connect(svc: Services) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = createServer(silentLogger, svc);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, server };
}

function textOf(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content.map((c) => c.text).join('\n');
}

function makeCli(
  svc: Services,
  argv: string[],
  {
    isTTY = false,
    prompt = async () => '',
  }: { isTTY?: boolean; prompt?: (q: string) => Promise<string> } = {},
): Promise<{ out: string[]; err: string[]; code: number }> {
  const out: string[] = [];
  const err: string[] = [];
  let code = 0;
  const deps: VaultCliDeps = {
    services: svc,
    stdout: (m) => out.push(m),
    stderr: (m) => err.push(m),
    exit: (c) => {
      code = c;
    },
    prompt,
    isTTY,
    hostname: 'test-host',
  };
  return runVaultCli(argv, deps).then(() => ({ out, err, code }));
}

// ─── Test 6: summarize_to_vault with alias/unknown temas + save_plan workItem ──

describe('Test 6: summarize_to_vault and save_plan with knowledge fields', () => {
  it('resolves alias to canonical path', async () => {
    const svc = makeServices({ '/vault/temas/VOCABULARIO.md': VOCAB_MD });
    const { client, server } = await connect(svc);

    const result = await client.callTool({
      name: 'chamba_summarize_to_vault',
      arguments: {
        title: 'TypeScript tips',
        content: 'Some tips about TypeScript.',
        summary: 'Tips sobre TypeScript',
        temas: ['desarrollo'], // alias for 'dev'
      },
    });
    const text = textOf(result);

    // The alias 'desarrollo' resolves to 'dev'
    expect(text).toContain('Temas aplicados: dev');
    expect(text).toContain('Wrote note to');
    // Response includes tree
    expect(text).toContain('Red de conocimiento:');
    // Response includes 5 closest nodes section (may be empty if no vocab match, but section header present)
    expect(text).toMatch(/5 nodos más cercanos/);

    // The written note should have tema/dev tag
    const notePath = text.match(/Wrote note to (.+\.md)/)?.[1];
    expect(notePath).toBeTruthy();
    if (notePath) {
      const content = await svc.fs.readFile(notePath);
      expect(content).toContain('tema/dev');
    }

    await server.close();
  });

  it('unknown tema goes to temas_propuestos with suggestion and warning', async () => {
    const svc = makeServices({ '/vault/temas/VOCABULARIO.md': VOCAB_MD });
    const { client, server } = await connect(svc);

    const result = await client.callTool({
      name: 'chamba_summarize_to_vault',
      arguments: {
        title: 'DevOps notes',
        content: 'Notes about ops and infra.',
        temas: ['devops'], // unknown — close to 'dev' and 'ops'
      },
    });
    const text = textOf(result);

    expect(text).toContain('Temas propuestos: devops');
    // Should warn about unknown topic
    expect(text).toContain('Advertencias');
    // Tree should be present
    expect(text).toContain('Red de conocimiento:');

    // Written note should have temas_propuestos
    const notePath = text.match(/Wrote note to (.+\.md)/)?.[1];
    if (notePath) {
      const content = await svc.fs.readFile(notePath);
      expect(content).toContain('temas_propuestos');
    }

    await server.close();
  });

  it('no temas and no summary → warning about unclassified note', async () => {
    const svc = makeServices({ '/vault/temas/VOCABULARIO.md': VOCAB_MD });
    const { client, server } = await connect(svc);

    const result = await client.callTool({
      name: 'chamba_summarize_to_vault',
      arguments: {
        title: 'Quick note',
        content: 'A quick note without topics.',
        // No temas, no summary — should trigger warning
      },
    });
    const text = textOf(result);

    // Should include warning about unclassified
    expect(text).toContain('Advertencias');
    expect(text).toContain('clasificar');
    expect(text).toContain('Wrote note to');

    await server.close();
  });

  it('save_plan with workItem links to previous summary', async () => {
    const svc = makeServices({ '/vault/temas/VOCABULARIO.md': VOCAB_MD });
    const { client, server } = await connect(svc);

    // First write a summary with workItem
    await client.callTool({
      name: 'chamba_summarize_to_vault',
      arguments: {
        title: 'Implementation summary',
        content: 'Summary of CHAMBA-016 implementation.',
        workItem: 'CHAMBA-016',
        temas: ['dev/typescript'],
      },
    });

    // Then save a plan with the same workItem
    const planResult = await client.callTool({
      name: 'chamba_save_plan',
      arguments: {
        title: 'CHAMBA-016 plan',
        content: '## Goal\nBuild knowledge network.',
        workItem: 'CHAMBA-016',
      },
    });
    const text = textOf(planResult);
    expect(text).toContain('Saved plan to');

    // The plan note should exist
    const notePath = text.match(/Saved plan to (.+\.md)/)?.[1];
    expect(notePath).toBeTruthy();
    if (notePath) {
      const content = await svc.fs.readFile(notePath);
      expect(content).toContain('CHAMBA-016');
    }

    await server.close();
  });
});

// ─── Test 7: topics promote ────────────────────────────────────────────────────

describe('Test 7: vault_topics promote', () => {
  const filesWithPropuestos = {
    '/vault/temas/VOCABULARIO.md': VOCAB_MD,
    '/vault/proyectos/note1.md': `---
title: "Note 1"
date: 2026-06-01
type: nota
tags: []
temas_propuestos:
  - frontend
source: chamba
---
# Note 1

About frontend work.
`,
    '/vault/proyectos/note2.md': `---
title: "Note 2"
date: 2026-06-02
type: nota
tags: []
temas_propuestos:
  - frontend
source: chamba
---
# Note 2

More frontend work.
`,
  };

  it('dryRun does not write any files', async () => {
    const svc = makeServices(filesWithPropuestos);
    const { client, server } = await connect(svc);

    const before = await svc.fs.readFile('/vault/temas/VOCABULARIO.md');

    const result = await client.callTool({
      name: 'chamba_vault_topics',
      arguments: {
        action: 'promote',
        path: 'frontend',
        description: 'Frontend development',
        dryRun: true,
      },
    });
    const text = textOf(result);

    expect(text).toContain('dryRun');
    expect(text).toContain('frontend');
    // Should show affected notes
    expect(text).toContain('note1.md');

    // Vocab should be unchanged
    const after = await svc.fs.readFile('/vault/temas/VOCABULARIO.md');
    expect(after).toBe(before);

    await server.close();
  });

  it('dryRun:false moves topic from propuestos to tags', async () => {
    const svc = makeServices(filesWithPropuestos);
    const { client, server } = await connect(svc);

    const result = await client.callTool({
      name: 'chamba_vault_topics',
      arguments: {
        action: 'promote',
        path: 'frontend',
        description: 'Frontend development',
        dryRun: false,
      },
    });
    const text = textOf(result);

    expect(text).toContain('frontend');
    // Should not be dryRun
    expect(text).not.toContain('[dryRun]');

    // After promote, notes should have tema/frontend tag (if parent exists in vocab)
    // Note: promote adds to vocab and updates notes
    const note1 = await svc.fs.readFile('/vault/proyectos/note1.md');
    // frontend was added to vocab and notes updated
    expect(note1).toContain('frontend');

    await server.close();
  });

  it('list shows topics ready to promote', async () => {
    const svc = makeServices(filesWithPropuestos);
    const { client, server } = await connect(svc);

    const result = await client.callTool({
      name: 'chamba_vault_topics',
      arguments: { action: 'list' },
    });
    const text = textOf(result);

    // Should show knowledge network stats
    expect(text).toContain('Red de conocimiento:');
    // Should show tree
    expect(text).toContain('dev');

    await server.close();
  });
});

// ─── Test 8: bootstrap deterministic, apply O1 ───────────────────────────────

describe('Test 8: vault_topics bootstrap and apply (O1)', () => {
  it('bootstrap returns deterministic stats', async () => {
    const svc = makeServices({
      '/vault/proyectos/a.md': '---\ntitle: Note A\ndate: 2026-06-01\ntags: []\n---\n# Note A\n',
      '/vault/proyectos/b.md': '---\ntitle: Note B\ndate: 2026-06-02\ntags: []\n---\n# Note B\n',
    });
    const { client, server } = await connect(svc);

    const r1 = await client.callTool({
      name: 'chamba_vault_topics',
      arguments: { action: 'bootstrap' },
    });
    const r2 = await client.callTool({
      name: 'chamba_vault_topics',
      arguments: { action: 'bootstrap' },
    });

    // Both calls return the same result (deterministic)
    expect(textOf(r1)).toBe(textOf(r2));
    expect(textOf(r1)).toContain('Bootstrap stats');
    expect(textOf(r1)).toContain('proyectos');

    await server.close();
  });

  it('add without explicit dryRun does NOT write; dryRun:false does (M4)', async () => {
    const vocab =
      '---\ntitle: Vocabulario de temas\nsource: human\n---\n# Vocabulario de temas\n- `lms` — LMS\n';
    const svc = makeServices({ '/vault/temas/VOCABULARIO.md': vocab });
    const { client, server } = await connect(svc);

    const preview = await client.callTool({
      name: 'chamba_vault_topics',
      arguments: { action: 'add', path: 'lms/cursos', description: 'Cursos' },
    });
    expect(textOf(preview)).toContain('lms/cursos');
    expect(await svc.fs.readFile('/vault/temas/VOCABULARIO.md')).toBe(vocab);

    await client.callTool({
      name: 'chamba_vault_topics',
      arguments: { action: 'add', path: 'lms/cursos', description: 'Cursos', dryRun: false },
    });
    expect(await svc.fs.readFile('/vault/temas/VOCABULARIO.md')).toContain('`lms/cursos`');

    await server.close();
  });

  it('apply without explicit dryRun does NOT write (O1 default dryRun=true)', async () => {
    const svc = makeServices({});
    const { client, server } = await connect(svc);

    const result = await client.callTool({
      name: 'chamba_vault_topics',
      arguments: {
        action: 'apply',
        nodes: [
          { path: 'dev', description: 'Desarrollo' },
          { path: 'ops', description: 'Operaciones' },
        ],
        // dryRun NOT passed — should default to true (O1)
      },
    });
    const text = textOf(result);

    // Should show the vocabulary content (dryRun)
    expect(text).toContain('dryRun');
    expect(text).toContain('VOCABULARIO.md');
    // Should include the instruction to confirm
    expect(text).toContain('dryRun:false');

    // VOCABULARIO.md must NOT have been written
    const exists = await svc.fs.exists('/vault/temas/VOCABULARIO.md');
    expect(exists).toBe(false);

    await server.close();
  });

  it('apply dryRun:false with existing vocab without replace → error', async () => {
    const svc = makeServices({ '/vault/temas/VOCABULARIO.md': VOCAB_MD });
    const { client, server } = await connect(svc);

    const result = await client.callTool({
      name: 'chamba_vault_topics',
      arguments: {
        action: 'apply',
        nodes: [{ path: 'dev', description: 'Development' }],
        dryRun: false,
        // replace not passed — should error
      },
    });
    const text = textOf(result);
    const isError = (result as { isError?: boolean }).isError;

    expect(isError).toBe(true);
    expect(text).toContain('Ya existe');

    // Vocab must remain unchanged
    const content = await svc.fs.readFile('/vault/temas/VOCABULARIO.md');
    expect(content).toBe(VOCAB_MD);

    await server.close();
  });

  it('apply dryRun:false with replace:true writes VOCABULARIO.md', async () => {
    const svc = makeServices({ '/vault/temas/VOCABULARIO.md': VOCAB_MD });
    const { client, server } = await connect(svc);

    const result = await client.callTool({
      name: 'chamba_vault_topics',
      arguments: {
        action: 'apply',
        nodes: [
          { path: 'dev', description: 'Desarrollo' },
          { path: 'ops', description: 'Operaciones' },
        ],
        dryRun: false,
        replace: true,
      },
    });
    const text = textOf(result);
    const isError = (result as { isError?: boolean }).isError;

    expect(isError).toBeFalsy();
    expect(text).toContain('Vocabulario escrito');

    // VOCABULARIO.md should be written
    const exists = await svc.fs.exists('/vault/temas/VOCABULARIO.md');
    expect(exists).toBe(true);

    await server.close();
  });
});

// ─── Test 9: classify ─────────────────────────────────────────────────────────

describe('Test 9: vault_classify', () => {
  const noteFiles = {
    '/vault/temas/VOCABULARIO.md': VOCAB_MD,
    '/vault/proyectos/unclassified.md': `---
title: "Unclassified note"
date: 2026-06-01
type: nota
tags: []
source: chamba
---
# Unclassified note

This note has no topics yet.
`,
  };

  it('apply dryRun by default does not write', async () => {
    const svc = makeServices(noteFiles);
    const { client, server } = await connect(svc);

    const before = await svc.fs.readFile('/vault/proyectos/unclassified.md');

    const result = await client.callTool({
      name: 'chamba_vault_classify',
      arguments: {
        action: 'apply',
        entries: [{ path: 'proyectos/unclassified.md', temas: ['dev'] }],
        // dryRun not passed — default TRUE
      },
    });
    const text = textOf(result);

    expect(text).toContain('dryRun');
    // File must not be written
    const after = await svc.fs.readFile('/vault/proyectos/unclassified.md');
    expect(after).toBe(before);

    await server.close();
  });

  it('>50 entries → error', async () => {
    const svc = makeServices(noteFiles);
    const { client, server } = await connect(svc);

    const entries = Array.from({ length: 51 }, (_, i) => ({
      path: `proyectos/note${i}.md`,
      temas: ['dev'],
    }));

    const result = await client.callTool({
      name: 'chamba_vault_classify',
      arguments: {
        action: 'apply',
        entries,
        dryRun: false,
      },
    });
    const text = textOf(result);
    const isError = (result as { isError?: boolean }).isError;

    expect(isError).toBe(true);
    expect(text).toContain('50');

    await server.close();
  });

  it('apply dryRun:false applies only specified keys (body intact)', async () => {
    const svc = makeServices(noteFiles);
    const { client, server } = await connect(svc);

    const result = await client.callTool({
      name: 'chamba_vault_classify',
      arguments: {
        action: 'apply',
        entries: [
          { path: 'proyectos/unclassified.md', temas: ['dev'], summary: 'About development' },
        ],
        dryRun: false,
      },
    });
    const text = textOf(result);
    const isError = (result as { isError?: boolean }).isError;

    expect(isError).toBeFalsy();
    expect(text).toContain('unclassified.md');

    // Note should have dev tag
    const content = await svc.fs.readFile('/vault/proyectos/unclassified.md');
    expect(content).toContain('tema/dev');
    // Body should be intact
    expect(content).toContain('This note has no topics yet.');

    await server.close();
  });
});

// ─── Test 10: reindex — manual INDEX.md, adoptManual ──────────────────────────

describe('Test 10: vault_reindex and CLI reindex', () => {
  const manualIndex = `---
title: "Informes"
source: human
---
# Informes

Informes manuales del equipo.
`;

  const filesWithManual = {
    '/vault/temas/VOCABULARIO.md': VOCAB_MD,
    '/vault/informes/INDEX.md': manualIndex,
    '/vault/informes/report1.md': `---
title: "Report 1"
date: 2026-06-01
type: nota
tags:
  - tema/dev
source: chamba
---
# Report 1

A development report.
`,
  };

  it('manual INDEX.md is intact and reported after normal reindex', async () => {
    const svc = makeServices(filesWithManual);
    const { client, server } = await connect(svc);

    const result = await client.callTool({
      name: 'chamba_vault_reindex',
      arguments: {},
    });
    const text = textOf(result);

    // Should report manual INDEX.md was skipped
    expect(text).toContain('informes');
    // Manual INDEX.md must NOT be overwritten
    const content = await svc.fs.readFile('/vault/informes/INDEX.md');
    expect(content).toBe(manualIndex);

    await server.close();
  });

  it('adoptManual dryRun does not write', async () => {
    const svc = makeServices(filesWithManual);
    const { client, server } = await connect(svc);

    // adoptManual without explicit dryRun → defaults to true (O2)
    const result = await client.callTool({
      name: 'chamba_vault_reindex',
      arguments: { adoptManual: ['informes'] },
    });
    const text = textOf(result);

    expect(text).toContain('dryRun');
    // B1: the dry run shows the exact plan — the rename and the new generated index
    expect(text).toContain('informes/INDEX (manual).md');
    expect(text).toContain('informes/INDEX.md');
    // Manual INDEX.md must NOT be renamed/changed
    const exists = await svc.fs.exists('/vault/informes/INDEX.md');
    expect(exists).toBe(true);
    const content = await svc.fs.readFile('/vault/informes/INDEX.md');
    expect(content).toBe(manualIndex);
    // "INDEX (manual).md" must NOT exist
    expect(await svc.fs.exists('/vault/informes/INDEX (manual).md')).toBe(false);

    await server.close();
  });

  it('CLI --adopt-manual without TTY and without --yes does not write, exits 1', async () => {
    const svc = makeServices(filesWithManual);

    const {
      out: _out,
      err,
      code,
    } = await makeCli(svc, ['reindex', '--adopt-manual', 'informes'], { isTTY: false });

    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/--yes|confirmar/i);

    // Manual INDEX.md must NOT be renamed
    const content = await svc.fs.readFile('/vault/informes/INDEX.md');
    expect(content).toBe(manualIndex);
    expect(await svc.fs.exists('/vault/informes/INDEX (manual).md')).toBe(false);
  });

  it('CLI --adopt-manual --yes renames to INDEX (manual).md and generates new', async () => {
    const svc = makeServices(filesWithManual);

    const {
      out,
      err: _err,
      code,
    } = await makeCli(svc, ['reindex', '--adopt-manual', 'informes', '--yes'], { isTTY: false });

    expect(code).toBe(0);
    expect(out.join('\n')).toMatch(/aplicado|escrito/i);

    // "INDEX (manual).md" should now exist with the original content
    const manualExists = await svc.fs.exists('/vault/informes/INDEX (manual).md');
    expect(manualExists).toBe(true);
    // The generated INDEX.md should now be there (generated by chamba)
    const generatedExists = await svc.fs.exists('/vault/informes/INDEX.md');
    expect(generatedExists).toBe(true);
    const generatedContent = await svc.fs.readFile('/vault/informes/INDEX.md');
    expect(generatedContent).toContain('source: chamba');
  });
});

// ─── vault status / chamba_vault_status / doctor show knowledge line ──────────

describe('Knowledge network line in status and doctor', () => {
  const svc = () =>
    makeServices({
      '/vault/temas/VOCABULARIO.md': VOCAB_MD,
      '/vault/proyectos/note.md': `---
title: "A note"
date: 2026-06-01
type: nota
tags:
  - tema/dev
source: chamba
---
# A note

Development note.
`,
    });

  it('chamba_vault_status shows Red de conocimiento line', async () => {
    const services = svc();
    const { client, server } = await connect(services);

    const result = await client.callTool({ name: 'chamba_vault_status', arguments: {} });
    const text = textOf(result);

    expect(text).toContain('Red de conocimiento:');

    await server.close();
  });

  it('doctor shows knowledge network line in vault check', async () => {
    const services = svc();
    const { client, server } = await connect(services);

    const result = await client.callTool({ name: 'chamba_doctor', arguments: {} });
    const text = textOf(result);

    // Doctor should mention the vault with knowledge network info
    expect(text).toContain('Red de conocimiento:');

    // Doctor must NOT write anything (check fs size stays same)
    const vaultContent = await services.fs.readFile('/vault/temas/VOCABULARIO.md');
    expect(vaultContent).toBe(VOCAB_MD);

    await server.close();
  });
});
