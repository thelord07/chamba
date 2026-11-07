/**
 * routing/risk-terms.ts — CHAMBA-020
 *
 * Two exported lists:
 * 1. `RISK_TERMS` — lenguaje natural es/en; usado por el clasificador de rutas.
 * 2. `DB_WIPE_TOKENS` — frases exactas del hook CHAMBA-013 (PreToolUse-warn-destructive.sh);
 *    el drift-test verifica que cada patrón del hook está cubierto aquí.
 *
 * chamba NO importa SDKs de LLM — toda la lógica es pura, sin Node APIs.
 */

export type RiskCategory = 'auth' | 'db' | 'payment' | 'crypto' | 'pii' | 'prod' | 'secrets';

export interface RiskTerm {
  /** Término o patrón a detectar (minúsculas, sin acentos). */
  term: string;
  /** Categoría de riesgo. */
  category: RiskCategory;
  /** Idioma principal del término. */
  lang: 'es' | 'en' | 'both';
  /** 1 = señal débil, 2 = señal fuerte que fuerza ruta risky. */
  weight: 1 | 2;
  /** Cuando true, el match solo fuerza ruta risky (no se puede bajar). */
  strong: boolean;
  /** Explicación en español para el agente. */
  explanation: string;
}

/**
 * Lista de términos de riesgo para el clasificador de rutas.
 * Comparación insensible a mayúsculas/acentos + límites de palabra.
 */
export const RISK_TERMS: readonly RiskTerm[] = [
  // ── auth ──────────────────────────────────────────────────────────────────
  {
    term: 'autenticacion',
    category: 'auth',
    lang: 'es',
    weight: 2,
    strong: true,
    explanation: 'Cambios en autenticación implican riesgo de acceso elevado.',
  },
  {
    term: 'autorizacion',
    category: 'auth',
    lang: 'es',
    weight: 2,
    strong: true,
    explanation: 'Cambios en autorización pueden otorgar permisos no deseados.',
  },
  {
    term: 'authentication',
    category: 'auth',
    lang: 'en',
    weight: 2,
    strong: true,
    explanation: 'Authentication changes carry elevated access risk.',
  },
  {
    term: 'authorization',
    category: 'auth',
    lang: 'en',
    weight: 2,
    strong: true,
    explanation: 'Authorization changes may grant unintended permissions.',
  },
  {
    term: 'jwt',
    category: 'auth',
    lang: 'both',
    weight: 2,
    strong: true,
    explanation: 'JSON Web Tokens — manejo incorrecto expone sesiones.',
  },
  {
    term: 'oauth',
    category: 'auth',
    lang: 'both',
    weight: 2,
    strong: true,
    explanation: 'OAuth — flujos complejos con implicaciones de seguridad.',
  },
  {
    term: 'sesion',
    category: 'auth',
    lang: 'es',
    weight: 1,
    strong: false,
    explanation: 'Gestión de sesiones puede afectar seguridad de acceso.',
  },
  {
    term: 'session',
    category: 'auth',
    lang: 'en',
    weight: 1,
    strong: false,
    explanation: 'Session management may affect access security.',
  },
  {
    term: 'permiso',
    category: 'auth',
    lang: 'es',
    weight: 1,
    strong: false,
    explanation: 'Cambios en permisos pueden ampliar el alcance de acceso.',
  },
  {
    term: 'permission',
    category: 'auth',
    lang: 'en',
    weight: 1,
    strong: false,
    explanation: 'Permission changes may widen access scope.',
  },
  {
    term: 'rol',
    category: 'auth',
    lang: 'es',
    weight: 1,
    strong: false,
    explanation: 'Cambios en roles afectan qué acciones están permitidas.',
  },
  {
    term: 'role',
    category: 'auth',
    lang: 'en',
    weight: 1,
    strong: false,
    explanation: 'Role changes affect what actions are allowed.',
  },
  {
    term: 'admin',
    category: 'auth',
    lang: 'both',
    weight: 1,
    strong: false,
    explanation: 'Cambios ligados a administradores tocan autorización.',
  },
  {
    term: 'acceso',
    category: 'auth',
    lang: 'es',
    weight: 1,
    strong: false,
    explanation: 'Cambios de acceso tocan autorización.',
  },
  {
    term: 'access',
    category: 'auth',
    lang: 'en',
    weight: 1,
    strong: false,
    explanation: 'Access changes touch authorization.',
  },
  {
    term: 'visibilidad por rol',
    category: 'auth',
    lang: 'es',
    weight: 1,
    strong: false,
    explanation: 'Visibilidad por rol es una regla de autorización.',
  },
  {
    term: 'autorizar',
    category: 'auth',
    lang: 'es',
    weight: 1,
    strong: false,
    explanation: 'Autorizar acciones es lógica de autorización.',
  },
  {
    term: 'authorize',
    category: 'auth',
    lang: 'en',
    weight: 1,
    strong: false,
    explanation: 'Authorizing actions is authorization logic.',
  },
  {
    term: 'middleware de autenticacion',
    category: 'auth',
    lang: 'es',
    weight: 2,
    strong: true,
    explanation: 'Middleware de autenticación protege rutas enteras.',
  },
  {
    term: 'auth middleware',
    category: 'auth',
    lang: 'en',
    weight: 2,
    strong: true,
    explanation: 'Auth middleware protects entire routes.',
  },
  // ── db ────────────────────────────────────────────────────────────────────
  {
    term: 'migracion',
    category: 'db',
    lang: 'es',
    weight: 2,
    strong: true,
    explanation: 'Migraciones de base de datos pueden ser destructivas.',
  },
  {
    term: 'migration',
    category: 'db',
    lang: 'en',
    weight: 2,
    strong: true,
    explanation: 'Database migrations can be destructive.',
  },
  {
    term: 'schema',
    category: 'db',
    lang: 'both',
    weight: 2,
    strong: true,
    explanation: 'Cambios de esquema afectan toda la capa de datos.',
  },
  {
    term: 'base de datos',
    category: 'db',
    lang: 'es',
    weight: 1,
    strong: false,
    explanation: 'Cambios directos a la base de datos requieren revisión.',
  },
  {
    term: 'database',
    category: 'db',
    lang: 'en',
    weight: 1,
    strong: false,
    explanation: 'Direct database changes require review.',
  },
  {
    term: 'prisma',
    category: 'db',
    lang: 'both',
    weight: 1,
    strong: false,
    explanation: 'ORM — migraciones o cambios de modelo afectan el esquema.',
  },
  {
    term: 'indice',
    category: 'db',
    lang: 'es',
    weight: 1,
    strong: false,
    explanation: 'Cambios en índices afectan rendimiento y estructura.',
  },
  {
    term: 'index',
    category: 'db',
    lang: 'en',
    weight: 1,
    strong: false,
    explanation: 'Index changes affect performance and structure.',
  },
  // ── payment ───────────────────────────────────────────────────────────────
  {
    term: 'pago',
    category: 'payment',
    lang: 'es',
    weight: 2,
    strong: true,
    explanation: 'Flujos de pago requieren revisión de seguridad y PCI.',
  },
  {
    term: 'payment',
    category: 'payment',
    lang: 'en',
    weight: 2,
    strong: true,
    explanation: 'Payment flows require security and PCI review.',
  },
  {
    term: 'stripe',
    category: 'payment',
    lang: 'both',
    weight: 2,
    strong: true,
    explanation: 'Integración con Stripe — riesgo financiero directo.',
  },
  {
    term: 'facturacion',
    category: 'payment',
    lang: 'es',
    weight: 2,
    strong: true,
    explanation: 'Cambios en facturación afectan cobros reales.',
  },
  {
    term: 'billing',
    category: 'payment',
    lang: 'en',
    weight: 2,
    strong: true,
    explanation: 'Billing changes affect real charges.',
  },
  {
    term: 'tarjeta',
    category: 'payment',
    lang: 'es',
    weight: 2,
    strong: true,
    explanation: 'Datos de tarjeta son PCI-DSS — manejo muy controlado.',
  },
  {
    term: 'credit card',
    category: 'payment',
    lang: 'en',
    weight: 2,
    strong: true,
    explanation: 'Card data is PCI-DSS — highly controlled handling required.',
  },
  {
    term: 'cobro',
    category: 'payment',
    lang: 'es',
    weight: 2,
    strong: true,
    explanation: 'Cambios en cobros afectan dinero real.',
  },
  {
    term: 'factura',
    category: 'payment',
    lang: 'es',
    weight: 2,
    strong: true,
    explanation: 'Facturas afectan cobros y obligaciones fiscales.',
  },
  {
    term: 'checkout',
    category: 'payment',
    lang: 'both',
    weight: 2,
    strong: true,
    explanation: 'El checkout es el flujo de pago — riesgo financiero directo.',
  },
  {
    term: 'precio',
    category: 'payment',
    lang: 'es',
    weight: 2,
    strong: true,
    explanation: 'Cambios de precio afectan lo que se cobra.',
  },
  {
    term: 'descuento',
    category: 'payment',
    lang: 'es',
    weight: 2,
    strong: true,
    explanation: 'Descuentos alteran el monto cobrado.',
  },
  {
    term: 'reembolso',
    category: 'payment',
    lang: 'es',
    weight: 2,
    strong: true,
    explanation: 'Reembolsos mueven dinero real.',
  },
  {
    term: 'refund',
    category: 'payment',
    lang: 'en',
    weight: 2,
    strong: true,
    explanation: 'Refunds move real money.',
  },
  {
    term: 'suscripcion',
    category: 'payment',
    lang: 'es',
    weight: 2,
    strong: true,
    explanation: 'Suscripciones implican cobros recurrentes.',
  },
  {
    term: 'subscription',
    category: 'payment',
    lang: 'en',
    weight: 2,
    strong: true,
    explanation: 'Subscriptions imply recurring charges.',
  },
  {
    term: 'tarifa',
    category: 'payment',
    lang: 'es',
    weight: 2,
    strong: true,
    explanation: 'Tarifas determinan lo que se cobra.',
  },
  {
    term: 'invoice',
    category: 'payment',
    lang: 'en',
    weight: 2,
    strong: true,
    explanation: 'Invoices affect charges and tax obligations.',
  },
  // ── crypto ────────────────────────────────────────────────────────────────
  {
    term: 'cifrado',
    category: 'crypto',
    lang: 'es',
    weight: 2,
    strong: true,
    explanation: 'Cambios en cifrado pueden debilitar la protección de datos.',
  },
  {
    term: 'encryption',
    category: 'crypto',
    lang: 'en',
    weight: 2,
    strong: true,
    explanation: 'Encryption changes may weaken data protection.',
  },
  {
    term: 'hash',
    category: 'crypto',
    lang: 'both',
    weight: 1,
    strong: false,
    explanation: 'Funciones de hash — cambios afectan integridad o contraseñas.',
  },
  {
    term: 'clave privada',
    category: 'crypto',
    lang: 'es',
    weight: 2,
    strong: true,
    explanation: 'Claves privadas — exposición catastrófica.',
  },
  {
    term: 'private key',
    category: 'crypto',
    lang: 'en',
    weight: 2,
    strong: true,
    explanation: 'Private keys — exposure is catastrophic.',
  },
  {
    term: 'certificado',
    category: 'crypto',
    lang: 'es',
    weight: 2,
    strong: true,
    explanation: 'Certificados TLS/SSL — cambios afectan confianza.',
  },
  {
    term: 'certificate',
    category: 'crypto',
    lang: 'en',
    weight: 2,
    strong: true,
    explanation: 'TLS/SSL certificates — changes affect trust.',
  },
  // ── pii ───────────────────────────────────────────────────────────────────
  {
    term: 'datos personales',
    category: 'pii',
    lang: 'es',
    weight: 2,
    strong: true,
    explanation: 'PII — sujetos a regulaciones de privacidad (GDPR/LGPD).',
  },
  {
    term: 'personal data',
    category: 'pii',
    lang: 'en',
    weight: 2,
    strong: true,
    explanation: 'PII — subject to privacy regulations (GDPR/LGPD).',
  },
  {
    term: 'gdpr',
    category: 'pii',
    lang: 'both',
    weight: 2,
    strong: true,
    explanation: 'GDPR — cumplimiento obligatorio para datos EU.',
  },
  {
    term: 'privacidad',
    category: 'pii',
    lang: 'es',
    weight: 1,
    strong: false,
    explanation: 'Cambios de privacidad requieren revisión legal/técnica.',
  },
  {
    term: 'privacy',
    category: 'pii',
    lang: 'en',
    weight: 1,
    strong: false,
    explanation: 'Privacy changes require legal/technical review.',
  },
  {
    term: 'correo electronico',
    category: 'pii',
    lang: 'es',
    weight: 1,
    strong: false,
    explanation: 'Email de usuario es PII típica.',
  },
  {
    term: 'email',
    category: 'pii',
    lang: 'both',
    weight: 1,
    strong: false,
    explanation: 'User email is typical PII.',
  },
  // ── prod ──────────────────────────────────────────────────────────────────
  {
    term: 'produccion',
    category: 'prod',
    lang: 'es',
    weight: 2,
    strong: true,
    explanation: 'Cambios directos en producción — riesgo alto.',
  },
  {
    term: 'production',
    category: 'prod',
    lang: 'en',
    weight: 2,
    strong: true,
    explanation: 'Direct production changes — high risk.',
  },
  {
    term: 'deploy',
    category: 'prod',
    lang: 'both',
    weight: 1,
    strong: false,
    explanation: 'Despliegue — afecta usuarios en vivo.',
  },
  {
    term: 'hotfix',
    category: 'prod',
    lang: 'both',
    weight: 1,
    strong: false,
    explanation: 'Hotfix en producción — presión de tiempo, mayor riesgo.',
  },
  {
    term: 'feature flag',
    category: 'prod',
    lang: 'en',
    weight: 1,
    strong: false,
    explanation: 'Feature flags en prod — cambio de comportamiento en vivo.',
  },
  {
    term: 'bandera de caracteristica',
    category: 'prod',
    lang: 'es',
    weight: 1,
    strong: false,
    explanation: 'Banderas de características en prod — riesgo en vivo.',
  },
  // ── secrets ───────────────────────────────────────────────────────────────
  {
    term: 'api key',
    category: 'secrets',
    lang: 'en',
    weight: 2,
    strong: true,
    explanation: 'API keys — exposición puede causar abuso o cargos.',
  },
  {
    term: 'clave de api',
    category: 'secrets',
    lang: 'es',
    weight: 2,
    strong: true,
    explanation: 'Claves de API — exposición puede causar abuso o cargos.',
  },
  {
    term: 'variable de entorno',
    category: 'secrets',
    lang: 'es',
    weight: 1,
    strong: false,
    explanation: 'Variables de entorno suelen contener secretos.',
  },
  {
    term: 'env var',
    category: 'secrets',
    lang: 'en',
    weight: 1,
    strong: false,
    explanation: 'Environment variables often contain secrets.',
  },
  {
    term: 'secreto',
    category: 'secrets',
    lang: 'es',
    weight: 2,
    strong: true,
    explanation: 'Término explícito de secreto — siempre risky.',
  },
  {
    term: 'secret',
    category: 'secrets',
    lang: 'en',
    weight: 2,
    strong: true,
    explanation: 'Explicit secret term — always risky.',
  },
  {
    term: 'token',
    category: 'secrets',
    lang: 'both',
    weight: 1,
    strong: false,
    explanation: 'Tokens de acceso — manejo incorrecto expone recursos.',
  },
  // ── auth: session/token lifetime (strong — frases específicas de duración/expiración) ──
  {
    term: 'duracion del token',
    category: 'auth',
    lang: 'es',
    weight: 2,
    strong: true,
    explanation: 'Cambiar cuánto dura un token altera toda la seguridad de sesiones.',
  },
  {
    term: 'expiracion del token',
    category: 'auth',
    lang: 'es',
    weight: 2,
    strong: true,
    explanation: 'Cambios en expiración del token afectan el ciclo de vida de sesiones.',
  },
  {
    term: 'vida del token',
    category: 'auth',
    lang: 'es',
    weight: 2,
    strong: true,
    explanation: 'Vida del token — controla cuánto tiempo es válida una sesión.',
  },
  {
    term: 'duracion de la sesion',
    category: 'auth',
    lang: 'es',
    weight: 2,
    strong: true,
    explanation: 'Duración de sesión — cambios afectan seguridad de acceso.',
  },
  {
    term: 'expiracion de la sesion',
    category: 'auth',
    lang: 'es',
    weight: 2,
    strong: true,
    explanation: 'Expiración de sesión — cambios pueden alargar ventanas de ataque.',
  },
  {
    term: 'session lifetime',
    category: 'auth',
    lang: 'en',
    weight: 2,
    strong: true,
    explanation: 'Session lifetime change affects how long a session remains valid.',
  },
  {
    term: 'session timeout',
    category: 'auth',
    lang: 'en',
    weight: 2,
    strong: true,
    explanation: 'Session timeout change affects idle-session security window.',
  },
  {
    term: 'token expiry',
    category: 'auth',
    lang: 'en',
    weight: 2,
    strong: true,
    explanation: 'Token expiry change alters the security lifecycle of access tokens.',
  },
  {
    term: 'token ttl',
    category: 'auth',
    lang: 'en',
    weight: 2,
    strong: true,
    explanation: 'Token TTL change modifies how long issued tokens remain valid.',
  },
  {
    term: 'token lifetime',
    category: 'auth',
    lang: 'en',
    weight: 2,
    strong: true,
    explanation: 'Token lifetime change affects authentication expiry policy.',
  },
  {
    term: '.env',
    category: 'secrets',
    lang: 'both',
    weight: 2,
    strong: true,
    explanation: 'Archivos .env contienen secretos — nunca commitear.',
  },
];

/**
 * Frases exactas extraídas del hook CHAMBA-013
 * (PreToolUse-warn-destructive.sh). El drift-test verifica que cada patrón
 * del hook aparece aquí.
 *
 * NOTA: estas frases son para búsqueda de texto plano en comandos de shell,
 * no para normalización NFD ni comparación lingüística.
 */
export const DB_WIPE_TOKENS: readonly string[] = [
  'migrate reset',
  '--force-reset',
  '--accept-data-loss',
  'drop database',
  'drop table',
  'drop schema',
  'truncate table',
  'dropdb',
  'db:drop',
  'db:reset',
  'schema:drop',
  'prisma db push',
];

/**
 * Señales que indican un cambio trivial (sin riesgo ni alcance).
 * R3: trivial exige ≥1 señal trivial Y cero señales de riesgo/alcance.
 * Términos es/en: typo/errata, copy, color, comentario, bump, renombre local, log level.
 */
export const TRIVIAL_TERMS: readonly string[] = [
  'typo',
  'errata',
  'texto',
  'copy',
  'color',
  'comentario',
  'comment',
  'bump',
  'version patch',
  'patch version',
  'renombre',
  'rename',
  'log level',
  'nivel de log',
  'wording',
  'traduccion',
  'translation',
  'tooltip',
  'placeholder',
];

/**
 * Señales de alcance (§3.1): cambios de estructura que nunca son trivial/small.
 * B2 (review CHAMBA-020): cualquiera ⇒ mínimo substantial.
 */
export const SCOPE_TERMS: readonly string[] = [
  'refactor',
  'refactorizar',
  'refactorizacion',
  'nuevo modulo',
  'nuevos modulos',
  'migrar',
  'rediseno',
  'redisenar',
  'reescribir',
  'reescritura',
  'rewrite',
  'redesign',
  'new module',
];

// ─── Matching helpers ──────────────────────────────────────────────────────────

/**
 * Normalize text for comparison: lowercase + remove NFD combining marks (acentos).
 */
function normalize(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * Build a word-boundary regex for a normalized term.
 * Handles multi-word phrases (spaces become \s+), special chars escaped.
 * Supports plural forms: appends optional common Spanish/English suffixes
 * (s, es) so "migracion" also matches "migraciones", while keeping strict
 * end-word-boundary to avoid "token" matching "tokenizer" or "rol" matching "rolar".
 *
 * Exported so classify.ts can reuse it for TRIVIAL_TERMS matching.
 */
export function termRegex(normalizedTerm: string): RegExp {
  // Escape regex special characters
  const escaped = normalizedTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Replace spaces with flexible whitespace
  const pattern = escaped.replace(/\s+/g, '\\s+');
  // Allow optional plural suffixes (es|s) before the end word boundary.
  // This catches Spanish -ción → -ciones (e.g. "migracion" → "migraciones")
  // and English -s plurals, without matching non-plural suffixes like "-izer", "-ar".
  return new RegExp(`(?<![\\w])${pattern}(?:es|s)?(?![\\w])`, 'i');
}

export interface RiskMatch {
  term: string;
  category: RiskCategory;
  weight: 1 | 2;
  strong: boolean;
  explanation: string;
}

/**
 * Match `RISK_TERMS` against `text` with NFD normalization and word boundaries.
 * Returns all matching terms (may contain duplicates if the term appears multiple times,
 * but each RiskTerm is returned at most once).
 */
export function matchRiskTerms(text: string): RiskMatch[] {
  const normalizedText = normalize(text);
  const matches: RiskMatch[] = [];

  for (const rt of RISK_TERMS) {
    const normalizedTerm = normalize(rt.term);
    const re = termRegex(normalizedTerm);
    if (re.test(normalizedText)) {
      matches.push({
        term: rt.term,
        category: rt.category,
        weight: rt.weight,
        strong: rt.strong,
        explanation: rt.explanation,
      });
    }
  }

  return matches;
}
