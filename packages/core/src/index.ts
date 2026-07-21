// @chamba/core — pure harness logic. No Node-specific APIs (principle 6).

// Config (per-agent model + effort)
export { DEFAULT_CONFIG } from './config/defaults.js';
export type {
  ConfigSource,
  ConfigSourceKind,
  LoadConfigOptions,
  LoadConfigResult,
} from './config/loader.js';
export { ConfigError, loadConfig } from './config/loader.js';
export type { PresetName } from './config/presets.js';
export {
  isPresetName,
  PRESET_DESCRIPTIONS,
  PRESET_NAMES,
  PRESETS,
  presetConfigFile,
} from './config/presets.js';
export { buildHint, resolveRole } from './config/resolve.js';
export type { AgentRole, Effort, ReasoningPriority } from './config/roles.js';
export {
  AGENT_ROLES,
  EFFORT_LEVELS,
  REASONING_PRIORITIES,
  ROLE_DESCRIPTIONS,
} from './config/roles.js';
export type { ConfigFile, ParseResult } from './config/schema.js';
export { configFileSchema, parseChambaConfig, worktreeConfigSchema } from './config/schema.js';
export type { AgentConfig, ChambaConfig, ResolvedConfig } from './config/types.js';
export type {
  PartialWorktreeConfig,
  WorktreeConfig,
  WorktreeLayout,
} from './config/worktrees.js';
export { DEFAULT_WORKTREE_CONFIG, resolveWorktreeConfig } from './config/worktrees.js';
// Design sources (linked mockups/Figma/prototype + UI-architecture prefs, no LLM)
export type {
  Design,
  DesignAsset,
  DesignAssetKind,
  DesignConventions,
  DesignRef,
} from './design/design.js';
export {
  CONVENTIONS_FILE,
  collectDesignRefs,
  DESIGN_DIR,
  KNOWN_ARCHITECTURES,
  loadDesignConventions,
  parseDesignFrontmatter,
  rankDesigns,
  readDesign,
  saveDesignConventions,
} from './design/design-registry.js';
// Doctor (environment health check)
export type { CheckStatus, DoctorCheck, DoctorInput, DoctorReport } from './doctor/doctor.js';
export { renderDoctorReport, runDoctor } from './doctor/doctor.js';
export { FilesystemMemoryStore, MEMORY_DIR } from './memory/filesystem-store.js';
// Memory
export type { Memory, MemoryStore, RememberInput } from './memory/store.js';
// Model catalog
export type { ModelInfo, ModelProvider } from './models/catalog.js';
export {
  getModel,
  MODEL_CATALOG,
  modelCaveat,
  modelsByProvider,
  resolveEffort,
} from './models/catalog.js';
export type { NoteFields } from './obsidian/note-template.js';
export { renderNote, slugify, slugifyGitRemote } from './obsidian/note-template.js';
export type { IndexEntry } from './obsidian/vault-index.js';
export {
  describeFromBody,
  INDEX_FILE,
  parseIndexNote,
  renderIndexNote,
  upsertIndexEntry,
} from './obsidian/vault-index.js';
export type { SeedVaultInput, SeedVaultResult } from './obsidian/vault-init.js';
export { VAULT_OVERVIEW_FILE, VaultInitializer } from './obsidian/vault-init.js';
export type { WriteNoteInput, WriteNoteResult } from './obsidian/vault-writer.js';
export { VAULT_NOTES_DIR, VAULT_PLANS_DIR, VaultWriter } from './obsidian/vault-writer.js';
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
export type { SystemPort, SystemResources } from './ports/system.js';
// QA capabilities (project + machine probe for acceptance QA, no LLM)
export type {
  AndroidDevices,
  IosDevices,
  ProjectKind,
  QaCapabilities,
  QaCapabilitiesInput,
} from './qa/capabilities.js';
export { detectQaCapabilities } from './qa/capabilities.js';
// Resource budget (safe parallelism, no LLM)
export type {
  BudgetLimit,
  ConcurrencyBudget,
  ConcurrencyBudgetInput,
} from './resources/budget.js';
export { computeConcurrencyBudget } from './resources/budget.js';
// Skills / playbooks registry (index-first, no LLM)
export type { Skill, SkillRef } from './skills/skill.js';
export {
  collectSkillRefs,
  parseSkillFrontmatter,
  rankSkills,
  readSkill,
  SKILLS_DIR,
} from './skills/skill-registry.js';
export type { ProcessHandler, RecordedCall } from './testing/fake-process.js';
export { FakeProcess } from './testing/fake-process.js';

// Testing utilities
export { MemoryFilesystem } from './testing/memory-filesystem.js';
// Path helpers
export { basename, dirname, extname, joinPath } from './util/path.js';
export type { BuiltContext, ContextBuildInput, RelevantNote } from './workspace/context-builder.js';
export { ContextBuilder, listVaultNotes } from './workspace/context-builder.js';
export { diffLines, textsEqual } from './workspace/diff.js';
export type { DetectOptions, VaultDetection } from './workspace/obsidian-detector.js';
// Obsidian
export { normalizeVaultPath, ObsidianDetector } from './workspace/obsidian-detector.js';
export type { RuleConvention, RuleExcerpt, RuleSource } from './workspace/rules.js';
// Coding rules (multi-editor)
export { detectRuleSources, RULE_SOURCES, readRuleExcerpts } from './workspace/rules.js';
export { WorkspaceScanner } from './workspace/scanner.js';
export type {
  AuthFinding,
  MobileFinding,
  MobilePlatform,
  MobileTarget,
  ProjectAuth,
  ProjectRef,
  Workspace,
} from './workspace/workspace.js';
// Workspace
export {
  renderWorkspaceMarkdown,
  WORKSPACE_DIR,
  WORKSPACE_FILE,
  WORKSPACE_RELATIVE_PATH,
} from './workspace/workspace.js';
export type { BranchNameInput } from './worktree/branch-naming.js';
export { buildBranchName, slugifyForGit, worktreeRelativePath } from './worktree/branch-naming.js';
export { writeEditorWorkspace } from './worktree/editor-workspace.js';
export { copyEnvFiles } from './worktree/env-copy.js';
// Worktree
export { GitDetector } from './worktree/git-detector.js';
export { detectGitRepos } from './worktree/git-repo-detector.js';
export type {
  CleanupResult,
  CreateWorktreeInput,
  ListedWorktree,
  WorktreeHandle,
} from './worktree/manager.js';
export { WorktreeError, WorktreeManager } from './worktree/manager.js';
export type {
  CleanupMultiResult,
  CreateMultiInput,
  MultiRepoWorktreeResult,
  WorktreeStatus,
} from './worktree/multi-repo-manager.js';
export { MultiRepoWorktreeManager } from './worktree/multi-repo-manager.js';
export type { PlanWorktreesInput, WorktreePlanItem } from './worktree/multi-repo-plan.js';
export {
  buildTicketBranch,
  editorWorkspaceContent,
  editorWorkspaceDir,
  planWorktrees,
  safeTicket,
  worktreePathFor,
} from './worktree/multi-repo-plan.js';
