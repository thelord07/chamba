// Portable fixture: `node exit-code.js <code>` exits with the given code
// (default 0), after printing one line to stdout so callers always get at
// least one line of output to assert on.
const code = Number(process.argv[2] ?? '0');
console.log(`exit-code fixture: saliendo con ${code}`);
process.exit(code);
