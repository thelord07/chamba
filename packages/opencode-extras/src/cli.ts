import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { NodeFilesystem } from '@chamba/adapters';
import { joinPath } from '@chamba/core';
import { OpencodeInstaller, type OpencodeInstallResult } from './installer.js';

/** OpenCode's global config dir — honors OPENCODE_CONFIG_DIR, else ~/.config/opencode. */
function opencodeConfigDir(): string {
  const override = process.env.OPENCODE_CONFIG_DIR?.trim();
  return override ? override : joinPath(homedir(), '.config/opencode');
}

function buildInstaller(): OpencodeInstaller {
  return new OpencodeInstaller({
    fs: new NodeFilesystem(),
    // assets/ ships alongside dist/ in the published package (copied from claude-extras).
    assetsDir: fileURLToPath(new URL('../assets', import.meta.url)),
    opencodeDir: opencodeConfigDir(),
    globalConfigPath: joinPath(homedir(), '.chamba/config.json'),
  });
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

/**
 * Install `@chamba/mcp` globally (pinned to this version) so OpenCode can launch
 * the `chamba-mcp` binary directly. Returns false if npm isn't available or the
 * install fails — the caller then falls back to the npx launcher.
 */
function installGlobalBinary(): boolean {
  const version = readPackageVersion();
  const spec = version === 'unknown' ? '@chamba/mcp' : `@chamba/mcp@${version}`;
  process.stdout.write(`Installing ${spec} globally (npm i -g)…\n`);
  try {
    return spawnSync('npm', ['install', '-g', spec], { stdio: 'inherit' }).status === 0;
  } catch {
    return false;
  }
}

function summarize(result: OpencodeInstallResult, global = false): string {
  const launcher = global ? ' (launches the global `chamba-mcp` binary — no npx per spawn)' : '';
  const mcp = result.mcpAdded
    ? `Registered chamba MCP server in opencode.json${launcher}`
    : result.mcpAlreadyPresent
      ? 'chamba MCP server already present in opencode.json'
      : 'Could not register chamba MCP server';
  const lines = [
    `Installed ${result.counts.commands ?? 0} commands, ${result.counts.agents ?? 0} agents. ${mcp}`,
  ];
  if (result.skipped.length > 0) {
    lines.push(
      `Skipped ${result.skipped.length} existing file(s). Re-run with --force to overwrite.`,
    );
  }
  lines.push('Restart OpenCode so it picks up the new commands, agents and MCP server.');
  return lines.join('\n');
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
      `Removed ${result.removed.length} file(s). ${
        result.mcpRemoved ? 'Removed' : 'Did not find'
      } chamba MCP server in opencode.json\n`,
    );
    return;
  }

  if (command === undefined || command === 'install') {
    const force = rest.includes('--force');
    const wantGlobal = rest.includes('--global');
    let useGlobal = false;
    if (wantGlobal) {
      useGlobal = installGlobalBinary();
      if (!useGlobal) {
        process.stdout.write(
          'Could not install @chamba/mcp globally — registering the npx launcher instead.\n' +
            'Install it yourself (`npm i -g @chamba/mcp`) and re-run with --global for a steadier launch.\n',
        );
      }
    }
    const result = await installer.install({ force, global: useGlobal });
    process.stdout.write(`${summarize(result, useGlobal)}\n`);
    return;
  }

  process.stderr.write(
    `Unknown command "${command}". Usage: chamba-opencode [install|uninstall] [--force] [--global] [--version]\n`,
  );
  process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`chamba-opencode failed: ${(err as Error).message}\n`);
  process.exit(1);
});
