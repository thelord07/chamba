/**
 * knowledge-network-prompts.test.ts — verifies that the prompts updated in
 * CHAMBA-016 (ola 5) contain the required knowledge-network guidance, and that
 * the prompts updated in CHAMBA-017 contain the required navigate-before-reading
 * guidance.
 *
 * AC5 / §10: prompts must say:
 *   - one note with several `temas`, never separate notes (for planner, ticket, vault)
 *   - vault.md describes `init` and `classify` modes with dryRun / confirmation
 *
 * CHAMBA-017 / test 8: all 5 assets (planner, diagnostician, ticket, recall, vault)
 *   - contain `chamba_vault_navigate`
 *   - contain `Contexto consultado`
 *   - contain the one-note-several-topics phrase
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function commandPath(name: string): string {
  return fileURLToPath(new URL(`../assets/commands/${name}.md`, import.meta.url));
}

function agentPath(name: string): string {
  return fileURLToPath(new URL(`../assets/agents/${name}.md`, import.meta.url));
}

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const ALL_FIVE_ASSETS = [
  { kind: 'agent' as const, name: 'planner' },
  { kind: 'agent' as const, name: 'diagnostician' },
  { kind: 'command' as const, name: 'ticket' },
  { kind: 'command' as const, name: 'recall' },
  { kind: 'command' as const, name: 'vault' },
];

describe('knowledge-network prompts (CHAMBA-017 test 8) — navigate before reading', () => {
  for (const { kind, name } of ALL_FIVE_ASSETS) {
    const p = kind === 'agent' ? agentPath(name) : commandPath(name);
    const content = read(p);

    describe(`${name}.md`, () => {
      it('contains chamba_vault_navigate', () => {
        expect(content).toContain('chamba_vault_navigate');
      });

      it('contains "Contexto consultado"', () => {
        expect(content).toContain('Contexto consultado');
      });

      it('mentions one note with several temas (not separate notes per topic)', () => {
        expect(content).toMatch(/several.*temas|varios.*temas|one note.*several|una nota.*varios/i);
      });
    });
  }
});

describe('knowledge-network prompts (CHAMBA-016 §10)', () => {
  describe('planner.md', () => {
    const content = read(agentPath('planner'));

    it('mentions one note with several temas (not separate notes)', () => {
      expect(content).toMatch(/several.*temas|varios.*temas|one note.*several|una nota.*varios/i);
    });

    it('mentions temas_propuestos for unknown topics', () => {
      expect(content).toContain('temas_propuestos');
    });
  });

  describe('ticket.md', () => {
    const content = read(commandPath('ticket'));

    it('mentions one note with several temas (not separate notes)', () => {
      expect(content).toMatch(/several.*temas|varios.*temas|one note.*several|una nota.*varios/i);
    });

    it('mentions temas_propuestos for unknown topics', () => {
      expect(content).toContain('temas_propuestos');
    });

    it('mentions workItem', () => {
      expect(content).toContain('workItem');
    });
  });

  describe('vault.md', () => {
    const content = read(commandPath('vault'));

    it('describes the `init` mode', () => {
      expect(content).toContain('/vault init');
    });

    it('describes the `classify` mode', () => {
      expect(content).toContain('/vault classify');
    });

    it('keeps the deprecated aliases note', () => {
      expect(content).toMatch(/iniciar está deprecado/);
      expect(content).toMatch(/clasificar está deprecado/);
    });

    it('describes dryRun for init/apply', () => {
      expect(content).toContain('dryRun');
    });

    it('requires explicit confirmation before dryRun:false', () => {
      expect(content).toMatch(/explicit.*yes|explicit.*approv|confirmación.*turn|separate turn/i);
    });

    it('mentions one note with several temas (not separate notes)', () => {
      expect(content).toMatch(/several.*temas|varios.*temas|one note.*several|una nota.*varios/i);
    });

    it('describes adoptManual with dryRun', () => {
      expect(content).toContain('adoptManual');
    });

    it('describes chamba_vault_reindex', () => {
      expect(content).toContain('chamba_vault_reindex');
    });
  });
});
