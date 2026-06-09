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
}

export interface RememberInput {
  key: string;
  content: string;
  tags?: string[];
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
