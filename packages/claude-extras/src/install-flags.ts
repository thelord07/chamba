/**
 * Whether the installer should skip the interactive config wizard. True when the
 * user opts out explicitly (`--yes` / `--defaults`) or stdin isn't a TTY (CI,
 * pipes, scripts) — in every case the compiled recommended defaults apply.
 */
export function isNonInteractive(args: string[], isTTY: boolean): boolean {
  return args.includes('--yes') || args.includes('--defaults') || !isTTY;
}
