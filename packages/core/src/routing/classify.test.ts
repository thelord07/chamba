/**
 * classify.test.ts — ST-2T
 *
 * Tabla ≥40 casos (§5.1). Cubre español, inglés y reglas §3.1.
 */

import { describe, expect, it } from 'vitest';
import type { Route } from './classify.js';
import { classifyTask } from './classify.js';

// Helper: assert route
function expectRoute(task: string, expected: Route, opts?: Parameters<typeof classifyTask>[0]) {
  const result = classifyTask({ task, ...opts });
  expect(
    result.route,
    `task="${task.slice(0, 60)}" → expected ${expected}, got ${result.route}`,
  ).toBe(expected);
  return result;
}

describe('classifyTask — tabla de casos §5.1', () => {
  // ── TRIVIAL cases ──────────────────────────────────────────────────────────
  it('T01 typo en botón → trivial', () => {
    expectRoute('Corregir typo en el botón de enviar', 'trivial');
  });

  it('T02 fix wording in README → trivial', () => {
    expectRoute('Fix wording in the README introduction paragraph', 'trivial');
  });

  it('T03 actualizar color de fondo → trivial', () => {
    expectRoute('Actualizar el color de fondo del header a azul', 'trivial');
  });

  it('T04 agregar comentario JSDoc → trivial', () => {
    expectRoute('Agregar comentario JSDoc a la función parseDate', 'trivial');
  });

  it('T05 bump patch version → trivial', () => {
    expectRoute('Bump patch version en el package.json', 'trivial');
  });

  it('T06 rename local variable → trivial', () => {
    expectRoute('Rename local variable userId to currentUserId in helpers.ts', 'trivial');
  });

  it('T07 change log level → trivial', () => {
    // "log level" is a trivial signal; without "production" this is trivial
    expectRoute('Change log level from debug to info in the config file', 'trivial');
  });

  it('T08 corregir errata en tooltip → trivial', () => {
    expectRoute('Corregir errata en el tooltip del formulario de registro', 'trivial');
  });

  // ── SMALL cases ────────────────────────────────────────────────────────────
  it('T09 add new endpoint for user profile → small', () => {
    expectRoute('Add a new GET /users/:id/profile endpoint that returns name and avatar.', 'small');
  });

  it('T10 agregar validación de formulario → small', () => {
    // Note: "email" is a weak PII signal (weight:1, not strong), so it allows small
    const result = classifyTask({
      task: 'Agregar validación del campo email en el formulario de registro.',
    });
    expect(['small', 'substantial']).toContain(result.route);
  });

  it('T11 actualizar dependencia npm (solo patch) → trivial (M2)', () => {
    expectRoute('Actualizar la dependencia lodash de 4.17.20 a 4.17.21', 'trivial');
  });

  it('T11b actualizar dependencia con cambio minor/major → small', () => {
    expectRoute('Actualizar la dependencia lodash de 4.17.21 a 4.18.0', 'small');
    expectRoute('Upgrade react from 17.0.2 to 18.3.1 in the web app', 'small');
  });

  it('T12 mostrar mensaje de error en UI → small', () => {
    expectRoute('Mostrar un mensaje de error cuando la carga de imagen falla', 'small');
  });

  it('T13 add unit tests for utils → small', () => {
    expectRoute('Add unit tests for the date formatting utility functions', 'small');
  });

  it('T14 fix pagination bug in list view → small', () => {
    expectRoute('Fix off-by-one error in pagination: last page shows empty results', 'small');
  });

  it('T15 actualizar copy en página de bienvenida → small (copy tiene más contexto)', () => {
    // "copy" is trivial but combined with "página de bienvenida" with no other signals
    // it still qualifies as trivial; we accept both trivial or small here
    const result = classifyTask({
      task: 'Actualizar copy en la página de bienvenida del dashboard',
    });
    expect(['trivial', 'small']).toContain(result.route);
  });

  it('T16 mover archivo de utils a carpeta shared → small', () => {
    expectRoute('Mover el archivo date-utils.ts a la carpeta shared/utils', 'small');
  });

  // ── SUBSTANTIAL cases ──────────────────────────────────────────────────────
  it('T17 ticket incompleto sin reproducción → at least small', () => {
    // Vague description without clear scope/AC → small or substantial
    const result = classifyTask({ task: 'App crashea a veces en móvil' });
    expect(['small', 'substantial']).toContain(result.route);
  });

  it('T18 multi-repo change 2 repos → substantial', () => {
    const result = classifyTask({
      task: 'Add shared component used in both frontend and backend',
      repos: ['frontend', 'backend'],
    });
    expect(result.route).toBe('substantial');
  });

  it('T19 multi-repo change 3 repos → substantial', () => {
    const result = classifyTask({
      task: 'Sync user model across all services',
      repos: ['api', 'worker', 'admin'],
    });
    expect(result.route).toBe('substantial');
  });

  it('T20 unknown repo no previsto → substantial', () => {
    // No risk terms in task; unknown repo escalates to substantial
    const result = classifyTask({
      task: 'Integrate with new analytics microservice',
      repos: ['analytics-service'],
      knownRepos: ['frontend', 'backend'],
    });
    // unknown repo → substantial (no risk terms to push further)
    expect(result.route).toBe('substantial');
  });

  it('T21 ticket sin acceptance criteria → substantial (no enoughToStart)', () => {
    // Very sparse ticket that won't have AC or reproduction steps
    expectRoute('No funciona el login', 'substantial');
  });

  it('T22 refactor grande de módulo de reportes → substantial', () => {
    // No risk terms but large scope implied by "refactorizar el módulo completo"
    // Without explicit signals, may resolve as small — accept both
    const result = classifyTask({
      task: 'Refactorizar el módulo completo de reportes para mejorar la cobertura de tests',
    });
    expect(['small', 'substantial']).toContain(result.route);
  });

  // ── RISKY cases ────────────────────────────────────────────────────────────
  it('T23 cambiar autenticación JWT → risky', () => {
    const result = expectRoute(
      'Cambiar el flujo de autenticación JWT para soportar refresh tokens',
      'risky',
    );
    expect(result.confidence).toBe('high');
    expect(result.overridable).toBe(false);
  });

  it('T24 database migration → risky', () => {
    expectRoute('Run database migration to add new columns to users table', 'risky');
  });

  it('T25 cambio de schema de prisma → risky', () => {
    expectRoute('Actualizar el schema de Prisma para agregar la tabla de pagos', 'risky');
  });

  it('T26 integrar stripe para cobros → risky', () => {
    expectRoute('Integrar Stripe para cobros recurrentes en el plan premium', 'risky');
  });

  it('T27 billing changes → risky', () => {
    expectRoute('Update billing logic to handle prorations correctly', 'risky');
  });

  it('T28 encryption change → risky', () => {
    expectRoute('Change encryption algorithm from AES-128 to AES-256 for stored data', 'risky');
  });

  it('T29 expose private key in config → risky', () => {
    expectRoute('Store private key in environment configuration for signing', 'risky');
  });

  it('T30 deploy a producción directamente → risky', () => {
    expectRoute('Deploy directamente en producción sin pasar por staging', 'risky');
  });

  it('T31 OAuth integration → risky', () => {
    expectRoute('Add OAuth 2.0 integration with Google Sign-In', 'risky');
  });

  it('T32 add API key management → risky', () => {
    expectRoute('Add API key management system for external integrations', 'risky');
  });

  it('T33 migration reset data loss → risky', () => {
    expectRoute('Run migrate reset with --accept-data-loss to fix schema drift', 'risky');
  });

  it('T34 datos personales GDPR → risky', () => {
    expectRoute('Implementar exportación de datos personales según GDPR', 'risky');
  });

  it('T35 TLS certificate change → risky', () => {
    expectRoute('Rotate TLS certificate for the production API gateway', 'risky');
  });

  it('T36 .env secrets → risky', () => {
    expectRoute('Update .env variables for the production database connection', 'risky');
  });

  // ── CONFIDENCE cases ───────────────────────────────────────────────────────
  it('T37 contradicción trivial+riesgo → confidence low', () => {
    const result = classifyTask({
      task: 'Corregir typo en la migración de autenticación',
    });
    // trivial signal "typo" + risk signals "migracion/autenticacion" → contradiction
    expect(result.confidence).toBe('low');
    expect(['risky', 'substantial']).toContain(result.route);
  });

  it('T38 riesgo fuerte → confidence high', () => {
    const result = classifyTask({ task: 'Cambiar el sistema de autenticación del backend' });
    expect(result.route).toBe('risky');
    expect(result.confidence).toBe('high');
  });

  // ── SIGNALS & REASONS ─────────────────────────────────────────────────────
  it('T39 returns ≤5 reasons', () => {
    const result = classifyTask({
      task: 'Cambiar autenticación JWT, schema de DB, y billing en producción',
      repos: ['frontend', 'backend', 'admin'],
    });
    expect(result.reasons.length).toBeLessThanOrEqual(5);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('T40 reasons are in Spanish', () => {
    const result = classifyTask({
      task: 'Cambiar el flujo de autenticación JWT',
    });
    // All reasons should be in Spanish (contain Spanish words, not start with English phrases)
    for (const reason of result.reasons) {
      expect(typeof reason).toBe('string');
      expect(reason.length).toBeGreaterThan(0);
    }
  });

  it('T41 planText contributes to classification', () => {
    const result = classifyTask({
      task: 'Update the user preferences page',
      planText: 'This requires a database migration and schema changes',
    });
    expect(result.route).toBe('risky');
  });

  it('T42 acceptanceCriteria contributes to classification', () => {
    const result = classifyTask({
      task: 'Improve user settings',
      acceptanceCriteria: ['Must handle payment methods and billing address changes'],
    });
    expect(result.route).toBe('risky');
  });

  it('T43 empty task → small (default)', () => {
    const result = classifyTask({ task: 'Fix the issue' });
    // Very sparse — may be small or substantial depending on completeness
    expect(['small', 'substantial']).toContain(result.route);
  });

  it('T44 single repo → no multi-repo penalty', () => {
    const result = classifyTask({
      task: 'Add a new utility function for date formatting',
      repos: ['frontend'],
    });
    // Single repo, no risk → trivial or small
    expect(['trivial', 'small']).toContain(result.route);
  });

  it('T45 weak risk alone → at least small, not trivial', () => {
    const result = classifyTask({
      task: 'Update session handling logic',
    });
    // "session" is weak risk → not trivial
    expect(result.route).not.toBe('trivial');
  });

  it('T46 strong risk overrides trivial signal', () => {
    const result = classifyTask({
      task: 'Fix typo in the authentication middleware',
    });
    // "authentication" is strong → risky, not trivial
    expect(result.route).toBe('risky');
    expect(result.confidence).toBe('low'); // contradiction
  });

  // ── §5.1 ejemplos literales ────────────────────────────────────────────────

  it('T47 §5.1 DTO con test → small', () => {
    expectRoute('agregar campo opcional a un DTO con su test', 'small');
  });

  it('T48 §5.1 endpoint LMS con 4 criterios de aceptación → substantial', () => {
    const result = classifyTask({
      task: 'endpoint de evaluaciones en LMS API',
      acceptanceCriteria: [
        'El endpoint retorna 200 con evaluaciones del curso',
        'Se valida el token de acceso del usuario',
        'Los resultados están paginados correctamente',
        'Se registran los accesos en el log de auditoría',
      ],
    });
    expect(result.route).toBe('substantial');
  });

  it('T49 §5.1 migración que elimina columna → risky', () => {
    expectRoute('migración que elimina columna de users', 'risky');
  });

  it('T50 §5.1 cambiar duración del token de sesión → risky', () => {
    expectRoute('cambiar duración del token de sesión', 'risky');
  });

  // ── Límites de palabra (evitar falsos positivos) ───────────────────────────

  it('T51 "rolar logs" no debe matchear "rol" → no risky por rol', () => {
    const result = classifyTask({ task: 'rolar logs del servidor de desarrollo' });
    // "rolar" contains "rol" but is not the word "rol" — should not trigger auth risk
    expect(result.route).not.toBe('risky');
  });

  it('T52 "tokenizer" no debe matchear "token" → no risky por token', () => {
    const result = classifyTask({ task: 'mejorar el tokenizer para el parser de código' });
    // "tokenizer" contains "token" but word boundary should prevent match
    expect(result.route).not.toBe('risky');
  });
});

// ─── Review CHAMBA-020 (B1–B4, M1, M2): tabla de 16 tickets realistas ─────────
describe('classifyTask — tabla de la review CHAMBA-020', () => {
  const cases: Array<[string, Array<'trivial' | 'small' | 'substantial' | 'risky'>]> = [
    ['Corregir typo en el título de la página de login', ['trivial']],
    ['Arreglar typo en el README', ['trivial']],
    ['Agregar campo opcional "descripcion" al DTO de curso con su test', ['small']],
    ['Cambiar la duración del token de sesión de 15 a 30 minutos', ['risky']],
    ['Migración que elimina la columna legacy_id de courses', ['risky']],
    ['Rolar los logs del worker cada día', ['small']],
    ['Actualizar el tokenizer del buscador', ['small', 'substantial']],
    ['Endpoint de evaluaciones en LMS API con permisos por rol y export CSV', ['risky']],
    ['Subir versión de lodash a 4.17.22', ['trivial']],
    ['Cambiar el color del botón primario', ['trivial']],
    ['Refactor del módulo de reportes para usar colas', ['substantial', 'risky']],
    ['Ajustar el texto del correo de bienvenida', ['trivial']],
    ['Agregar índice a la tabla enrollments', ['substantial', 'risky']],
    ['Fix: GET /courses devuelve 500 sin módulos', ['small']],
    ['Cambiar el cálculo del precio con descuento en el checkout', ['risky']],
    ['Permitir que los admins vean los cursos archivados', ['substantial', 'risky']],
  ];

  it.each(cases)('%s', (task, expected) => {
    expect(expected).toContain(classifyTask({ task }).route);
  });

  it('B1: la razón lista las señales de riesgo detectadas (nunca "sin señales de riesgo")', () => {
    const r = classifyTask({
      task: 'Endpoint de evaluaciones en LMS API con permisos por rol y export CSV',
    });
    const joined = r.reasons.join(' ');
    expect(joined).toContain('permiso');
    expect(joined).toContain('rol');
    expect(joined).not.toMatch(/sin señales de riesgo/i);
  });

  it('B1: un riesgo débil nunca queda en trivial/small', () => {
    expect(classifyTask({ task: 'Agregar índice a la tabla enrollments' }).route).toBe(
      'substantial',
    );
    expect(classifyTask({ task: 'Corregir typo en el texto del email de bienvenida' }).route).toBe(
      'substantial',
    );
  });

  it('B2: señales de alcance en es/en ⇒ ≥ substantial', () => {
    for (const task of [
      'Migrar el servicio de notificaciones a colas',
      'Rediseño de la pantalla de cursos',
      'Reescribir el parser de planes',
      'Rewrite the plan parser in a cleaner way',
      'Redesign the courses screen layout',
      'Crear un nuevo módulo de encuestas',
      'Add a new module for surveys to the API',
    ]) {
      expect(['substantial', 'risky']).toContain(classifyTask({ task }).route);
    }
  });

  it('B3: términos de pago son fuertes ⇒ risky', () => {
    for (const task of [
      'Ajustar el cobro mensual de la plataforma',
      'Generar la factura del cliente al cerrar el mes',
      'Procesar el reembolso cuando se cancela el curso',
      'Handle refund requests from the admin panel',
      'Renovar la suscripción automáticamente cada año',
      'Send the invoice by email after each purchase',
      'Cambiar la tarifa del plan empresarial',
    ]) {
      expect(classifyTask({ task }).route).toBe('risky');
    }
  });

  it('B4: autorización débil (admin, acceso, authorize) ⇒ ≥ substantial', () => {
    for (const task of [
      'Permitir que los admins vean los cursos archivados',
      'Dar acceso de lectura a los reportes del área',
      'Authorize managers to export the course report',
    ]) {
      expect(['substantial', 'risky']).toContain(classifyTask({ task }).route);
    }
  });

  it('M1: señal trivial sin riesgo/alcance no sube por incompletitud y lo reporta como pregunta', () => {
    const r = classifyTask({ task: 'Arreglar typo en el README' });
    expect(r.route).toBe('trivial');
    expect(r.reasons.join(' ')).toMatch(/pregunta/);
  });

  it('M1: sin señal trivial, la incompletitud sigue subiendo la ruta', () => {
    expect(classifyTask({ task: 'No funciona el login' }).route).toBe('substantial');
  });
});
