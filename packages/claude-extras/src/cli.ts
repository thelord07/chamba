import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { NodeFilesystem } from '@chamba/adapters';
import { joinPath } from '@chamba/core';
import { runConfigCommand } from './config-cli.js';
import { ConfigStore } from './config-store.js';
import { CATEGORIES, Installer, type InstallResult } from './installer.js';
import { runWizard } from './wizard.js';

function buildInstaller(): Installer {
  const home = homedir();
  // assets/ ships alongside dist/ in the published package.
  const assetsDir = fileURLToPath(new URL('../assets', import.meta.url));
  return new Installer({
    fs: new NodeFilesystem(),
    assetsDir,
    claudeDir: joinPath(home, '.claude'),
    claudeJsonPath: joinPath(home, '.claude.json'),
    globalConfigPath: joinPath(home, '.chamba/config.json'),
  });
}

function summarize(result: InstallResult): string {
  const part = (dir: string) => `${result.counts[dir] ?? 0} ${labelFor(dir)}`;
  const mcpSentence = result.mcpAdded
    ? 'Added chamba MCP server to ~/.claude.json'
    : result.mcpAlreadyPresent
      ? 'chamba MCP server already present in ~/.claude.json'
      : 'Could not add chamba MCP server to ~/.claude.json';
  const lines: string[] = [];
  lines.push(`Installed ${CATEGORIES.map(({ dir }) => part(dir)).join(', ')}. ${mcpSentence}`);
  if (result.skipped.length > 0) {
    lines.push(`Skipped ${result.skipped.length} existing file(s): ${result.skipped.join(', ')}`);
    lines.push('Re-run with --force to overwrite them.');
  }
  if (!result.claudeDetected) {
    lines.push(
      'Note: Claude Code was not detected (~/.claude not found). Files were created anyway.',
    );
  }
  return lines.join('\n');
}

function labelFor(dir: string): string {
  return CATEGORIES.find((c) => c.dir === dir)?.label ?? dir;
}

/** Read this package's version from its package.json, next to the built file. */
function readPackageVersion(): string {
  try {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (command === '--version' || command === '-v' || command === 'version') {
    process.stdout.write(`${readPackageVersion()}\n`);
    return;
  }

  const installer = buildInstaller();

  if (command === 'uninstall') {
    const result = await installer.uninstall();
    process.stdout.write(
      `Removed ${result.removed.length} file(s). ${result.mcpRemoved ? 'Removed' : 'Did not find'} chamba MCP server in ~/.claude.json\n`,
    );
    return;
  }

  if (command === 'config') {
    await runConfigCommand(rest);
    return;
  }

  if (command === 'apply') {
    const result = await installer.applyConfig();
    process.stdout.write(
      `Applied config: ${result.regenerated.length} subagent(s) regenerated, ${result.unchanged.length} unchanged.\n`,
    );
    return;
  }

  if (command === undefined || command === 'install') {
    const force = rest.includes('--force');
    await maybeRunWizard(rest);
    const result = await installer.install({ force });
    process.stdout.write(`${summarize(result)}\n`);
    return;
  }

  process.stderr.write(
    `Unknown command "${command}". Usage: chamba-install [install|uninstall|apply|config <sub>] [--force] [--version]\n`,
  );
  process.exitCode = 1;
}

/**
 * On first install, offer the config wizard — but never block the install. With
 * `--defaults` or a non-TTY stdin (CI), skip it silently and let the compiled
 * defaults apply. If the user cancels (Ctrl+C), install proceeds with defaults.
 */
async function maybeRunWizard(rest: string[]): Promise<void> {
  const fs = new NodeFilesystem();
  const configPath = joinPath(homedir(), '.chamba/config.json');
  if (await fs.exists(configPath)) return; // already configured

  const nonInteractive = rest.includes('--defaults') || !process.stdin.isTTY;
  if (nonInteractive) return;

  const config = await runWizard();
  if (!config) {
    process.stdout.write(
      'Wizard skipped — using recommended defaults. Run `npx @chamba/claude-extras config wizard` anytime.\n',
    );
    return;
  }
  await new ConfigStore(fs, configPath).write(config);
}

main().catch((err) => {
  process.stderr.write(`chamba-install failed: ${(err as Error).message}\n`);
  process.exit(1);
});
