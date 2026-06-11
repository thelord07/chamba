import type { Workspace } from '../workspace/workspace.js';

export type IssueSeverity = 'error' | 'warning';

export interface Issue {
  code: string;
  severity: IssueSeverity;
  message: string;
}

export interface ValidatePlanInput {
  plan: string;
  task: string;
  context?: string;
  workspace?: Workspace;
}

export interface ValidationResult {
  issues: Issue[];
  suggestions: string[];
  riskFlags: string[];
}

const SENSITIVE_RE =
  /\b(auth|authentication|authorization|payments?|billing|migrations?|secrets?|credentials?|passwords?)\b/i;
const SENSITIVE_PATH_RE = /(^|\/)(auth|payments|billing|migrations|secrets?|credentials)(\/|$)/i;
const WORKER_RE = /\b(implementer|tester|reviewer|worker)\b/i;
const TESTS_RE = /\b(tests?|vitest|jest|spec|unit test|integration test)\b/i;
const PLACEHOLDER_RE = /\b(todo|tbd|fixme|placeholder)\b/i;
// Intent to remove code (English + Spanish). Used to require a referential-closure check.
const DELETION_RE =
  /\b(delete[ds]?|deleting|remove[ds]?|removing|removal|drop(?:ping|s|ped)?|eliminat\w*|deprecat\w*|elimina\w*|borra\w*|quita\w*)\b/i;
// Mentions of verifying that a removal left nothing dangling/orphaned.
const ORPHAN_CHECK_RE =
  /\b(orphan\w*|dead[-\s]?code|unused\s+(?:export|import|symbol|function|code|reference)|referential|callers?|knip|ts-prune|depcheck|type-?check|typecheck|tsc|build\s+(?:passes|green|clean))\b/i;

const DEFAULT_MODULES = new Set([
  'packages',
  'examples',
  'src',
  'test',
  'tests',
  'scripts',
  'docs',
  'app',
  '.chamba',
  '.github',
]);

/**
 * Validate a plan with programmatic heuristics — NO LLM. The editor's model
 * already reasons; chamba only checks the plan's structure for known anti-patterns.
 */
export function validatePlan(input: ValidatePlanInput): ValidationResult {
  const plan = input.plan;
  const lower = plan.toLowerCase();
  const sec = sections(plan);
  const issues: Issue[] = [];
  const suggestions: string[] = [];
  const riskFlags: string[] = [];

  // 1. Acceptance criteria present and concrete.
  const acItems = listItems(getSection(sec, 'acceptance criteria')).filter(isConcrete);
  if (!lower.includes('acceptance criteria') || acItems.length === 0) {
    issues.push({
      code: 'no-acceptance-criteria',
      severity: 'error',
      message: 'No explicit acceptance criteria with at least one concrete, checkable item.',
    });
    suggestions.push('Add an "## Acceptance criteria" section with checkable bullets.');
  }

  // 2. Tests mentioned (and not explicitly negated, e.g. "sin tests"/"no tests").
  const negatedTests = /\b(no|sin|without)\s+(unit\s+|integration\s+)?tests?\b/i.test(lower);
  if (!TESTS_RE.test(lower) || negatedTests) {
    issues.push({
      code: 'no-tests',
      severity: 'error',
      message: 'No tests mentioned. State how the change will be verified.',
    });
    suggestions.push('Add a tester subtask or a test-related acceptance criterion.');
  }

  // 3 & 4. Subtasks: present, with workers, concrete.
  const subtaskItems = listItems(getSection(sec, 'subtasks'));
  if (subtaskItems.length === 0) {
    issues.push({
      code: 'no-subtasks',
      severity: 'error',
      message: 'No subtasks listed. Break the work into concrete steps.',
    });
  } else {
    if (!subtaskItems.some((it) => WORKER_RE.test(it))) {
      issues.push({
        code: 'subtask-without-worker',
        severity: 'error',
        message: 'Subtasks have no worker assigned (implementer / tester / reviewer).',
      });
      suggestions.push('Prefix each subtask with the responsible worker.');
    }
    const vague = subtaskItems.filter((it) => !isConcrete(it)).length;
    if (vague > 0) {
      issues.push({
        code: 'vague-subtask',
        severity: 'warning',
        message: `${vague} subtask(s) lack a concrete description (placeholder or too short).`,
      });
    }
  }

  // 5. Files outside the known workspace modules.
  const files = extractPaths(plan);
  if (input.workspace && files.length > 0) {
    const known = knownModules(input.workspace);
    const outside = [...new Set(files.filter((f) => !known.has(topSegment(f))))];
    if (outside.length > 0) {
      riskFlags.push(`Touches files outside known modules: ${outside.join(', ')}`);
      suggestions.push('Confirm these paths are intended; they are not in the workspace map.');
    }
  }

  // 6. Sensitive areas without a risk assessment.
  const sensitive = SENSITIVE_RE.test(plan) || files.some((f) => SENSITIVE_PATH_RE.test(f));
  const hasRisk = listItems(getSection(sec, 'risk')).filter(isConcrete).length > 0;
  if (sensitive) {
    riskFlags.push('References a sensitive area (auth / payments / migrations / secrets).');
    if (!hasRisk) {
      issues.push({
        code: 'missing-risk-assessment',
        severity: 'error',
        message: 'Touches a sensitive area but has no risk assessment in the Risks section.',
      });
      suggestions.push('Add a concrete entry under "## Risks" describing the risk and mitigation.');
    }
  }

  // 7. Deletions without a referential-closure check (the backward-orphan gap).
  if (DELETION_RE.test(plan) && !ORPHAN_CHECK_RE.test(plan)) {
    issues.push({
      code: 'deletion-without-orphan-check',
      severity: 'warning',
      message:
        'The plan removes code but never mentions verifying referential closure: ' +
        'orphaned callers or now-unused exports left behind. Token grep alone misses these.',
    });
    suggestions.push(
      'After removing code, verify nothing was orphaned: run the build/typecheck and a ' +
        'dead-code check (e.g. knip / ts-prune), not just a grep.',
    );
  }

  return { issues, suggestions, riskFlags };
}

// --- markdown helpers ---------------------------------------------------------

function sections(plan: string): Map<string, string[]> {
  const map = new Map<string, string[]>([['', []]]);
  let current = '';
  for (const line of plan.split('\n')) {
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      current = (heading[1] ?? '').trim().toLowerCase();
      if (!map.has(current)) map.set(current, []);
    } else {
      map.get(current)?.push(line);
    }
  }
  return map;
}

/** Lines under the first heading whose text includes `name`. */
function getSection(map: Map<string, string[]>, name: string): string[] {
  for (const [heading, lines] of map) {
    if (heading.includes(name)) return lines;
  }
  return [];
}

function listItems(lines: string[]): string[] {
  const items: string[] = [];
  for (const line of lines) {
    const m = line.match(/^\s*(?:\d+\.|[-*])\s+(.*)$/);
    if (m) items.push((m[1] ?? '').trim());
  }
  return items;
}

function isConcrete(item: string): boolean {
  const stripped = item
    .replace(/<!--.*?-->/g, '')
    .replace(/\[[ xX]?\]/g, '')
    .replace(/\*\*/g, '')
    .trim();
  if (stripped.length < 6) return false;
  if (/^\.+$/.test(stripped)) return false;
  if (PLACEHOLDER_RE.test(stripped)) return false;
  return true;
}

function extractPaths(plan: string): string[] {
  const matches = plan.match(/[\w.@-]+(?:\/[\w.@-]+)+/g) ?? [];
  return matches.filter((p) => !p.startsWith('http') && !p.includes('://'));
}

function topSegment(path: string): string {
  const clean = path.replace(/^\.\//, '').replace(/^\//, '');
  return clean.split('/')[0] ?? clean;
}

function knownModules(ws: Workspace): Set<string> {
  const known = new Set<string>(DEFAULT_MODULES);
  for (const dir of ws.folderMap) known.add(dir);
  for (const p of ws.projects) {
    if (p.path !== '.') known.add(topSegment(p.path));
  }
  return known;
}
