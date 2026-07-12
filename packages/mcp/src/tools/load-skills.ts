import {
  collectSkillRefs,
  joinPath,
  rankSkills,
  readSkill,
  SKILLS_DIR,
  type Skill,
  type SkillRef,
  WORKSPACE_DIR,
} from '@chamba/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { Services } from '../services.js';

const TOOL_NAME = 'chamba_load_skills';

const DESCRIPTION =
  'Find reusable skills/playbooks relevant to a task (NO LLM). Scans `.chamba/skills/*.md` ' +
  "(project, then ~/.chamba/skills), matches the task against each skill's description, and " +
  'returns the best matches WITH their full body, plus the list of all available skills. ' +
  'Call it at the start of a task to reuse team conventions/playbooks. Ships empty — create ' +
  '`.chamba/skills/<name>.md` with frontmatter { name, description, scope? } to fill it.';

export function registerLoadSkills(server: McpServer, logger: Logger, services: Services): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Load skills',
      description: DESCRIPTION,
      inputSchema: {
        task: z.string().describe('The task/ticket to find relevant skills for.'),
        max: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Max skills to return with full body (default 3).'),
      },
    },
    async ({ task, max }) => {
      const dirs = [
        joinPath(services.cwd, WORKSPACE_DIR, SKILLS_DIR),
        joinPath(services.homedir, WORKSPACE_DIR, SKILLS_DIR),
      ];
      const refs = await collectSkillRefs(services.fs, dirs);

      if (refs.length === 0) {
        const text =
          'No skills found. Create playbooks in `.chamba/skills/<name>.md` with frontmatter ' +
          '`{ name, description, scope? }` — the team fills this over time and chamba surfaces ' +
          'the relevant ones per task.';
        return {
          content: [{ type: 'text', text }],
          structuredContent: { skills: [], available: [] } as Record<string, unknown>,
        };
      }

      const matched: Skill[] = [];
      for (const ref of rankSkills(task, refs, max ?? 3)) {
        const skill = await readSkill(services.fs, ref.path);
        if (skill) matched.push(skill);
      }

      logger.info(
        { tool: TOOL_NAME, available: refs.length, matched: matched.length },
        'load-skills',
      );

      return {
        content: [{ type: 'text', text: renderSkills(matched, refs) }],
        structuredContent: {
          skills: matched.map((s) => ({
            name: s.name,
            description: s.description,
            scope: s.scope,
            path: s.path,
            body: s.body,
          })),
          available: refs.map(refSummary),
        } as Record<string, unknown>,
      };
    },
  );
}

function refSummary(ref: SkillRef): Record<string, unknown> {
  return { name: ref.name, description: ref.description, scope: ref.scope };
}

function renderSkills(matched: Skill[], all: SkillRef[]): string {
  const lines: string[] = [];
  if (matched.length > 0) {
    lines.push(`## Relevant skills (${matched.length})`, '');
    for (const s of matched) {
      lines.push(`### ${s.name}${s.scope ? ` (${s.scope})` : ''}`);
      if (s.description) lines.push(`_${s.description}_`);
      lines.push('', s.body, '');
    }
  } else {
    lines.push('No skill matched this task directly. Available skills:', '');
  }
  const others = matched.length > 0 ? '\n## All available skills' : '';
  if (others) lines.push(others);
  for (const ref of all) {
    lines.push(`- **${ref.name}**${ref.scope ? ` (${ref.scope})` : ''} — ${ref.description}`);
  }
  return lines.join('\n');
}
