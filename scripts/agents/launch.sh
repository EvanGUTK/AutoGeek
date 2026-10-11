#!/usr/bin/env bash
# Launch one AutoGeek agent: its own git worktree + its own tmux window running its own Claude CLI.
#
# usage: scripts/agents/launch.sh <agent> <model> <effort> <topic>
#   agent   short name, e.g. foundation  (session is named ag-<agent>)
#   model   claude-sonnet-5-5 | claude-opus-5-5   (never fable: chief only)
#   effort  high | xhigh
#   topic   branch topic, e.g. bootstrap  -> branch agent/<agent>/<topic>
set -euo pipefail

if [[ $# -ne 4 ]]; then
  sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 64
fi

agent="$1"; model="$2"; effort="$3"; topic="$4"

case "$model" in
  claude-sonnet-5-5|claude-opus-5-5) ;;
  *) echo "refusing model '$model': agents use claude-sonnet-5-5 or claude-opus-5-5" >&2; exit 65 ;;
esac
case "$effort" in
  high|xhigh) ;;
  *) echo "refusing effort '$effort': use high or xhigh" >&2; exit 65 ;;
esac
[[ "$agent" =~ ^[a-z][a-z0-9-]*$ ]] || { echo "bad agent name '$agent'" >&2; exit 65; }
[[ "$topic" =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo "bad topic '$topic'" >&2; exit 65; }

root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
wt_root="$(dirname "$root")/AutoGeek-worktrees"
wt="$wt_root/$agent"
branch="agent/$agent/$topic"
session="autogeek"
brief="docs/briefs/$agent.md"

[[ -f "$root/$brief" ]] || { echo "missing brief: $root/$brief" >&2; exit 66; }
command -v tmux >/dev/null || { echo "tmux not installed" >&2; exit 69; }

mkdir -p "$wt_root" "$root/.agents/inbox/$agent" "$root/.agents/inbox/chief" \
         "$root/.agents/status" "$root/.agents/reviews"

if [[ ! -d "$wt" ]]; then
  git -C "$root" worktree add -b "$branch" "$wt" main
else
  echo "worktree $wt already exists; reusing" >&2
fi

if tmux has-session -t "$session" 2>/dev/null; then
  if tmux list-windows -t "$session" -F '#W' | grep -qx "$agent"; then
    echo "tmux window '$agent' already exists in session '$session'" >&2
    exit 73
  fi
  tmux new-window -t "$session" -n "$agent" -c "$wt"
else
  tmux new-session -d -s "$session" -n "$agent" -c "$wt"
fi

prompt="You are ag-$agent, an AutoGeek agent. Your worktree is $wt on branch $branch. Primary checkout (mailbox, status, reviews): $root. Read ARCHITECTURE.md, docs/AGENT-PROTOCOL.md, docs/LEARNINGS.md, then your brief $brief, and begin. Your chief is the session autogeek-d5."

tmux send-keys -t "$session:$agent" \
  "claude --model $model --effort $effort --name ag-$agent --permission-mode auto $(printf '%q' "$prompt")" Enter

echo "launched ag-$agent ($model/$effort) in tmux '$session:$agent' -> $wt"
