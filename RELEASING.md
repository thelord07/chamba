# Releasing chamba

chamba ships four packages in **lockstep** — a changeset on any one bumps all four to the
same version (`.changeset/config.json` → `fixed: [["@chamba/*"]]`). There are two paths:
the **automated** one (CI) and the **manual** one (what to do when you publish by hand).

## Prerequisites

- **Node 22 LTS** (`node -v` → v22.x). If your shell resolves an older Node, prefix commands
  with the right PATH (e.g. `export PATH="$HOME/.nvm/versions/node/v22.x/bin:$PATH"`).
- **npm auth** with publish rights to the `@chamba` scope (`npm whoami`), or `NPM_TOKEN` in CI.
- **GitHub auth** that can push to `thelord07/chamba` (`gh auth status` → an account with the
  `repo` scope). The tags + Release go here.

## Automated path (CI)

`.github/workflows/release.yml` runs the changesets action on every push to `main`:

1. Merge a PR that includes a `.changeset/*.md` file.
2. The action opens/updates a **"Version Packages"** PR (runs `changeset version`).
3. Merge that PR → the action runs `pnpm release` (`pnpm -r build && changeset publish`) and
   publishes to npm.

CI (`ci.yml`) gates every PR: **biome → tsc → build → test → doctor**. The `doctor` step runs
the built MCP binary (`node packages/mcp/dist/main.js doctor`) and fails the job if any health
check fails (warnings are allowed).

## Manual path (checklist)

1. **Add a changeset** describing the change and the bump level:
   ```bash
   pnpm changeset          # or write .changeset/<slug>.md by hand
   ```
2. **Version**: `pnpm changeset version` — bumps all four packages + writes CHANGELOGs.
3. **Track**: flip the phase/plan status in `plans/` and `plans/BACKLOG.md` to done, and bump
   the landing (`docs/index.html`: `const VERSION` + the "Now/Ahora" timeline entry) and the
   README roadmap list.
4. **Green before commit**:
   ```bash
   pnpm -r build && pnpm -r test && pnpm biome check .
   node packages/mcp/dist/main.js doctor          # the release gate
   ```
5. **Commit** with the release message:
   ```bash
   git commit -am "chore(release): x.y.z — <summary>"
   ```
6. **Push `main`.** If your SSH key has a passphrase and you're non-interactive, push over
   HTTPS with `gh` as the credential helper. Reset the helper list first (leading empty
   `credential.helper=`) so a stale keychain credential doesn't shadow the gh token:
   ```bash
   git -c credential.helper= -c credential.helper='!gh auth git-credential' \
     push https://github.com/thelord07/chamba.git HEAD:main
   ```
   **If the commit touches `.github/workflows/`**, an OAuth token (what `gh` uses over HTTPS)
   needs the **`workflow`** scope, or the push is rejected. Either push over **SSH** (exempt
   from this restriction) or run `gh auth refresh -h github.com -s workflow` once, then retry.
7. **Publish**: `pnpm changeset publish` — publishes to npm and creates the local git tags.
8. **Push the tags** (same HTTPS trick if needed):
   ```bash
   git -c credential.helper='!gh auth git-credential' \
     push https://github.com/thelord07/chamba.git '@chamba/core@x.y.z' '@chamba/mcp@x.y.z' \
     '@chamba/adapters@x.y.z' '@chamba/claude-extras@x.y.z'
   ```
   **Verify the tag is on `main`**, not orphaned (a `git pull --rebase` can rewrite the release
   commit's hash and leave tags pointing at the old one):
   ```bash
   git merge-base --is-ancestor '@chamba/mcp@x.y.z^{commit}' origin/main && echo clean
   ```
   If it's orphaned, move the tag to the commit that's on `main` (`gh api -X PATCH
   repos/thelord07/chamba/git/refs/tags/<tag> -f sha=<commit> -F force=true`) and re-verify.
9. **GitHub Release**:
   ```bash
   gh release create '@chamba/mcp@x.y.z' --repo thelord07/chamba \
     --title '@chamba/mcp@x.y.z — <headline>' --notes '<what changed>'
   ```
10. **Verify**: `npm view @chamba/mcp version`, the landing VERSION, and the README all read
    the new version.

## Gotchas

- **Lockstep.** Any package bump bumps all four. Don't hand-edit one `package.json` version.
- **VS Code MCP config uses `"servers"`, not `"mcpServers"`.** Keep every editor guide correct.
- **Never `console.log` in `@chamba/mcp`.** stdout is the MCP channel; logs go to
  `~/.chamba/logs/mcp-<pid>.log` via pino. A stray write corrupts the protocol.
- **Landing is hand-maintained JS.** After editing `docs/index.html`, re-validate the inline
  script parses: `awk '/<script>/{f=1;next}/<\/script>/{f=0}f' docs/index.html | node --check -`.
