import type { ClockPort } from '../ports/clock.js';
import type { FilesystemPort } from '../ports/filesystem.js';
import { joinPath } from '../util/path.js';
import { renderWorkspaceMarkdown, type Workspace } from '../workspace/workspace.js';

/** Seed note written at the vault root with the initial workspace context. */
export const VAULT_OVERVIEW_FILE = 'Workspace overview.md';

export interface SeedVaultInput {
  /** Vault root — the directory that will hold `.obsidian/`. */
  vaultPath: string;
  /** Scanned workspace, rendered into the overview note. */
  workspace: Workspace;
}

export interface SeedVaultResult {
  vaultPath: string;
  markerPath: string;
  overviewPath: string;
  createdMarker: boolean;
  createdOverview: boolean;
}

/**
 * Bootstrap an Obsidian vault: drop the `.obsidian/` marker that makes a folder a
 * vault, and seed a "Workspace overview" note from the scan. Idempotent — it never
 * recreates the marker or overwrites an existing overview (the user may edit it).
 * NO LLM, no Node APIs (principle 6): all IO goes through `FilesystemPort`.
 */
export class VaultInitializer {
  constructor(
    private readonly fs: FilesystemPort,
    private readonly clock: ClockPort,
  ) {}

  async seed({ vaultPath, workspace }: SeedVaultInput): Promise<SeedVaultResult> {
    const obsidianDir = joinPath(vaultPath, '.obsidian');
    const markerPath = joinPath(obsidianDir, 'app.json');
    let createdMarker = false;
    if (!(await this.fs.exists(markerPath))) {
      await this.fs.mkdir(obsidianDir);
      await this.fs.writeFile(markerPath, '{}\n');
      createdMarker = true;
    }

    const overviewPath = joinPath(vaultPath, VAULT_OVERVIEW_FILE);
    let createdOverview = false;
    if (!(await this.fs.exists(overviewPath))) {
      await this.fs.writeFile(overviewPath, this.renderOverview(workspace));
      createdOverview = true;
    }

    return { vaultPath, markerPath, overviewPath, createdMarker, createdOverview };
  }

  private renderOverview(workspace: Workspace): string {
    const frontmatter = [
      '---',
      'title: Workspace overview',
      `date: ${this.clock.today()}`,
      'tags: [chamba, workspace, overview]',
      'source: chamba',
      '---',
      '',
    ].join('\n');
    return `${frontmatter}${renderWorkspaceMarkdown(workspace)}\n`;
  }
}
