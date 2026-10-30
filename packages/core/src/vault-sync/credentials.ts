/**
 * vault-sync/credentials.ts — store for ~/.chamba/credentials.json.
 * Written with mode 0600 (via writeBytes). Token never goes to vault or stdout.
 * Pure: no Node imports.
 */

import { z } from 'zod';
import type { FilesystemPort } from '../ports/filesystem.js';
import { joinPath } from '../util/path.js';

// ─── Schema ───────────────────────────────────────────────────────────────────

const credentialEntrySchema = z.object({
  token: z.string().min(1),
  user: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
  }),
  device: z.object({
    id: z.string().min(1),
    label: z.string().min(1),
  }),
  role: z.enum(['owner', 'admin', 'editor', 'reader']),
  /**
   * Custom vault directory (absolute canonical path). When absent, the default
   * location (resolveVaultDir) is used. Added in PARCHE-009; optional for
   * backward compatibility with credentials written before this release.
   */
  dir: z.string().min(1).optional(),
});

export const credentialsFileSchema = z.record(z.string(), credentialEntrySchema);

export type CredentialEntry = z.infer<typeof credentialEntrySchema>;
export type CredentialsFile = z.infer<typeof credentialsFileSchema>;

// ─── Path helper ──────────────────────────────────────────────────────────────

const CREDENTIALS_FILE = 'credentials.json';
const CHAMBA_DIR = '.chamba';

function credentialsPath(homedir: string): string {
  return joinPath(homedir, CHAMBA_DIR, CREDENTIALS_FILE);
}

function entryKey(server: string, slug: string): string {
  return `${server}|${slug}`;
}

// ─── CredentialsStore ─────────────────────────────────────────────────────────

export class CredentialsStore {
  constructor(
    private readonly fs: FilesystemPort,
    private readonly homedir: string,
  ) {}

  private async load(): Promise<CredentialsFile> {
    const path = credentialsPath(this.homedir);
    let text: string;
    try {
      text = await this.fs.readFile(path);
    } catch {
      return {};
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return {};
    }
    const result = credentialsFileSchema.safeParse(json);
    return result.success ? result.data : {};
  }

  private async save(data: CredentialsFile): Promise<void> {
    const dir = joinPath(this.homedir, CHAMBA_DIR);
    await this.fs.mkdir(dir);
    const path = credentialsPath(this.homedir);
    const bytes = new TextEncoder().encode(JSON.stringify(data, null, 2));
    // Write with mode 0600 so the token is never world-readable
    await this.fs.writeBytes(path, bytes, { mode: 0o600 });
  }

  async get(server: string, slug: string): Promise<CredentialEntry | null> {
    const data = await this.load();
    return data[entryKey(server, slug)] ?? null;
  }

  async set(server: string, slug: string, entry: CredentialEntry): Promise<void> {
    const data = await this.load();
    data[entryKey(server, slug)] = entry;
    await this.save(data);
  }

  async remove(server: string, slug: string): Promise<void> {
    const data = await this.load();
    delete data[entryKey(server, slug)];
    await this.save(data);
  }

  /** List all stored (server, slug) pairs. */
  async listSlugs(): Promise<Array<{ server: string; slug: string }>> {
    const data = await this.load();
    return Object.keys(data).map((key) => {
      const idx = key.lastIndexOf('|');
      return { server: key.slice(0, idx), slug: key.slice(idx + 1) };
    });
  }
}
