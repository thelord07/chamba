import {
  AGENT_ROLES,
  type AgentConfig,
  type AgentRole,
  type ConfigFile,
  DEFAULT_CONFIG,
  EFFORT_LEVELS,
  type Effort,
  MODEL_CATALOG,
  ROLE_DESCRIPTIONS,
} from '@chamba/core';
import { confirm, select } from '@inquirer/prompts';

export interface RoleAnswer {
  role: AgentRole;
  model: string;
  effort: Effort;
}

/** The full default config as an on-disk file shape. */
export function defaultConfigFile(): ConfigFile {
  return { version: 1, defaults: DEFAULT_CONFIG.defaults };
}

/**
 * Pure: turn the wizard's per-role answers into a config file. The
 * `reasoning_priority` is derived from the role's default (not asked), so the
 * wizard only collects model + effort.
 */
export function buildConfigFromAnswers(answers: RoleAnswer[]): ConfigFile {
  const defaults = {} as Record<AgentRole, AgentConfig>;
  for (const role of AGENT_ROLES) {
    const answer = answers.find((a) => a.role === role);
    const base = DEFAULT_CONFIG.defaults[role];
    defaults[role] = answer
      ? { model: answer.model, effort: answer.effort, reasoning_priority: base.reasoning_priority }
      : base;
  }
  return { version: 1, defaults };
}

function modelChoices() {
  return MODEL_CATALOG.map((m) => ({
    name: `${m.label} — ${m.description}`,
    value: m.id,
  }));
}

function effortChoices() {
  return EFFORT_LEVELS.map((e) => ({ name: e, value: e }));
}

/** Thrown by inquirer on Ctrl+C / ESC. */
function isCancellation(e: unknown): boolean {
  return e instanceof Error && e.name === 'ExitPromptError';
}

/**
 * Run the interactive wizard. Returns the chosen config, or `null` if the user
 * cancelled (Ctrl+C) — callers should then fall back to defaults without failing.
 * With `nonInteractive`, returns the defaults without asking anything (CI-safe).
 */
export async function runWizard(
  opts: { nonInteractive?: boolean } = {},
): Promise<ConfigFile | null> {
  if (opts.nonInteractive) return defaultConfigFile();

  try {
    process.stdout.write(
      'chamba per-agent config\n' +
        'Pick which model + effort each role uses. chamba never calls these models —\n' +
        "this only tells your editor's model how to delegate. You can change it later\n" +
        'with `npx @chamba/claude-extras config`.\n\n',
    );

    const useDefaults = await confirm({
      message: 'Use the recommended defaults? (No lets you customize each role)',
      default: true,
    });
    if (useDefaults) return defaultConfigFile();

    const answers: RoleAnswer[] = [];
    for (const role of AGENT_ROLES) {
      const model = await select({
        message: `${role} — ${ROLE_DESCRIPTIONS[role]}`,
        choices: modelChoices(),
        default: DEFAULT_CONFIG.defaults[role].model,
      });
      const effort = await select({
        message: `  effort for ${role}`,
        choices: effortChoices(),
        default: DEFAULT_CONFIG.defaults[role].effort,
      });
      answers.push({ role, model, effort });
    }

    process.stdout.write('\nSummary:\n');
    for (const a of answers) {
      process.stdout.write(`  ${a.role.padEnd(13)} ${a.model}  ·  ${a.effort}\n`);
    }
    const ok = await confirm({ message: 'Write this config?', default: true });
    return ok ? buildConfigFromAnswers(answers) : null;
  } catch (e) {
    if (isCancellation(e)) return null;
    throw e;
  }
}
