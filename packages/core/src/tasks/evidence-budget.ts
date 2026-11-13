/**
 * tasks/evidence-budget.ts — CHAMBA-022
 *
 * `planEvidenceCopy` decides, per file, whether it gets copied into the
 * task's evidence tree or only linked (because it would blow a budget).
 * Pure: no IO, no filesystem — the caller already knows each file's size.
 *
 * Limits (§2.2 of the ticket): 2 MB per image, 20 MB per run, max 200 files
 * per run. Files beyond any limit are LINKED, never dropped — chamba never
 * silently discards evidence (§9 "Destructivo": nothing here deletes).
 */

export interface EvidenceFileInput {
  /** Vault-relative destination path (used only for the report, not validated here). */
  path: string;
  sizeBytes: number;
  kind: 'image' | 'text' | 'other';
}

export interface EvidenceBudgetLimits {
  maxImageBytes: number;
  maxRunBytes: number;
  maxFiles: number;
}

export const DEFAULT_EVIDENCE_BUDGET: EvidenceBudgetLimits = {
  maxImageBytes: 2 * 1024 * 1024,
  maxRunBytes: 20 * 1024 * 1024,
  maxFiles: 200,
};

export interface EvidenceLinkOnlyEntry extends EvidenceFileInput {
  reason: string;
}

export interface EvidenceBudgetPlan {
  copy: EvidenceFileInput[];
  linkOnly: EvidenceLinkOnlyEntry[];
}

/**
 * Walks `files` in order and decides copy vs. link-only. Order matters: once
 * the file count or the cumulative run size is exhausted, every remaining
 * file is linked — this is a budget, not a priority queue.
 */
export function planEvidenceCopy(
  files: EvidenceFileInput[],
  limits: EvidenceBudgetLimits = DEFAULT_EVIDENCE_BUDGET,
): EvidenceBudgetPlan {
  const copy: EvidenceFileInput[] = [];
  const linkOnly: EvidenceLinkOnlyEntry[] = [];
  let runBytes = 0;

  for (const file of files) {
    if (copy.length >= limits.maxFiles) {
      linkOnly.push({
        ...file,
        reason: `límite de ${limits.maxFiles} archivos por run alcanzado`,
      });
      continue;
    }
    if (file.kind === 'image' && file.sizeBytes > limits.maxImageBytes) {
      linkOnly.push({
        ...file,
        reason: `imagen de ${file.sizeBytes} bytes supera el límite de ${limits.maxImageBytes} bytes por imagen`,
      });
      continue;
    }
    if (runBytes + file.sizeBytes > limits.maxRunBytes) {
      linkOnly.push({
        ...file,
        reason: `copiarlo superaría el límite de ${limits.maxRunBytes} bytes por run`,
      });
      continue;
    }
    copy.push(file);
    runBytes += file.sizeBytes;
  }

  return { copy, linkOnly };
}
