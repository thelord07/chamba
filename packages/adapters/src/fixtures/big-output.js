// Portable fixture: writes > 4 MiB to STDOUT ONLY (NN2: a single stream,
// never interleaved with stderr, to avoid flaky ordering) then a distinct
// final line, then exits 0. Used to prove the ring buffer truncates while
// the process still finishes normally (B4) and the LAST line survives.
const LINE = `${'x'.repeat(1000)}\n`;
const TARGET_BYTES = 4 * 1024 * 1024 + 50_000; // a bit over 4 MiB

let written = 0;
while (written < TARGET_BYTES) {
  process.stdout.write(LINE);
  written += LINE.length;
}
process.stdout.write('LAST-LINE-MARKER\n');
// Deliberately NOT calling process.exit(0): on a piped stdout, exit() can
// truncate output that hasn't finished flushing to the OS yet. Letting the
// event loop drain naturally guarantees every byte is flushed before the
// process exits (with code 0, since nothing failed).
