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
    message: `unknown model '${id}'; run 'chamba-config models' to list valid model ids`,
  }),
);

export const agentConfigSchema = z.object({
  model: modelSchema,
  effort: effortSchema,
  reasoning_priority: reasoningPrioritySchema,
});

export const partialAgentConfigSchema = agentConfigSchema.partial();

/**
 * What a config file on disk may contain. Both `defaults` and `overrides` are
 * optional and partial per role — a project file can carry just one role's one
 * field. Unknown roles and unknown models are rejected with clear messages.
 */
export const configFileSchema = z
  .object({
    version: z.literal(1),
    defaults: z.record(roleSchema, partialAgentConfigSchema).optional(),
    overrides: z.record(roleSchema, partialAgentConfigSchema).optional(),
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
