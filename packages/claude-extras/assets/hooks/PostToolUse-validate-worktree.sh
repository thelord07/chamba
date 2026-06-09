#!/usr/bin/env bash
# chamba PostToolUse hook: nudge when edits land outside a chamba worktree.
#
# When a task is assigned a worktree under .chamba/worktrees/, edits should stay
# inside it. This hook inspects the edited file path (from the tool call JSON on
# stdin) and, if CHAMBA_WORKTREE is set and the path is outside it, emits a
# non-blocking warning. It never blocks — it only informs.
#
# Register in ~/.claude/settings.json under hooks.PostToolUse (matcher: "Edit|Write").

set -euo pipefail
input="$(cat)"

[ -z "${CHAMBA_WORKTREE:-}" ] && { printf '{}\n'; exit 0; }

file_path="$(printf '%s' "$input" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\(.*\)".*/\1/p')"
[ -z "$file_path" ] && { printf '{}\n'; exit 0; }

case "$file_path" in
  "$CHAMBA_WORKTREE"*)
    printf '{}\n'
    ;;
  *)
    printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"chamba: edited %s outside the assigned worktree (%s)."}}\n' "$file_path" "$CHAMBA_WORKTREE"
    ;;
esac
