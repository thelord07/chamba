/**
 * risk-terms.test.ts — ST-1T
 *
 * §5.2: acentos/mayúsculas/plural; "rolar logs" ≠ rol; "tokenizer" ≠ token.
 */

import { describe, expect, it } from 'vitest';
import { DB_WIPE_TOKENS, matchRiskTerms, RISK_TERMS } from './risk-terms.js';

describe('RISK_TERMS structure', () => {
  it('has at least 20 terms covering all 7 categories', () => {
    const categories = new Set(RISK_TERMS.map((r) => r.category));
    expect(categories).toContain('auth');
    expect(categories).toContain('db');
    expect(categories).toContain('payment');
    expect(categories).toContain('crypto');
    expect(categories).toContain('pii');
    expect(categories).toContain('prod');
    expect(categories).toContain('secrets');
    expect(RISK_TERMS.length).toBeGreaterThanOrEqual(20);
  });

  it('every term has required fields', () => {
    for (const rt of RISK_TERMS) {
      expect(rt.term).toBeTruthy();
      expect(['es', 'en', 'both']).toContain(rt.lang);
      expect([1, 2]).toContain(rt.weight);
      expect(typeof rt.strong).toBe('boolean');
      expect(rt.explanation).toBeTruthy();
    }
  });
});

describe('DB_WIPE_TOKENS', () => {
  it('contains the hook phrases', () => {
    expect(DB_WIPE_TOKENS).toContain('migrate reset');
    expect(DB_WIPE_TOKENS).toContain('--force-reset');
    expect(DB_WIPE_TOKENS).toContain('--accept-data-loss');
    expect(DB_WIPE_TOKENS).toContain('drop database');
    expect(DB_WIPE_TOKENS).toContain('drop table');
    expect(DB_WIPE_TOKENS).toContain('truncate table');
    expect(DB_WIPE_TOKENS).toContain('dropdb');
    expect(DB_WIPE_TOKENS).toContain('prisma db push');
  });
});

describe('matchRiskTerms — acentos y normalización', () => {
  it('matches "autenticación" (con acento) against term "autenticacion"', () => {
    const matches = matchRiskTerms('Cambiar autenticación del usuario');
    expect(matches.map((m) => m.term)).toContain('autenticacion');
  });

  it('matches uppercase "AUTHENTICATION"', () => {
    const matches = matchRiskTerms('Update the AUTHENTICATION module');
    expect(matches.map((m) => m.term)).toContain('authentication');
  });

  it('matches plural "migraciones"', () => {
    const matches = matchRiskTerms('Revisar las migraciones de la base de datos');
    expect(matches.map((m) => m.term)).toContain('migracion');
  });

  it('matches "Migración" (mayúscula + acento)', () => {
    const matches = matchRiskTerms('Migración del schema en producción');
    expect(matches.map((m) => m.term)).toContain('migracion');
    expect(matches.map((m) => m.term)).toContain('schema');
    expect(matches.map((m) => m.term)).toContain('produccion');
  });

  it('does NOT match "rolar logs" as "rol"', () => {
    const matches = matchRiskTerms('El sistema debe rolar logs automáticamente');
    // "rolar" contains "rol" but word boundary prevents it
    // If rol is matched, it would be auth category — it should NOT be matched
    const rolMatch = matches.find((m) => m.term === 'rol');
    expect(rolMatch).toBeUndefined();
  });

  it('does NOT match "tokenizer" as "token"', () => {
    const matches = matchRiskTerms('Use a tokenizer to split the text');
    const tokenMatch = matches.find((m) => m.term === 'token');
    expect(tokenMatch).toBeUndefined();
  });

  it('matches standalone "token" correctly', () => {
    const matches = matchRiskTerms('El token de acceso expiró');
    const tokenMatch = matches.find((m) => m.term === 'token');
    expect(tokenMatch).toBeDefined();
    expect(tokenMatch?.category).toBe('secrets');
  });

  it('matches "JWT" case-insensitively', () => {
    const matches = matchRiskTerms('Verificar el jwt del usuario');
    expect(matches.map((m) => m.term)).toContain('jwt');
  });

  it('matches "stripe" in a sentence', () => {
    const matches = matchRiskTerms('Integrar Stripe para cobros recurrentes');
    expect(matches.map((m) => m.term)).toContain('stripe');
    expect(matches.find((m) => m.term === 'stripe')?.strong).toBe(true);
  });

  it('matches "datos personales" as a phrase', () => {
    const matches = matchRiskTerms('No exponer datos personales en logs');
    expect(matches.map((m) => m.term)).toContain('datos personales');
  });

  it('matches ".env" file reference', () => {
    const matches = matchRiskTerms('Actualizar el archivo .env con nuevas claves');
    expect(matches.map((m) => m.term)).toContain('.env');
    expect(matches.find((m) => m.term === '.env')?.strong).toBe(true);
  });

  it('returns empty array for safe/unrelated text', () => {
    const matches = matchRiskTerms('Actualizar el README con instrucciones de instalación');
    expect(matches).toHaveLength(0);
  });

  it('returns empty array for trivial typo description', () => {
    const matches = matchRiskTerms('Corregir un typo en el botón de enviar');
    expect(matches).toHaveLength(0);
  });

  it('matches "schema" case-insensitively', () => {
    const matches = matchRiskTerms('Update the SCHEMA definition');
    expect(matches.map((m) => m.term)).toContain('schema');
  });

  it('matches "private key" phrase', () => {
    const matches = matchRiskTerms('Do not log the private key anywhere');
    expect(matches.map((m) => m.term)).toContain('private key');
  });

  it('marks strong terms correctly', () => {
    const matches = matchRiskTerms('migration authentication billing');
    const strong = matches.filter((m) => m.strong);
    expect(strong.length).toBeGreaterThan(0);
  });

  it('does not double-count the same term', () => {
    const matches = matchRiskTerms('migration migration migration');
    const migMatches = matches.filter((m) => m.term === 'migration');
    // Each RISK_TERM is matched at most once regardless of text occurrences
    expect(migMatches.length).toBe(1);
  });
});
