import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { NodeFilesystem } from '@chamba/adapters';
import { joinPath } from '@chamba/core';
import { CATEGORIES, Installer, type InstallResult } from './installer.js';

function buildInstaller(): Installer {
  const home = homedir();
  // assets/ ships alongside dist/ in the published package.
  const assetsDir = fileURLToPath(new URL('../assets', import.meta.url));
  return new Installer({
    fs: new NodeFilesystem(),
    assetsDir,
    claudeDir: joinPath(home, '.claude'),
    claudeJsonPath: joinPath(home, '.claude.json'),
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

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const installer = buildInstaller();

  if (command === 'uninstall') {
    const result = await installer.uninstall();
    process.stdout.write(
      `Removed ${result.removed.length} file(s). ${result.mcpRemoved ? 'Removed' : 'Did not find'} chamba MCP server in ~/.claude.json\n`,
    );
    return;
  }

  if (command === undefined || command === 'install') {
    const force = rest.includes('--force');
    const result = await installer.install({ force });
    process.stdout.write(`${summarize(result)}\n`);
    return;
  }

  process.stderr.write(
    `Unknown command "${command}". Usage: chamba-install [install|uninstall] [--force]\n`,
  );
  process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`chamba-install failed: ${(err as Error).message}\n`);
  process.exit(1);
});
