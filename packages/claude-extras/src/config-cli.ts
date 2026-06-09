import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { NodeFilesystem } from '@chamba/adapters';
import {
  AGENT_ROLES,
  type AgentConfig,
  type AgentRole,
  ConfigError,
  type FilesystemPort,
  joinPath,
  loadConfig,
  MODEL_CATALOG,
  type WorktreeConfig,
} from '@chamba/core';
import { confirm } from '@inquirer/prompts';
import { ConfigStore } from './config-store.js';
import { Installer } from './installer.js';
import { runWizard, runWorktreesWizard } from './wizard.js';

const CONFIG_RELATIVE = '.chamba/config.json';

function globalConfigPath(): string {
  return joinPath(homedir(), CONFIG_RELATIVE);
}

function projectConfigPath(): string {
  return joinPath(process.cwd(), CONFIG_RELATIVE);
}

// --- testable command handlers ----------------------------------------------

export function formatModels(): string {
  const lines = ['Available models:'];
  for (const m of MODEL_CATALOG) {
    const thinking = m.supports_thinking ? 'thinking' : 'no-thinking';
    lines.push(`  ${m.id.padEnd(24)} ${m.provider.padEnd(10)} ${thinking}  — ${m.description}`);
  }
  return lines.join('\n');
}

export async function formatShow(
  fs: FilesystemPort,
  paths: { globalPath: string; projectPath: string },
): Promise<string> {
  const { config, sources } = await loadConfig(fs, paths);
  const lines = ['role           model                     effort    priority'];
  for (const role of AGENT_ROLES) {
    const c = config[role];
    lines.push(
      `${role.padEnd(15)}${c.model.padEnd(26)}${c.effort.padEnd(10)}${c.reasoning_priority}`,
    );
  }
  lines.push('');
  for (const s of sources) {
    const where = s.path ? ` (${s.path})` : '';
    const note = s.status === 'invalid' ? ` — IGNORED: ${s.error}` : '';
    lines.push(`source: ${s.kind} [${s.status}]${where}${note}`);
  }
  return lines.join('\n');
}

export async function cmdSet(
  store: ConfigStore,
  args: { role: string; model: string; effort?: string },
): Promise<string> {
  if (!AGENT_ROLES.includes(args.role as AgentRole)) {
    throw new ConfigError(`unknown role '${args.role}'; valid roles: ${AGENT_ROLES.join(', ')}`);
  }
  const patch: Partial<AgentConfig> = { model: args.model };
  if (args.effort !== undefined) patch.effort = args.effort as AgentConfig['effort'];
  await store.setRole(args.role as AgentRole, patch);
  const effortNote = args.effort ? ` with effort ${args.effort}` : '';
  return `Set ${args.role} → ${args.model}${effortNote}. Run 'config apply' to regenerate subagents.`;
}

export function formatWorktrees(w: WorktreeConfig): string {
  return [
    'worktrees config:',
    `  layout           ${w.layout}`,
    `  root             ${w.root}`,
    `  branchPrefix     ${w.branchPrefix}`,
    `  baseBranch       ${w.baseBranch}`,
    `  copyEnvFiles     ${w.copyEnvFiles}`,
    `  editorWorkspace  ${w.editorWorkspace ?? '(none)'}`,
    `  repos            ${w.repos ? w.repos.join(', ') : '(autodetect)'}`,
    `  command          ${w.command ?? '(none)'}`,
  ].join('\n');
}

// --- command router ----------------------------------------------------------

function buildInstaller(fs: FilesystemPort): Installer {
  const home = homedir();
  const assetsDir = fileURLToPath(new URL('../assets', import.meta.url));
  return new Installer({
    fs,
    assetsDir,
    claudeDir: joinPath(home, '.claude'),
    claudeJsonPath: joinPath(home, '.claude.json'),
    globalConfigPath: globalConfigPath(),
  });
}

function parseEffortFlag(rest: string[]): string | undefined {
  const i = rest.indexOf('--effort');
  return i >= 0 ? rest[i + 1] : undefined;
}

const USAGE =
  'Usage: chamba-install config <show|models|set|reset|wizard|apply|edit>\n' +
  '  show                                   resolved config + where each value comes from\n' +
  '  models                                 list the available models\n' +
  '  set <role> <model> [--effort <level>]  change one role\n' +
  '  reset [--yes]                          restore defaults\n' +
  '  wizard [--defaults]                    (re)run the interactive wizard\n' +
  '  worktrees <show|init>                  show or configure the multi-repo worktree policy\n' +
  '  apply                                  regenerate ~/.claude/agents from the config\n' +
  '  edit                                   open the config in $EDITOR\n';

/**
 * Run a `config` subcommand. Catches `ConfigError` to print a clean message and
 * set a non-zero exit code rather than throwing.
 */
export async function runConfigCommand(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  const fs = new NodeFilesystem();
  const store = new ConfigStore(fs, globalConfigPath());

  try {
    switch (command) {
      case 'show':
        process.stdout.write(
          `${await formatShow(fs, { globalPath: globalConfigPath(), projectPath: projectConfigPath() })}\n`,
        );
        return;
      case 'models':
        process.stdout.write(`${formatModels()}\n`);
        return;
      case 'set': {
        const [role, model] = rest;
        if (!role || !model) {
          process.stderr.write('Usage: config set <role> <model> [--effort <level>]\n');
          process.exitCode = 1;
          return;
        }
        process.stdout.write(
          `${await cmdSet(store, { role, model, effort: parseEffortFlag(rest) })}\n`,
        );
        return;
      }
      case 'reset': {
        const confirmed =
          rest.includes('--yes') ||
          (await confirm({ message: 'Reset config to defaults?', default: false }));
        if (!confirmed) {
          process.stdout.write('Cancelled.\n');
          return;
        }
        await store.reset();
        process.stdout.write(`Reset config to defaults at ${store.filePath}.\n`);
        return;
      }
      case 'wizard': {
        const config = await runWizard({ nonInteractive: rest.includes('--defaults') });
        if (!config) {
          process.stdout.write('Wizard cancelled. Config unchanged.\n');
          return;
        }
        await store.write(config);
        await buildInstaller(fs).applyConfig();
        process.stdout.write(`Wrote ${store.filePath} and regenerated subagents.\n`);
        return;
      }
      case 'worktrees': {
        const sub = rest[0];
        if (sub === 'show') {
          const { worktrees } = await loadConfig(fs, {
            globalPath: globalConfigPath(),
            projectPath: projectConfigPath(),
          });
          process.stdout.write(`${formatWorktrees(worktrees)}\n`);
          return;
        }
        if (sub === 'init') {
          const patch = await runWorktreesWizard();
          await store.setWorktrees(patch);
          process.stdout.write(
            `Wrote worktrees config to ${store.filePath}.${patch.copyEnvFiles ? ` Tip: add '${patch.root}/' to your .gitignore.` : ''}\n`,
          );
          return;
        }
        process.stderr.write('Usage: config worktrees <show|init>\n');
        process.exitCode = sub ? 1 : 0;
        return;
      }
      case 'apply': {
        const result = await buildInstaller(fs).applyConfig();
        process.stdout.write(
          `Applied config: ${result.regenerated.length} regenerated, ${result.unchanged.length} unchanged.\n`,
        );
        return;
      }
      case 'edit': {
        const editor = process.env.EDITOR;
        if (!(await fs.exists(store.filePath))) await store.reset();
        if (!editor) {
          process.stdout.write(`No $EDITOR set. Edit this file directly:\n${store.filePath}\n`);
          return;
        }
        spawnSync(editor, [store.filePath], { stdio: 'inherit' });
        return;
      }
      default:
        process.stderr.write(USAGE);
        process.exitCode = command ? 1 : 0;
    }
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`config error: ${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}
