#!/usr/bin/env bash
# chamba PreToolUse hook: ASK before destructive shell commands.
#
# Claude Code passes the tool call as JSON on stdin. This hook scans Bash commands
# for destructive patterns — file/dir deletion, git history rewrites, and (most
# importantly) DATABASE wipes — and returns a permissionDecision of "ask" so the
# human confirms before it runs. Everything else passes through untouched. It never
# hard-blocks; it forces a human yes/no. No chamba agent deletes data on its own.
#
# Register in ~/.claude/settings.json under hooks.PreToolUse (matcher: "Bash").

set -euo pipefail
input="$(cat)"

# Pull the command out of the JSON without requiring jq.
command="$(printf '%s' "$input" | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\(.*\)".*/\1/p')"
lc="$(printf '%s' "$command" | tr '[:upper:]' '[:lower:]')"

ask() {
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"chamba: %s Confirm before running — no agent deletes data on its own."}}\n' "$1"
  exit 0
}

# Fork bomb (symbol-based — check the raw command).
case "$command" in
  *":(){:|:&};:"*) ask "this looks like a fork bomb." ;;
esac

# Database wipes — the failure mode that must never happen silently.
case "$lc" in
  *"migrate reset"*|*"--force-reset"*|*"--accept-data-loss"*|*"drop database"*|*"drop table"*|*"drop schema"*|*"truncate table"*|*"dropdb"*|*"db:drop"*|*"db:reset"*|*"schema:drop"*|*"prisma db push"*)
    ask "this wipes, drops or resets a database." ;;
esac

# Filesystem, git history, and container/volume deletion.
case "$lc" in
  *"rm -rf"*|*"rm -fr"*|*"rm -r "*|*"rm -f "*|*"git push --force"*|*"git push -f"*|*"git reset --hard"*|*"git clean -"*|*"git branch -d"*|*"down -v"*|*"docker volume rm"*|*"docker system prune"*)
    ask "this deletes files, rewrites history, or removes volumes." ;;
esac

printf '{}\n'
