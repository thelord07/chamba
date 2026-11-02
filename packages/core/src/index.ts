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
  WorktreeOverlapConfig,
  WorktreePortsConfig,
} from './config/worktrees.js';
export {
  baseBranchForRepo,
  DEFAULT_WORKTREE_CONFIG,
  DEFAULT_WORKTREE_OVERLAP,
  DEFAULT_WORKTREE_PORTS,
  mergeWorktreePartial,
  resolveWorktreeConfig,
} from './config/worktrees.js';
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
export type { DirEntry, FileStat, FilesystemPort, WriteBytesOptions } from './ports/filesystem.js';
export type { HashPort } from './ports/hash.js';
export type { HttpPort, HttpRequest, HttpResponse } from './ports/http.js';
export type { NetPort } from './ports/net.js';
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
export { applyOverlapCap, computeConcurrencyBudget } from './resources/budget.js';
// Skills / playbooks registry (index-first, no LLM)
export type { Skill, SkillRef } from './skills/skill.js';
export {
  collectSkillRefs,
  parseSkillFrontmatter,
  rankSkills,
  readSkill,
  SKILLS_DIR,
} from './skills/skill-registry.js';
export { FakeHash } from './testing/fake-hash.js';
export { FakeNet } from './testing/fake-net.js';
export { FakeParche } from './testing/fake-parche.js';
export type { ProcessHandler, RecordedCall } from './testing/fake-process.js';
export { FakeProcess } from './testing/fake-process.js';
// Testing utilities
export { MemoryFilesystem } from './testing/memory-filesystem.js';
// Triage (ticket-completeness heuristic for /triage, no LLM)
export type {
  CompletenessCheck,
  TicketCompleteness,
  TicketCompletenessInput,
  TicketSignal,
} from './triage/ticket-completeness.js';
export {
  checkTicketCompleteness,
  renderTicketCompleteness,
  TICKET_SIGNALS,
} from './triage/ticket-completeness.js';
// Path helpers
export { basename, dirname, extname, joinPath } from './util/path.js';
// Vault dir resolution and validation (PARCHE-009)
export type { AdoptionSummary } from './vault-sync/adoption.js';
export { buildAdoptionSummary } from './vault-sync/adoption.js';
export type { ConflictMeta } from './vault-sync/conflict.js';
export {
  addConflictFrontmatter,
  conflictCopyPath,
  readConflictMeta,
  sanitizeAuthor,
} from './vault-sync/conflict.js';
// Vault sync — client (PARCHE-004)
export type { CredentialEntry, CredentialsFile } from './vault-sync/credentials.js';
export { CredentialsStore, credentialsFileSchema } from './vault-sync/credentials.js';
// Vault-sync messages and helpers (PARCHE-011)
export {
  joinFirstHint,
  joinInRepoHint,
  linkDirPlaceholderHint,
  linkHint,
  syncManualHint,
  unlinkWorkspaceHint,
  VAULT_CLI,
} from './vault-sync/messages.js';
// Vault-sync parche binding (PARCHE-011)
export type {
  ParcheBinding,
  ParcheBindingFile,
  ParcheScope,
  ReadParcheBindingResult,
} from './vault-sync/parche-binding.js';
export {
  CHAMBA_DIR,
  findWorkspaceRoot,
  PARCHE_FILE,
  parcheBindingFileSchema,
  parcheFilePath,
  readParcheBinding,
  resolveParcheBinding,
  WORKSPACE_MARKER,
  writeParcheBinding,
} from './vault-sync/parche-binding.js';
export type { CheckInviteResult } from './vault-sync/parche-client.js';
export {
  ParcheAlreadyMemberError,
  ParcheCaseCollisionError,
  ParcheClient,
  ParcheHttpError,
  ParcheMissingBlobsError,
  ParcheNotFoundError,
  ParcheRateLimitedError,
} from './vault-sync/parche-client.js';
export { findCaseCollisions, pathKey } from './vault-sync/path-key.js';
export type {
  LocalSnapshot,
  PullAction,
  PullPlan,
  PushEntry,
  SyncState,
} from './vault-sync/plan.js';
export { applyPullPlan, applyPushResults, planPull, planPush } from './vault-sync/plan.js';
export type {
  ChangeEntry,
  ChangesResponse,
  Device,
  DeviceAuthPollResponse,
  DeviceAuthStartResponse,
  Group,
  Hash,
  JoinRequest,
  JoinResponse,
  PushChange,
  PushRequest,
  PushResponse,
  PushResult,
  Role,
  User,
  VaultPath,
} from './vault-sync/protocol.js';
// Vault sync (parche protocol v1 — pure, no Node APIs, no LLM)
export {
  changeEntrySchema,
  changesResponseSchema,
  deviceAuthPollResponseSchema,
  deviceAuthStartResponseSchema,
  deviceSchema,
  groupSchema,
  hashSchema,
  joinRequestSchema,
  joinResponseSchema,
  PROTOCOL_VERSION,
  pushChangeSchema,
  pushRequestSchema,
  pushResponseSchema,
  pushResultSchema,
  roleSchema,
  userSchema,
  vaultPathSchema,
} from './vault-sync/protocol.js';
export type { SyncAction } from './vault-sync/roles.js';
export { can, ROLE_PERMISSIONS } from './vault-sync/roles.js';
export type {
  JoinOnceOpts,
  JoinOnceResult,
  SyncDeps,
  SyncOpts,
  SyncSummary,
} from './vault-sync/runner.js';
export {
  AdoptionPendingError,
  BlobHashMismatchError,
  CaseCollisionError,
  joinOnce,
  scanLocal,
  syncOnce,
  VaultDirMissingError,
} from './vault-sync/runner.js';
export type { ParsedJoinInput, ResolveServerUrlOptions } from './vault-sync/server-url.js';
export {
  assertAllowedServerUrl,
  DEFAULT_PARCHE_URL,
  InvalidJoinInputError,
  parseJoinInput,
  resolveServerUrl,
  ServerUrlError,
} from './vault-sync/server-url.js';
export type { SyncStateFile } from './vault-sync/state-store.js';
export {
  clearPendingAdoption,
  mergeIntoStateFile,
  pendingJoinCodeHashOf,
  readState,
  resetVaultState,
  syncStateFileSchema,
  toSyncState,
  writeState,
} from './vault-sync/state-store.js';
export { isSyncable } from './vault-sync/sync-filter.js';
export type {
  PrepareVaultDirOpts,
  PrepareVaultDirResult,
  VaultDirValidationCode,
} from './vault-sync/vault-dir.js';
export {
  expandTilde,
  lexicalNormalize,
  prepareVaultDir,
  resolveVaultDir,
  SYSTEM_DIRS,
  VaultDirValidationError,
} from './vault-sync/vault-dir.js';
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
// Vault safety (keep the vault out of git repos)
export {
  ensureVaultGitignored,
  findGitRoot,
  VAULT_ARTIFACTS,
  vaultGitignoreMissing,
} from './workspace/vault-safety.js';
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
export type {
  ConflictPair,
  ConflictPreviewMode,
  ConflictPreviewReport,
} from './worktree/conflict-preview.js';
export { ConflictPreviewer } from './worktree/conflict-preview.js';
export { writeEditorWorkspace } from './worktree/editor-workspace.js';
export { copyEnvFiles } from './worktree/env-copy.js';
export { readEnvVar, upsertEnvVar } from './worktree/env-upsert.js';
// Worktree
export { GitDetector } from './worktree/git-detector.js';
export { detectGitRepos } from './worktree/git-repo-detector.js';
export type { WorktreeInspection, WorktreeSnapshot } from './worktree/inspector.js';
export {
  inspectRepos,
  isStale,
  WORKTREE_STALE_AFTER_MS,
  WorktreeInspector,
} from './worktree/inspector.js';
export type {
  CleanupResult,
  CreateWorktreeInput,
  WorktreeHandle,
} from './worktree/manager.js';
export { WorktreeError, WorktreeManager } from './worktree/manager.js';
export { parseMergeTreeOutput } from './worktree/merge-tree.js';
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
export type {
  FileOverlap,
  PartitionItem,
  PartitionResult,
  PartitionWave,
} from './worktree/overlap.js';
export { findOverlaps, partitionByOverlap } from './worktree/overlap.js';
export { extractSubtaskPaths } from './worktree/plan-paths.js';
export type { ListedWorktree } from './worktree/porcelain.js';
export { parseWorktreePorcelain } from './worktree/porcelain.js';
export type { AllocatedPort, AssignPortsInput } from './worktree/port-assign.js';
export { allocatePort, assignWorktreePorts } from './worktree/port-assign.js';
