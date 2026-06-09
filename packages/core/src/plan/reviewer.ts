import type { Workspace } from '../workspace/workspace.js';
import type { Issue } from './validator.js';
import { validatePlan } from './validator.js';

export interface PlanReview {
  approved: boolean;
  issues: Issue[];
  suggestions: string[];
  riskFlags: string[];
}

export interface ReviewInput {
  plan: string;
  task: string;
  context?: string;
  workspace?: Workspace;
}

/**
 * Heuristic plan reviewer. Runs `validatePlan` and approves only when there are
 * no error-severity issues. Warnings and risk flags are surfaced but don't block.
 * NO LLM — the editor's model decides what to do with the review.
 */
export class Reviewer {
  review(input: ReviewInput): PlanReview {
    const { issues, suggestions, riskFlags } = validatePlan(input);
    const approved = !issues.some((i) => i.severity === 'error');
    return { approved, issues, suggestions, riskFlags };
  }
}
