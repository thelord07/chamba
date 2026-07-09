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
    baseBranch: z.string().min(1).optional(),
    copyEnvFiles: z.boolean().optional(),
    envPruneDirs: z.array(z.string()).optional(),
    editorWorkspace: z.enum(['code-workspace']).nullable().optional(),
    repos: z.array(z.string()).nullable().optional(),
    command: z.string().nullable().optional(),
    maxParallel: z.number().int().positive().nullable().optional(),
    perWorkerMemMB: z.number().int().positive().nullable().optional(),
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
