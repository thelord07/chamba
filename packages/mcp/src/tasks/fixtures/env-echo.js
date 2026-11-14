/**
 * env-echo.js — CHAMBA-022, verify-runner real-process fixtures (O7).
 *
 * Prints whether CHAMBA_TEST_SECRETISH is visible to this process, so
 * verify-runner-real-process.test.ts can prove, against a REAL
 * NodeProcess, that a variable outside the O7 allowlist present in the
 * parent process does NOT reach the child unless `inheritEnv: true` is
 * set on that verify command.
 */
const value = process.env.CHAMBA_TEST_SECRETISH;
console.log(`CHAMBA_TEST_SECRETISH=${value === undefined ? '<absent>' : value}`);
process.exit(0);
