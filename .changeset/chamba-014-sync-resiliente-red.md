---
"@chamba/core": minor
"@chamba/adapters": minor
"@chamba/mcp": minor
---

CHAMBA-014: the parche sync survives normal networks. No more `HEAD` per blob: `vault sync` pushes first and uploads only the blobs the server reports missing (422), up to 3 rounds per batch, so 86 new files are 1 push + 86 PUT + 1 push over one reused connection (measured: 100 new files went from 102 TCP connections to 1). `NodeHttp` now runs on `node:http`/`node:https` with keep-alive agents and a 5 s connect timeout (30 s total), and the new `RetryingHttp` retries transient errors (connect timeouts, resets, DNS, 502/503/504, 429 with `Retry-After` capped at 10 s) with full-jitter backoff, 4 attempts; `join` is only retried when the request never left. The caller's abort signal cuts retries at once. Errors now say what happened — `parche: no se pudo conectar a <host> tras <n> intentos (<code>: …)` with the command to re-run — instead of a bare `fetch failed`, in the CLI, the MCP tools, auto-sync and the fatal handler, never including tokens or headers.
