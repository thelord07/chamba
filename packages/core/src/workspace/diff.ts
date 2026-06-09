/**
 * Line-based diff (LCS) producing a readable unified-ish output:
 *   `  ` unchanged, `- ` removed, `+ ` added.
 *
 * Used by `workspace_reload` to show the model what a re-scan would change,
 * without ever overwriting the user's hand-edited `workspace.md`.
 */
export function diffLines(oldText: string, newText: string): string {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const n = a.length;
  const m = b.length;

  // dp[i][j] = length of LCS of a[i:] and b[j:]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i] as number[];
    const next = dp[i + 1] as number[];
    for (let j = m - 1; j >= 0; j--) {
      row[j] =
        a[i] === b[j]
          ? (next[j + 1] as number) + 1
          : Math.max(next[j] as number, row[j + 1] as number);
    }
  }

  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++;
      j++;
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      out.push(`- ${a[i]}`);
      i++;
    } else {
      out.push(`+ ${b[j]}`);
      j++;
    }
  }
  while (i < n) out.push(`- ${a[i++]}`);
  while (j < m) out.push(`+ ${b[j++]}`);

  return out.join('\n');
}

/** True when the two texts are identical line-for-line. */
export function textsEqual(oldText: string, newText: string): boolean {
  return oldText === newText;
}
