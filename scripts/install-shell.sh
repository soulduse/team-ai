#!/usr/bin/env bash
# Install (or remove) the team-ai shell block in ~/.zshrc.
#
#   cl  -> Claude Code through the team-ai account pool
#   co  -> Codex through the team-ai account pool
#
# The block is delimited by markers and rewritten in place, so running this
# again upgrades it rather than appending a second copy.
set -euo pipefail

BEGIN='# >>> team-ai >>>'
END='# <<< team-ai <<<'
RC="${ZDOTDIR:-$HOME}/.zshrc"
ACTION=install
DRY_RUN=false

usage() {
  cat <<'USAGE'
Usage: install-shell.sh [--uninstall] [--dry-run] [--rc <path>]

  (default)     install or upgrade the team-ai block in ~/.zshrc
  --uninstall   remove the block
  --dry-run     print what would change, write nothing
  --rc <path>   operate on a different rc file
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) ACTION=uninstall ;;
    --dry-run)   DRY_RUN=true ;;
    --rc)        shift; RC="${1:?--rc needs a path}" ;;
    -h|--help)   usage; exit 0 ;;
    *)           echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

# The launcher is resolved at install time so the block keeps working even if
# the npm link is removed later; fall back to the command on PATH.
REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$REPO_ROOT/dist/src/cli.js"
if [ -f "$CLI" ]; then
  NODE_BIN="$(command -v node || true)"
  [ -n "$NODE_BIN" ] || { echo "node not found on PATH" >&2; exit 1; }
  LAUNCH="\"\$_TEAMAI_NODE\" \"\$_TEAMAI_CLI\""
  PREAMBLE="_TEAMAI_NODE=\"$NODE_BIN\"
_TEAMAI_CLI=\"$CLI\""
else
  command -v teamai >/dev/null || { echo "neither $CLI nor a teamai on PATH; run npm run build first" >&2; exit 1; }
  LAUNCH="command teamai"
  PREAMBLE=""
fi

block() {
  cat <<BLOCK
$BEGIN
# Managed by team-ai scripts/install-shell.sh — edits here are overwritten.
# cl = Claude Code via the team-ai pool, co = Codex via the team-ai pool.
# Either one starts the relay first if it is not already running.
$PREAMBLE
cl() { $LAUNCH claude "\$@"; }
co() { $LAUNCH codex  "\$@"; }

# 'start' is passed explicitly: the CLI picks the dashboard from argv[0] when
# invoked as tai, which a function or alias does not reproduce.
tai()  { $LAUNCH start "\$@"; }
tais() { $LAUNCH status "\$@"; }
alias taistart='launchctl kickstart gui/\$(id -u)/com.teamai.proxy'
alias tairestart='launchctl kickstart -k gui/\$(id -u)/com.teamai.proxy'
alias taistop='launchctl bootout gui/\$(id -u)/com.teamai.proxy'

# team-ai points each session at its own port, so a globally pinned base URL
# only sends traffic somewhere stale (e.g. a proxy that is no longer running).
unset ANTHROPIC_BASE_URL
$END
BLOCK
}

[ -f "$RC" ] || { echo "no such file: $RC" >&2; exit 1; }

# Rewrite with awk rather than sed -i: portable, and it round-trips the file
# untouched when the block is absent.
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
awk -v b="$BEGIN" -v e="$END" '
  $0 == b { skip = 1; next }
  $0 == e { skip = 0; next }
  !skip   { print }
' "$RC" > "$tmp"

# Trim TRAILING blank lines only, so repeated install/uninstall cycles cannot
# pile them up where the block used to sit. Blank lines elsewhere in the file
# are the user's formatting and must survive untouched.
trimmed="$(mktemp)"
awk '
  NF { for (i = 1; i <= pending; i++) print ""; pending = 0; print; next }
  { pending++ }
' "$tmp" > "$trimmed"
mv "$trimmed" "$tmp"

if [ "$ACTION" = install ]; then
  printf '\n' >> "$tmp"
  block >> "$tmp"
fi

if [ "$DRY_RUN" = true ]; then
  echo "--- would write $RC ---"
  diff -u "$RC" "$tmp" || true
  exit 0
fi

backup="$RC.teamai-backup.$(date +%Y%m%d%H%M%S)"
cp "$RC" "$backup"
cat "$tmp" > "$RC"

if [ "$ACTION" = install ]; then
  echo "Installed the team-ai block in $RC (backup: $backup)"
  echo "Run 'source $RC' or open a new terminal, then use: cl / co / tai / tais"
else
  echo "Removed the team-ai block from $RC (backup: $backup)"
fi
