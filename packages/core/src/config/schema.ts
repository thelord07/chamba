import { z } from 'zod';
import { getModel } from '../models/catalog.js';
import {
  AGENT_ROLES,
  type AgentRole,
  EFFORT_LEVELS,
  type Effort,
  REASONING_PRIORITIES,
  type ReasoningPriority,
} from './roles.js';

export const effortSchema = z.enum([...EFFORT_LEVELS] as [Effort, ...Effort[]]);
export const reasoningPrioritySchema = z.enum([...REASONING_PRIORITIES] as [
  ReasoningPriority,
  ...ReasoningPriority[],
]);
export const roleSchema = z.enum([...AGENT_ROLES] as [AgentRole, ...AgentRole[]]);

/** A model id that must exist in the catalog. */
export const modelSchema = z.string().refine(
  (id) => getModel(id) !== undefined,
  (id) => ({
    message: `unknown model '${id}'; run the config 'models' command to list valid model ids`,
  }),
);

export const agentConfigSchema = z.object({
  model: modelSchema,
  effort: effortSchema,
  reasoning_priority: reasoningPrioritySchema,
});

export const partialAgentConfigSchema = agentConfigSchema.partial();

/** A relative, traversal-free path component (no `..`, not absolute). */
const safePathSchema = z.string().refine((s) => !s.includes('..') && !s.startsWith('/'), {
  message: 'must be a relative path without ".."',
});

/** A valid environment-variable name (used as a `z.record` key). */
const envKeySchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be a valid env var name');

/** A repo name as it appears in `Workspace.projects[].name` (CHAMBA-022, N11). */
const repoNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'invalid repo name');

/**
 * A `verify` command for `chamba_task action='verify'` (CHAMBA-022, D-4/O7).
 * `command` is the bare executable — never a shell string: no whitespace, no
 * shell metacharacters. Args go in `args` as a plain array; chamba never
 * parses a string into argv (that's where injection is born).
 */
export const verifyCommandSchema = z
  .object({
    // Doubles as the evidence filename (`tests-<name>.md`) — restricted to
    // chars valid on all three OSes.
    name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'must be lowercase kebab-case'),
    command: z
      .string()
      .min(1)
      .refine((s) => !/[\s;&|`$(){}<>"'*?~[\]!]/.test(s), {
        message: 'el comando no puede tener espacios ni metacaracteres; separá los args en `args`',
      }),
    args: z.array(z.string()).max(32).default([]),
    cwd: safePathSchema.optional(),
    timeoutSec: z.number().int().min(1).max(1800).default(600),
    /** Escape hatch (O7): extra env vars on top of the allowlist. */
    env: z.record(envKeySchema, z.string()).optional(),
    /** Opt-in (O7): inherit the full parent env instead of the allowlist. */
    inheritEnv: z.boolean().default(false),
  })
  .strict();

export type VerifyCommandConfig = z.infer<typeof verifyCommandSchema>;

/** The `worktrees` block of a config file (all fields optional). */
export const worktreeConfigSchema = z
  .object({
    layout: z.enum(['sibling', 'nested']).optional(),
    root: safePathSchema.optional(),
    branchPrefix: z
      .string()
      .refine((s) => !s.includes('..') && !/\s/.test(s), {
        message: 'branchPrefix must have no spaces and no ".."',
      })
      .optional(),
    baseBranch: z
      .union([z.string().min(1), z.record(z.string().min(1), z.string().min(1))])
      .optional(),
    copyEnvFiles: z.boolean().optional(),
    envPruneDirs: z.array(z.string()).optional(),
    editorWorkspace: z.enum(['code-workspace']).nullable().optional(),
    repos: z.array(z.string()).nullable().optional(),
    command: z.string().nullable().optional(),
    maxParallel: z.number().int().positive().nullable().optional(),
    perWorkerMemMB: z.number().int().positive().nullable().optional(),
    ports: z
      .object({
        enabled: z.boolean().optional(),
        base: z.number().int().min(1).max(65535).optional(),
        step: z.number().int().positive().max(10000).optional(),
        envKey: z
          .string()
          .min(1)
          .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'envKey must be a valid env var name')
          .optional(),
      })
      .strict()
      .nullable()
      .optional(),
    overlap: z.object({ failOnOverlap: z.boolean().optional() }).strict().optional(),
  })
  .strict();

/**
 * What a config file on disk may contain. `defaults`/`overrides` are optional
 * and partial per role; `worktrees` is the optional multi-repo worktree policy.
 * Unknown roles, unknown models and unknown keys are rejected with clear messages.
 */
export const configFileSchema = z
  .object({
    version: z.literal(1),
    defaults: z.record(roleSchema, partialAgentConfigSchema).optional(),
    overrides: z.record(roleSchema, partialAgentConfigSchema).optional(),
    worktrees: worktreeConfigSchema.optional(),
    /** Per-repo `verify` commands for `chamba_task` (CHAMBA-022). */
    repos: z
      .record(repoNameSchema, z.object({ verify: z.array(verifyCommandSchema).max(10) }).strict())
      .optional(),
    /**
     * Vault-wide sync policy (CHAMBA-022, O1 — owner decision). Default
     * `syncEvidence: false`: images under a task's evidence subtree
     * (`tareas/<id>/evidencia/...`) are excluded from
     * `chamba_vault_sync`/autosync; `report.md`/`tests-*.md` always sync.
     * Setting it `true` opts into syncing the images too.
     */
    vault: z
      .object({ syncEvidence: z.boolean().default(false) })
      .strict()
      .optional(),
  })
  .strict();

export type ConfigFile = z.infer<typeof configFileSchema>;

export type ParseResult = { ok: true; value: ConfigFile } | { ok: false; error: string };

/** Validate raw (parsed-JSON) data as a chamba config file. */
export function parseChambaConfig(raw: unknown): ParseResult {
  const result = configFileSchema.safeParse(raw);
  if (result.success) return { ok: true, value: result.data };
  const error = result.error.issues
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
  return { ok: false, error };
}
