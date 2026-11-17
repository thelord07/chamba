/**
 * pass.js — CHAMBA-022, verify-runner real-process fixtures.
 *
 * Plain, portable `node pass.js` script (no shell, no OS-specific syntax):
 * always exits 0. Used by verify-runner-real-process.test.ts to exercise
 * `chamba_task action=verify` end to end against a REAL `NodeProcess`.
 */
console.log('ok');
process.exitCode = 0; // not process.exit(): it can cut piped stdout before it flushes
