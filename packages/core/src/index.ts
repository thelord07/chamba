// @chamba/core — pure harness logic. No Node-specific APIs (principle 6).

export { FilesystemMemoryStore, MEMORY_DIR } from './memory/filesystem-store.js';
// Memory
export type { Memory, MemoryStore, RememberInput } from './memory/store.js';
export type { NoteFields } from './obsidian/note-template.js';
export { renderNote, slugify } from './obsidian/note-template.js';
export type { WriteNoteInput, WriteNoteResult } from './obsidian/vault-writer.js';
export { VAULT_NOTES_DIR, VaultWriter } from './obsidian/vault-writer.js';
export type { PlanReview, ReviewInput } from './plan/reviewer.js';
export { Reviewer } from './plan/reviewer.js';
export type { GeneratePlanInput, SubtaskSpec, WorkerKind } from './plan/template.js';
// Plan
export {
  generatePlanTemplate,
  suggestFilesLikelyTouched,
  suggestSubtasks,
} from './plan/template.js';
export type {
  Issue,
  IssueSeverity,
  ValidatePlanInput,
  ValidationResult,
} from './plan/validator.js';
export { validatePlan } from './plan/validator.js';
export type { ClockPort } from './ports/clock.js';
// Ports
export type { DirEntry, FilesystemPort } from './ports/filesystem.js';
export type { ProcessExecOptions, ProcessPort, ProcessResult } from './ports/process.js';
export type { ProcessHandler, RecordedCall } from './testing/fake-process.js';
export { FakeProcess } from './testing/fake-process.js';

// Testing utilities
export { MemoryFilesystem } from './testing/memory-filesystem.js';
// Path helpers
export { basename, dirname, extname, joinPath } from './util/path.js';
export type { BuiltContext, ContextBuildInput, RelevantNote } from './workspace/context-builder.js';
export { ContextBuilder } from './workspace/context-builder.js';
export { diffLines, textsEqual } from './workspace/diff.js';
export type { DetectOptions, VaultDetection } from './workspace/obsidian-detector.js';
// Obsidian
export { ObsidianDetector } from './workspace/obsidian-detector.js';
export { WorkspaceScanner } from './workspace/scanner.js';
export type { ProjectRef, Workspace } from './workspace/workspace.js';
// Workspace
export {
  renderWorkspaceMarkdown,
  WORKSPACE_DIR,
  WORKSPACE_FILE,
  WORKSPACE_RELATIVE_PATH,
} from './workspace/workspace.js';
export type { BranchNameInput } from './worktree/branch-naming.js';
export { buildBranchName, slugifyForGit, worktreeRelativePath } from './worktree/branch-naming.js';
// Worktree
export { GitDetector } from './worktree/git-detector.js';
export type {
  CleanupResult,
  CreateWorktreeInput,
  ListedWorktree,
  WorktreeHandle,
} from './worktree/manager.js';
export { WorktreeError, WorktreeManager } from './worktree/manager.js';
