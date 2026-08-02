// Build/test step: copy the command + agent bodies from @chamba/claude-extras so
// there is a SINGLE source of truth for the prompts. The copy is shipped in this
// package (files: ["assets"]) and gitignored in the repo — never hand-edited here.
import { cpSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const at = (p) => fileURLToPath(new URL(p, import.meta.url));
const src = at('../../claude-extras/assets');
const dest = at('../assets');

if (!existsSync(`${src}/commands`)) {
  console.error(`copy-assets: source assets not found at ${src} — run inside the monorepo.`);
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
for (const category of ['commands', 'agents']) {
  cpSync(`${src}/${category}`, `${dest}/${category}`, { recursive: true });
}
console.log('copy-assets: copied commands + agents from @chamba/claude-extras.');
