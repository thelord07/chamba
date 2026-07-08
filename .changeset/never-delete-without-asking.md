---
"@chamba/claude-extras": patch
---

fix(safety): no chamba agent deletes data without explicit confirmation

Hardens the guardrail after a QA run could wipe a local DB:

- **All five agents** (planner, implementer, reviewer, tester, qa) now carry a
  hard rule: never drop/reset/truncate a database, delete files/data, force-push,
  delete branches, or remove container/cloud resources without the human's explicit
  confirmation — STOP and ask first. The planner must gate destructive steps; the
  reviewer flags any ungated destructive op as blocking.
- The **qa** agent's seed must be additive and non-destructive — never reset/drop/
  recreate the DB to seed it.
- The **PreToolUse destructive-command hook** now also ASKs on database wipes
  (`prisma migrate reset`, `db push --force-reset`/`--accept-data-loss`,
  `DROP`/`TRUNCATE`, `dropdb`, `db:reset`/`db:drop`/`schema:drop`) plus more
  filesystem/git/container deletions (`rm -r`/`-f`, `git clean`, `git branch -d`,
  `docker … down -v`, `docker volume rm`, `docker system prune`). It asks, never
  hard-blocks — a human yes/no.
