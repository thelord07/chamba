/**
 * knowledge-network-prompts.test.ts — verifies that the prompts updated in
 * CHAMBA-016 (ola 5) contain the required knowledge-network guidance.
 *
 * AC5 / §10: prompts must say:
 *   - one note with several `temas`, never separate notes (for planner, ticket, vault)
 *   - vault.md describes `iniciar` and `clasificar` modes with dryRun / confirmation
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

    it('describes the `iniciar` mode', () => {
      expect(content).toContain('iniciar');
    });

    it('describes the `clasificar` mode', () => {
      expect(content).toContain('clasificar');
    });

    it('describes dryRun for iniciar/apply', () => {
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
