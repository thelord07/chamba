// Portable fixture: prints its argv (everything after the script path) as
// JSON on stdout, exits 0. Used to prove args arrive literal — no shell
// interpolation, no splitting of spaces/`;` that weren't already separate
// argv entries.
console.log(JSON.stringify(process.argv.slice(2)));
process.exit(0);
