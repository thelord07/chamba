/**
 * vault-sync/protocol.ts — Zod schemas for the parche sync protocol v1.
 * Pure: no Node APIs, no LLM, no crypto/fs/net. Hashes arrive pre-computed.
 */

import { z } from 'zod';
import { pathKey } from './path-key.js';

export const PROTOCOL_VERSION = 1 as const;

// ─── Primitives ───────────────────────────────────────────────────────────────

export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/, 'invalid sha256 hash');

/** Returns true if `s` contains ASCII control characters or C1 controls. */
function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const cp = s.charCodeAt(i);
    // C0 (0x00–0x1F), DEL (0x7F), C1 (0x80–0x9F)
    if (cp <= 0x1f || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) return true;
  }
  return false;
}

export const vaultPathSchema = z
  .string()
  .transform((s) => s.normalize('NFC'))
  .superRefine((s, ctx) => {
    if (s.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'path must not be empty' });
      return;
    }
    if (s.length > 512) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'path must not exceed 512 UTF-16 code units',
      });
      return;
    }
    if (s.startsWith('/')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'path must not start with /',
      });
      return;
    }
    if (s.includes('\\')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'path must not contain backslashes',
      });
      return;
    }
    if (hasControlChars(s)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'path must not contain control characters',
      });
      return;
    }
    const segments = s.split('/');
    for (const seg of segments) {
      if (seg === '') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'path must not have empty segments',
        });
        return;
      }
      if (seg === '.' || seg === '..') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'path must not contain . or .. segments',
        });
        return;
      }
      if (seg.toLowerCase().startsWith('.chamba-sync')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'path must not have segments starting with .chamba-sync',
        });
        return;
      }
    }
  });

export const roleSchema = z.enum(['owner', 'admin', 'editor', 'reader']);

// ─── Change entries ───────────────────────────────────────────────────────────

export const changeEntrySchema = z.object({
  seq: z.number().int().min(1),
  path: vaultPathSchema,
  hash: hashSchema.nullable(),
  author: z.string().min(1),
  device: z.string().min(1),
  at: z.string().datetime({ offset: true }),
});

export const changesResponseSchema = z.object({
  protocol: z.literal(1),
  changes: z.array(changeEntrySchema),
  cursor: z.number().int().min(0),
  hasMore: z.boolean(),
});

// ─── Push ─────────────────────────────────────────────────────────────────────

export const pushChangeSchema = z.object({
  path: vaultPathSchema,
  baseHash: hashSchema.nullable(),
  newHash: hashSchema.nullable(),
});

export const pushRequestSchema = z.object({
  protocol: z.literal(1),
  changes: z
    .array(pushChangeSchema)
    .min(1, 'at least one change required')
    .max(500, 'at most 500 changes per request')
    .superRefine((changes, ctx) => {
      // Invalid: (a) the same exact path twice (paths are already NFC), or (b) two live
      // entries (newHash !== null) sharing a pathKey — they would be the same file on a
      // case-insensitive FS. A delete + a live entry with the same pathKey is a casing
      // rename (Nota.md → nota.md) and is valid.
      const seenPaths = new Set<string>();
      const liveKeys = new Set<string>();
      for (const c of changes) {
        if (seenPaths.has(c.path)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `duplicate path in push request: ${c.path}`,
          });
          return;
        }
        seenPaths.add(c.path);
        if (c.newHash === null) continue;
        const key = pathKey(c.path);
        if (liveKeys.has(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `two live entries share the same path identity (case-insensitive): ${c.path}`,
          });
          return;
        }
        liveKeys.add(key);
      }
    }),
});

export const pushResultOkSchema = z.object({
  status: z.literal('ok'),
  path: vaultPathSchema,
  seq: z.number().int().min(1),
});

export const pushResultConflictSchema = z.object({
  status: z.literal('conflict'),
  path: vaultPathSchema,
  currentHash: hashSchema.nullable(),
});

export const pushResultSchema = z.discriminatedUnion('status', [
  pushResultOkSchema,
  pushResultConflictSchema,
]);

export const pushResponseSchema = z.object({
  results: z.array(pushResultSchema),
});

// ─── Join ─────────────────────────────────────────────────────────────────────

export const joinRequestSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/, 'invalid invite code format'),
});

export const groupSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
});

export const joinResponseSchema = z.object({
  group: groupSchema,
  role: roleSchema,
  deviceToken: z.string().min(1),
});

// ─── Device flow ──────────────────────────────────────────────────────────────

export const deviceAuthStartResponseSchema = z.object({
  deviceCode: z.string().min(1),
  userCode: z.string().min(1),
  verificationUrl: z.string().url(),
  interval: z.number().int().min(1),
  expiresIn: z.number().int().min(1),
});

const deviceAuthPendingSchema = z.object({ status: z.literal('pending') });
const deviceAuthSlowDownSchema = z.object({ status: z.literal('slow_down') });
const deviceAuthDeniedSchema = z.object({ status: z.literal('denied') });
const deviceAuthExpiredSchema = z.object({ status: z.literal('expired') });
const deviceAuthApprovedSchema = z.object({
  status: z.literal('approved'),
  deviceToken: z.string().min(1),
  group: groupSchema,
  role: roleSchema,
});

export const deviceAuthPollResponseSchema = z.discriminatedUnion('status', [
  deviceAuthPendingSchema,
  deviceAuthSlowDownSchema,
  deviceAuthDeniedSchema,
  deviceAuthExpiredSchema,
  deviceAuthApprovedSchema,
]);

// ─── Inferred types ───────────────────────────────────────────────────────────

export type Hash = z.infer<typeof hashSchema>;
export type VaultPath = z.infer<typeof vaultPathSchema>;
export type Role = z.infer<typeof roleSchema>;
export type ChangeEntry = z.infer<typeof changeEntrySchema>;
export type ChangesResponse = z.infer<typeof changesResponseSchema>;
export type PushChange = z.infer<typeof pushChangeSchema>;
export type PushRequest = z.infer<typeof pushRequestSchema>;
export type PushResult = z.infer<typeof pushResultSchema>;
export type PushResponse = z.infer<typeof pushResponseSchema>;
export type JoinRequest = z.infer<typeof joinRequestSchema>;
export type JoinResponse = z.infer<typeof joinResponseSchema>;
export type Group = z.infer<typeof groupSchema>;
export type DeviceAuthStartResponse = z.infer<typeof deviceAuthStartResponseSchema>;
export type DeviceAuthPollResponse = z.infer<typeof deviceAuthPollResponseSchema>;
