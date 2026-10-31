# Example Skills

These are example skill/playbook files for use with [chamba](../../packages/mcp/README.md).
They are **not installed automatically** — copy the ones you want into your project or
global skills directory.

---

## How to install a skill

**Per-project** (shared with your team via the repo):
```
.chamba/skills/knex-postgres-performance.md
```

**Global** (your personal machine, all projects):
```
~/.chamba/skills/knex-postgres-performance.md
```

Copy any `.md` file from this directory to either location.
The `README.md` file is ignored by the skill scanner.

---

## How `chamba_load_skills` picks skills

`chamba_load_skills` takes a `task` string and scores every skill file by how many
keywords from the task appear in the skill's `name`, `description`, and `scope`
(substring match, no LLM). It returns the top-matching skills up to the configured
limit (default: 3).

Example: `chamba_load_skills({ task: "optimize knex query n+1" })` will rank
`knex-postgres-performance` first because its name and description contain "knex",
"query", and "optimize".

Skills with no matching keywords get a score of 0 and are not returned.

**The `README.md` in the skills directory is always ignored** — it is never treated
as a skill, regardless of its content.

---

## Skills in this directory

| File | Scope | When to use |
|------|-------|-------------|
| `knex-postgres-performance.md` | backend | Slow Knex queries, N+1, missing indexes, large-table migrations |
| `nestjs-concurrency.md` | backend | High-concurrency endpoints, background jobs, resource safety |
| `react-native-performance.md` | mobile | Janky scrolling, large lists, re-render issues, JS thread blocking |

---

## Frontmatter format

A skill file must start with a YAML frontmatter block:

```markdown
---
name: my-skill-name
description: One-line description with keywords that match the tasks you'll use it for.
scope: backend
---

# Skill body …
```

`name` is required. `description` and `scope` are optional but strongly recommended —
they are what `chamba_load_skills` searches. `scope` is free text (e.g. `backend`,
`mobile`, `frontend` or a repo name). Values are read as a single line — don't add
inline `# comments`, they would become part of the value.
