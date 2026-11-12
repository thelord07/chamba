export interface Memory {
  key: string;
  content: string;
  tags: string[];
  /** ISO timestamp of first write. */
  createdAt: string;
  /** ISO timestamp of last write (set when the memory is appended to). */
  updatedAt: string;
  /** Path to the markdown file on disk. */
  path: string;

  // ── CHAMBA-021 S11: provenance + estado (add-only on a human-authored file) ──
  author?: string;
  agent?: string;
  written_at?: string;
  estado?: 'propuesto' | 'canonico';
  flag?: string;
}

export interface RememberInput {
  key: string;
  content: string;
  tags?: string[];
  /** CHAMBA-021 S11: provenance for this write. Omit to keep legacy behavior. */
  provenance?: import('../obsidian/knowledge/provenance.js').Provenance;
  /** S5/S11: set `flag: 'revisar'` when `detectInstructionLike` found a match. */
  flagRevisar?: boolean;
}

/**
 * Persistent, human-editable memory across sessions. Implementations store one
 * markdown file per memory (never JSON or a DB), so the user can read and edit
 * them by hand.
 */
export interface MemoryStore {
  remember(input: RememberInput): Promise<Memory>;
  recall(query: string): Promise<Memory[]>;
}
