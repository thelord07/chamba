import type { FilesystemPort } from '../ports/filesystem.js';
import { joinPath } from '../util/path.js';
import { editorWorkspaceContent, safeTicket, type WorktreePlanItem } from './multi-repo-plan.js';

/**
 * Write a `<ticket>.code-workspace` into `dir` listing each repo's worktree as a
 * folder. Returns the file path. Editor-agnostic (Cursor/VS Code share the format).
 */
export async function writeEditorWorkspace(
  fs: FilesystemPort,
  dir: string,
  ticket: string,
  items: WorktreePlanItem[],
): Promise<string> {
  const path = joinPath(dir, `${safeTicket(ticket)}.code-workspace`);
  await fs.mkdir(dir);
  await fs.writeFile(path, editorWorkspaceContent(items, dir));
  return path;
}
