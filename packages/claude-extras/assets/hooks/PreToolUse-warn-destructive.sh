#!/usr/bin/env bash
# chamba PreToolUse hook: warn on obviously destructive shell commands.
#
# Claude Code passes the tool call as JSON on stdin. This hook scans Bash
# commands for destructive patterns and asks for confirmation by emitting a
# permissionDecision of "ask". Anything else is allowed through untouched.
#
# Register in ~/.claude/settings.json under hooks.PreToolUse (matcher: "Bash").

set -euo pipefail
input="$(cat)"

# Pull the command out of the JSON without requiring jq.
command="$(printf '%s' "$input" | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\(.*\)".*/\1/p')"

case "$command" in
  *"rm -rf"*|*"git push --force"*|*"git reset --hard"*|*":(){:|:&};:"*)
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"chamba: this command looks destructive — confirm before running."}}\n'
    ;;
  *)
    printf '{}\n'
    ;;
esac
