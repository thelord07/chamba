// @chamba/core — pure harness logic. No Node-specific APIs (principle 6).

export type { ClockPort } from './ports/clock.js';
// Ports
export type { DirEntry, FilesystemPort } from './ports/filesystem.js';
export type { ProcessExecOptions, ProcessPort, ProcessResult } from './ports/process.js';

// Testing utilities
export { MemoryFilesystem } from './testing/memory-filesystem.js';

// Path helpers
export { basename, dirname, extname, joinPath } from './util/path.js';
export { diffLines, textsEqual } from './workspace/diff.js';
export { WorkspaceScanner } from './workspace/scanner.js';
export type { ProjectRef, Workspace } from './workspace/workspace.js';
// Workspace
export {
  renderWorkspaceMarkdown,
  WORKSPACE_DIR,
  WORKSPACE_FILE,
  WORKSPACE_RELATIVE_PATH,
} from './workspace/workspace.js';
