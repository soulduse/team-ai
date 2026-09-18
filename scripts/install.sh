#!/usr/bin/env bash
# One-command install for TeamAI: dependencies, build, command links, shell block.
#
# Idempotent by design — re-running it upgrades an existing install rather than
# duplicating anything, so an agent can run it without first checking state.
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
WITH_SHELL=ask
DRY_RUN=false

usage() {
  cat <<'USAGE'
Usage: install.sh [--no-shell] [--with-shell] [--dry-run]

  (default)      install, build, link, then ask about the shell block
  --with-shell   install the shell block without asking (for automation)
  --no-shell     skip the shell block entirely
  --dry-run      print what would happen, change nothing
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --no-shell)   WITH_SHELL=no ;;
    --with-shell) WITH_SHELL=yes ;;
    --dry-run)    DRY_RUN=true ;;
    -h|--help)    usage; exit 0 ;;
    *)            echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

step() { printf '\n==> %s\n' "$1"; }
run()  { if [ "$DRY_RUN" = true ]; then printf '   would run: %s\n' "$*"; else "$@"; fi; }

# Node 20 is the floor the code actually needs; failing here beats failing with
# a confusing syntax error somewhere inside the build.
step "Checking prerequisites"
command -v node >/dev/null || { echo "node not found. Install Node.js 20 or newer." >&2; exit 1; }
command -v npm  >/dev/null || { echo "npm not found. Install Node.js 20 or newer." >&2; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || { echo "Node 20+ required, found $(node -v)." >&2; exit 1; }
echo "   node $(node -v)"

# Not fatal: TeamAI is useful with only one of the two clients installed, and a
# user may well be setting it up before installing the second.
command -v claude >/dev/null || echo "   note: 'claude' is not on PATH — Claude sessions will not launch until it is"
command -v codex  >/dev/null || echo "   note: 'codex' is not on PATH — Codex sessions will not launch until it is"

cd "$REPO_ROOT"

step "Installing dependencies"
# npm ci is reproducible, but it requires the lockfile to match package.json;
# fall back so a modified checkout still installs.
if [ -f package-lock.json ]; then run npm ci || run npm install; else run npm install; fi

step "Building"
run npm run build

step "Linking commands (teamai, tai, tac, tax)"
# npm link writes into a global prefix that may need elevation; say so plainly
# rather than dying with a raw EACCES.
if ! run npm link; then
  echo "npm link failed. If this is a permissions error, either set a user-owned prefix:" >&2
  echo "  npm config set prefix ~/.npm-global && export PATH=\"\$HOME/.npm-global/bin:\$PATH\"" >&2
  echo "or re-run this script with sudo." >&2
  exit 1
fi

if [ "$WITH_SHELL" = ask ] && [ -t 0 ]; then
  printf '\nAdd the cl/co/tai shell block to ~/.zshrc? [y/N] '
  read -r reply
  case "$reply" in [yY]*) WITH_SHELL=yes ;; *) WITH_SHELL=no ;; esac
elif [ "$WITH_SHELL" = ask ]; then
  # Non-interactive and undecided: do not touch the user's rc file silently.
  WITH_SHELL=no
fi

if [ "$WITH_SHELL" = yes ]; then
  step "Installing shell block"
  if [ "$DRY_RUN" = true ]; then run "$REPO_ROOT/scripts/install-shell.sh" --dry-run; else "$REPO_ROOT/scripts/install-shell.sh"; fi
else
  step "Skipping shell block"
  echo "   run scripts/install-shell.sh later to add cl / co / tai"
fi

step "Verifying"
if [ "$DRY_RUN" = true ]; then
  echo "   would run: teamai help"
else
  command -v teamai >/dev/null || { echo "teamai is not on PATH after linking. Check your npm prefix bin directory." >&2; exit 1; }
  teamai help >/dev/null
  echo "   teamai responds"
fi

cat <<'DONE'

TeamAI is installed. Next:

  teamai login     add a Claude or Codex account (repeat per account)
  tai              open the dashboard

DONE
