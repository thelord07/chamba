import { describe, expect, it } from 'vitest';
import {
  checkTicketCompleteness,
  renderTicketCompleteness,
  TICKET_SIGNALS,
} from './ticket-completeness.js';

describe('checkTicketCompleteness', () => {
  it('flags a bare, info-poor ticket as not enough to start', () => {
    const result = checkTicketCompleteness({ ticket: 'The login page is broken, please fix.' });
    expect(result.enoughToStart).toBe(false);
    expect(result.missing).toContain('reproduction');
    expect(result.missing).toContain('expected-vs-actual');
    // every missing signal yields exactly one question
    expect(result.questions).toHaveLength(result.missing.length);
    expect(result.score).toBeLessThan(1);
  });

  it('marks a rich ticket as enough to start with the blocking signals present', () => {
    const ticket = `## Bug
    Steps to reproduce:
    1. Go to /checkout
    2. Click Pay

    Expected: the order confirms. Actual: it hangs on a spinner.

    Environment: production, Chrome on macOS, build 1.4.2.
    Affected module: the payments screen.
    Acceptance criteria: paying completes and shows the receipt.
    Severity: P1 — blocks all paid users, no workaround.`;
    const result = checkTicketCompleteness({ ticket });
    expect(result.enoughToStart).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.present).toEqual([...TICKET_SIGNALS]);
    expect(result.score).toBe(1);
    expect(result.questions).toEqual([]);
  });

  it('detects Spanish markers too', () => {
    const ticket = `Pasos para reproducir: entrar al perfil.
    Resultado esperado: se guarda. En su lugar: da error 500.
    Entorno: staging, versión 2.0. Afecta el módulo de perfil.
    Criterios de aceptación: guarda sin error. Severidad: crítico.`;
    const result = checkTicketCompleteness({ ticket });
    expect(result.enoughToStart).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('treats a checkbox list as acceptance criteria', () => {
    const result = checkTicketCompleteness({ ticket: 'Done when:\n- [ ] it works\n- [ ] tested' });
    expect(result.present).toContain('acceptance-criteria');
  });

  it('is blocking-only: repro + expected/actual present but others missing still starts', () => {
    const ticket = 'Steps to reproduce: open X. Expected: A. Actual: B.';
    const result = checkTicketCompleteness({ ticket });
    expect(result.enoughToStart).toBe(true);
    // but it still nudges for the advisory signals
    expect(result.missing).toContain('acceptance-criteria');
    expect(result.missing).toContain('severity');
  });

  it('handles an empty ticket without throwing', () => {
    const result = checkTicketCompleteness({ ticket: '' });
    expect(result.enoughToStart).toBe(false);
    expect(result.present).toEqual([]);
    expect(result.score).toBe(0);
  });
});

describe('renderTicketCompleteness', () => {
  it('renders a verdict, per-signal ticks and the questions to ask', () => {
    const text = renderTicketCompleteness(checkTicketCompleteness({ ticket: 'login broken' }));
    expect(text).toContain('Ticket completeness:');
    expect(text).toMatch(/[✓✗]/u);
    expect(text).toContain('Ask the reporter:');
  });

  it('says nothing is missing on a complete ticket', () => {
    const ticket =
      'Reproduce: open. Expected: ok, actual: fail. Environment: prod, version 1. ' +
      'Affected: the screen. Acceptance criteria: works. Severity: high.';
    const text = renderTicketCompleteness(checkTicketCompleteness({ ticket }));
    expect(text).toContain('Nothing obvious missing.');
  });
});
