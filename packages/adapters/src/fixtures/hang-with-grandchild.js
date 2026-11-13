// Portable fixture: `node hang-with-grandchild.js <pidFile>` spawns
// `sleep-forever.js` as its own child (the GRANDCHILD of whatever spawned
// this script), writes the grandchild's pid to `pidFile`, then hangs
// forever itself. Used to prove timeout tree-kill reaches the grandchild
// too, not just the direct child (B5).
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pidFile = process.argv[2];
const here = dirname(fileURLToPath(import.meta.url));
const grandchild = spawn(process.execPath, [join(here, 'sleep-forever.js')], {
  stdio: 'ignore',
});
writeFileSync(pidFile, String(grandchild.pid));

setInterval(() => {}, 1000);
