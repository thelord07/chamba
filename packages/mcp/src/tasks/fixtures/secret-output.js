/**
 * secret-output.js — CHAMBA-022, verify-runner real-process fixtures.
 *
 * Emits 250 numbered lines on a single stream (NN2: stdout only, to avoid
 * flaky stdout/stderr interleaving) followed by a secret-shaped value built
 * by concatenation at runtime (never a literal in source, same convention
 * as task.test.ts's FAKE_SECRET) and exits 0.
 *
 * Used to prove, against a REAL NodeProcess (not a fake), that:
 *   - the evidence written to disk keeps only the last 200 lines (tailRing),
 *   - the secret value never reaches the written .md file, redacted or not.
 */
for (let i = 1; i <= 250; i++) {
  console.log(`line-${String(i).padStart(4, '0')}`);
}
const secret = `${'AKIA'}${'ABCDEFGHIJKLMNOP'}`;
console.log(`token=${secret}`);
process.exit(0);
