---
description: Map the workspace architecture (cross-repo wiring) into living vault notes
argument-hint: "[en|es] [repo ...]"
---

You are mapping the architecture of this workspace into the Obsidian vault: **$ARGUMENTS**

This is an opt-in command for small or new projects — bootstrap the cross-repo
context the `/ticket` flow relies on. Stay grounded in the real code: cite the
files you read, never invent a connection, and mark anything you can't confirm as
unknown rather than guessing.

Parse the arguments: a leading `en` or `es` sets the notes' language; any other
tokens are repos to scope the map to (default: every repo in the workspace).

**Orchestration capability.** Use the richest orchestration your editor supports, and
degrade cleanly: with **parallel subagents**, fan out the per-repo reconnaissance and
reconcile it; with **one subagent at a time**, do the repos sequentially; with **no
subagents**, do the work inline yourself. Never assume a specific editor primitive —
adapt to what you have.

1. Resolve the vault with `chamba_vault_status`. If no vault is found, tell me to
   run `/workspace init` first (it bootstraps one) and stop here.
2. **Language.** If I didn't pass `en`/`es`, ask me whether to write the notes in
   English or Spanish, and wait for my answer. Write ALL notes in that language.
3. Call `chamba_load_context` with "map the workspace architecture" to pull the
   repo map, coding rules, and any notes already in the vault.
4. Do cross-repo reconnaissance, grounded in real code (read the relevant files):
   - **REST/HTTP** — clients, base URLs, route handlers → who calls whom.
   - **Async** — pub/sub topics, queues, events, webhooks → producers and consumers.
   - **Shared data** — databases, schemas, entities crossing repos.
   - **Build/deploy** — workspace dependencies, shared packages.
5. Write **stable, named notes** into the vault root (use your file tools to write
   directly under the resolved vault path). Each note gets YAML frontmatter with
   `tags: [chamba, architecture]`, `source: chamba`, and the date:
   - `Topology.md` — the service graph: which repos talk over REST and which events
     connect them. A diagram (Mermaid) plus prose.
   - `Data flows.md` — the key end-to-end flows across repos.
   - `Domain entities.md` — the shared entities / domain model.
   - `repos/<repo>.md` — one overview per repo: purpose, stack, entry points, and
     what it talks to (in and out).
6. **Never clobber my edits.** Before writing a note that already exists, read it:
   if it does NOT carry `source: chamba` in its frontmatter, I edited it by hand —
   leave it untouched, report it as skipped, and move on. If it does, regenerate it
   in place. The `source: chamba` marker is how you know which notes are yours.
7. Report what you wrote, updated and skipped, with the vault paths. Do NOT commit,
   merge or push — these are notes, I'll review them.
