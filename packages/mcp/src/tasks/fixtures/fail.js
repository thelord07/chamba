/**
 * fail.js — CHAMBA-022, verify-runner real-process fixtures.
 *
 * Always exits 1, portably (no shell).
 */
console.log('boom');
process.exitCode = 1; // not process.exit(): it can cut piped stdout before it flushes
