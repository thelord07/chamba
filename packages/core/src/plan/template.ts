import type { Workspace } from '../workspace/workspace.js';

export type WorkerKind = 'implementer' | 'tester' | 'reviewer';

export interface SubtaskSpec {
  title: string;
  worker: WorkerKind;
  description: string;
  filesLikelyTouched: string[];
}

export interface GeneratePlanInput {
  task: string;
  context?: string;
  workspace?: Workspace;
}

/** Default subtask scaffold every plan starts from. The model refines these. */
export function suggestSubtasks(): SubtaskSpec[] {
  return [
    {
      title: 'Implement the change',
      worker: 'implementer',
      description: '<!-- what to build; keep it concrete -->',
      filesLikelyTouched: [],
    },
    {
      title: 'Write or extend tests',
      worker: 'tester',
      description: '<!-- which behaviours to cover with tests -->',
      filesLikelyTouched: [],
    },
  ];
}

/** Seed "files likely touched" from the workspace map (top-level dirs/projects). */
export function suggestFilesLikelyTouched(workspace?: Workspace): string[] {
  if (!workspace) return [];
  const fromProjects = workspace.projects.filter((p) => p.path !== '.').map((p) => p.path);
  return fromProjects.length > 0 ? fromProjects : workspace.folderMap.map((d) => `${d}/`);
}

/**
 * Produce a structured plan *template* (not a finished plan). The editor's model
 * fills the placeholders. chamba never writes the actual plan — it only provides
 * the skeleton and, later, reviews it. No LLM involved.
 */
export function generatePlanTemplate(input: GeneratePlanInput): string {
  const files = suggestFilesLikelyTouched(input.workspace);
  const subtasks = suggestSubtasks();
  const lines: string[] = [];

  lines.push(`# Plan: ${input.task}`);
  lines.push('');
  if (input.context && input.context.trim().length > 0) {
    lines.push('## Context');
    lines.push('');
    lines.push('<!-- Loaded context (from chamba_load_context). Use it; do not delete. -->');
    lines.push(input.context.trim());
    lines.push('');
  }

  lines.push('## Goal');
  lines.push('');
  lines.push('<!-- One sentence: what does "done" look like? -->');
  lines.push('');

  lines.push('## Acceptance criteria');
  lines.push('');
  lines.push('- [ ] <!-- a concrete, checkable criterion -->');
  lines.push('- [ ] Tests cover the new behaviour');
  lines.push('');

  lines.push('## Subtasks');
  lines.push('');
  subtasks.forEach((s, i) => {
    lines.push(`${i + 1}. **${s.worker}** — ${s.title}`);
    lines.push(`   - ${s.description}`);
    lines.push('   - files likely touched: <!-- list paths -->');
  });
  lines.push('');

  lines.push('## Risks');
  lines.push('');
  lines.push('<!-- Flag anything touching auth, payments, or database migrations. -->');
  lines.push('- <!-- risk or "none identified" -->');
  lines.push('');

  lines.push('## Files likely touched');
  lines.push('');
  if (files.length > 0) {
    for (const f of files) lines.push(`- \`${f}\``);
  } else {
    lines.push('- <!-- list the files/modules this will change -->');
  }
  lines.push('');

  return lines.join('\n');
}
