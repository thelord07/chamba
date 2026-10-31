---
"@chamba/claude-extras": minor
"@chamba/cursor-extras": minor
"@chamba/opencode-extras": minor
---

CHAMBA-012: performance and concurrency awareness in all four core agents (planner, implementer, reviewer, tester). Agents now consider N+1 data access, unbounded memory/concurrency, timeouts, idempotency, and hot paths by default, without optimizing prematurely. Adds example skills for Knex+PostgreSQL, NestJS concurrency, and React Native performance in `examples/skills/`.
