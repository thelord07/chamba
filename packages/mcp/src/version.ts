import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Read @chamba/mcp's own version from its package.json. Resolves the same file
 * whether running from source (`src/version.ts` → `../package.json`) or from the
 * bundle (`dist/main.js` → `../package.json`), so `--version` and the MCP
 * handshake both report the real, published version. Never throws.
 */
export function readPackageVersion(): string {
  try {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
