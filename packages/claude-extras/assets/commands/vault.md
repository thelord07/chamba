---
description: Show the connected Obsidian vault and the notes chamba can see; manage the knowledge network
argument-hint: "[status|init|classify|reindex] [args]"
---

Interpret `$ARGUMENTS` as the subcommand (default: `status`).

**Compatibility (deprecated):** `/vault iniciar` → `/vault init`, `/vault clasificar` → `/vault classify`. If the first word of `$ARGUMENTS` is `iniciar`, respond first with the exact line `Usa /vault init (iniciar está deprecado)` and then continue with the `/vault init` flow. If the first word is `clasificar`, respond first with `Usa /vault classify (clasificar está deprecado)` and then continue with the `/vault classify` flow. These aliases are removed in the next minor.

---

## `/vault` — default (status)

Call `chamba_vault_status` and show me the result clearly:

- The resolved vault path and whether it came from `CHAMBA_OBSIDIAN_VAULT_PATH`
  or autodetection.
- How many markdown notes chamba can see, and the list of note files.
- Any `INDEX.md` manuales omitted from reindex (`indicesManualesOmitidos`).
- Knowledge-network suggestions (topics ready to promote, nodes to split, possible merges).

If no vault is found, or the note count is 0, or the path ends in `.obsidian`,
tell me to set `CHAMBA_OBSIDIAN_VAULT_PATH` to the **vault root** (the folder that
*contains* `.obsidian`, not `.obsidian` itself) and restart the editor.

---

## `/vault init` — bootstrap the knowledge network (O1)

Use this to create or replace `temas/VOCABULARIO.md` for the first time.

1. Call `chamba_vault_topics action=bootstrap` to get deterministic vault statistics
   (folders with note counts, existing tags with frequency, frequent terms from
   titles/summaries/headings, detected work items).
2. Based on the statistics, **propose** a topic tree (≤ 30 nodes, ≤ 3 levels at
   start) and show it to the user.
3. Call `chamba_vault_topics action=apply dryRun:true` with the proposed nodes.
   The tool returns the **exact content** of `VOCABULARIO.md` that would be written.
   **Show that content to the user.**
4. **Wait for an explicit "yes" from the user in a separate turn.** Do NOT call
   `apply` with `dryRun:false` in the same turn as `bootstrap` or `apply dryRun:true`,
   and never chain them without the user's explicit approval.
5. Only after explicit approval: call `chamba_vault_topics action=apply dryRun:false`
   (add `replace:true` if `VOCABULARIO.md` already exists — confirm with the user
   first since this overwrites the current vocabulary).
6. After writing the vocabulary, offer the backfill: run `/vault classify` to
   classify existing unclassified notes against the new vocabulary.

---

## `/vault classify` — backfill unclassified notes

Use this to classify notes that have no `temas` yet, in batches of ≤ 50.

1. Call `chamba_vault_classify action=list` (with `page` as needed) to see unclassified
   notes (path, title, first paragraph ≤ 300 chars).
2. For each batch (≤ 50 entries), propose `temas`, `summary`, `keywords`, `type`,
   and `workItem` for each note. Use the vocabulary from `chamba_vault_topics
   action=list` and read the 5 closest nodes before proposing topics.
   - One note touches several topics → one note with several `temas`, never
     separate notes.
   - Unknown topics go as proposals (`temas_propuestos`), never invent vocabulary.
3. Call `chamba_vault_classify action=apply dryRun:true entries:[…]`.
   The tool returns a diff showing before/after frontmatter for each note.
   **Show the diff to the user.**
4. **Wait for explicit confirmation** before applying. Never call `apply` with
   `dryRun:false` without the user's explicit "yes" in a separate turn.
5. After confirmation: call `chamba_vault_classify action=apply dryRun:false entries:[…]`.
   chamba rewrites only the declared frontmatter keys; the body is unchanged byte by byte.
6. Repeat for the next page if there are more unclassified notes.

---

## Navigate before reading

When working with the vault (diagnosing, writing a plan, or saving a summary):

1. `chamba_load_context` returns the **Mapa del vault** — read the relevant topic nodes
   before opening any note.
2. Call `chamba_vault_navigate` with `tema` or `path` for each relevant node; descend
   to subtopics only when their description applies to the task.
3. Use `readBody:true` only on notes whose `summary`/`keywords` contain ≥ 2 task
   keywords — do not open notes that are off the path.
4. Record the navigation in a **Contexto consultado** section: paths you read + one
   line listing notes discarded by summary.

---

## Writing notes (daily flow)

When calling `chamba_summarize_to_vault` or `chamba_save_plan`:

- Before choosing `temas`, call `chamba_vault_topics action=list` and read the
  5 closest nodes from the tool response.
- A note that covers several topics → **one note with several `temas`** (1–5),
  never separate notes per topic.
- `summary`: one line saying what the note is about (not "session summary").
- `keywords`: endpoints, entity names, IDs — concrete terms to find the note.
- `workItem`: the ticket/HU id when the note belongs to one.
- Unknown topics go in `temas_propuestos` — **never invent or add topics to the
  vocabulary without the user asking for it**. What is unknown goes as a proposal.

---

## Evolving the vocabulary

- `chamba_vault_topics action=list` shows the compact topic tree, suggestions
  (proposals ready to promote, nodes to split, possible merges), and any `INDEX.md`
  manuales omitted from reindex.
- `chamba_vault_topics action=promote path=<topic> description=<desc>`: **always
  dryRun first** — the tool shows which notes will be updated. Call with `dryRun:false`
  only after the user's explicit approval (it's a bulk action).
- `chamba_vault_topics action=add` / `action=alias`: only call these when the user
  explicitly asks to add a topic or alias to the vocabulary.
- Proposals with ≥ `umbral_promover` notes appear as "listo para aprobar" in `list`
  and `vault status`.

---

## Reindex

- `chamba_vault_reindex` (or CLI `npx @chamba/mcp vault reindex`) rebuilds all
  derived files: root `INDEX.md`, topic hubs `temas/*.md`, `temas/sin-clasificar.md`,
  `temas/PROPUESTOS.md`, folder `INDEX.md`s, and `temas/*.base` files.
- It runs automatically after every write and after a parche pull that changed notes
  or derived files.
- **`adoptManual` (O2): never automatic.** To adopt a manually-written `INDEX.md`
  (one without `source: chamba`), call `chamba_vault_reindex adoptManual:["folder/"]`
  — with `dryRun:true` by default, which shows the adoption plan (which files will be
  renamed to `INDEX (manual).md` and replaced). Call with `dryRun:false` only after
  the user's explicit confirmation. If `INDEX (manual).md` already exists, the tool
  errors — it never overwrites.
- CLI: `npx @chamba/mcp vault reindex [--dry-run] [--adopt-manual <folder> …] [--yes]`
