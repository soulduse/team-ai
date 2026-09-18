# AGENTS.md — instructions for AI coding agents

This file is the machine-facing companion to [README.md](README.md). It states
installation and operation as deterministic commands with verification steps and
failure branches. Follow it literally; prefer it over prose in the README when
the two seem to differ, and report the discrepancy.

## What TeamAI is

A local relay that fronts **Claude Code** and the official **Codex CLI** with a
pool of the user's own subscription accounts, retrying on another account when
one is out of quota. It is not an API gateway and holds no keys of its own.

## Install

Run from the repository root. The script is idempotent — safe to re-run.

```bash
./scripts/install.sh --with-shell     # non-interactive; adds cl/co/tai to ~/.zshrc
./scripts/install.sh --no-shell       # leaves the user's rc file untouched
./scripts/install.sh --dry-run        # prints the plan, changes nothing
```

`--with-shell` writes to `~/.zshrc`. It backs the file up first and rewrites a
marked block in place, but it is still a change to the user's shell config: do
not pass it unless the user asked for the shell helpers. Default to `--no-shell`
when unsure.

Equivalent manual sequence, if the script cannot be used:

```bash
npm ci || npm install
npm run build        # mandatory — dist/ is gitignored, nothing runs without it
npm link
```

### Verify the install

```bash
command -v teamai && teamai help >/dev/null && echo INSTALL_OK
```

### Failure branches

| Symptom | Cause | Action |
| --- | --- | --- |
| `Node 20+ required` | Node too old | Install Node 20+. Do not patch `engines`. |
| `npm link` fails with `EACCES` | Global prefix not user-owned | `npm config set prefix ~/.npm-global`, add `~/.npm-global/bin` to PATH, retry. Do not use `sudo` unless the user approves it. |
| `teamai: command not found` after linking | npm bin dir not on PATH | Print `npm bin -g`, tell the user to add it to PATH. |
| Build fails | Toolchain mismatch | Run `npm run typecheck` and report the output. Do not edit `tsconfig.json` to force it through. |

## Add accounts

Login is interactive and opens a browser. **An agent cannot complete it.** Hand
this to the user rather than attempting it:

```bash
teamai login      # prompts: [1] Claude  [2] Codex
```

Import is non-interactive, but only works when an exportable credential file
exists (recent Claude Code versions use the macOS Keychain instead):

```bash
teamai import claude --from ~/.config/teamclaude.json
teamai import codex
```

`import` never modifies the source files.

## Operate

```bash
teamai status                             # server state + accounts; use this to check health
teamai accounts [claude|codex]            # accounts only
teamai start                              # start relay + open dashboard (needs a TTY)
teamai stop
teamai restart
teamai server                             # run relay in the foreground (for a supervisor)
teamai tui                                # dashboard only (needs a TTY)
teamai enable  <claude|codex> <account>
teamai disable <claude|codex> <account>
teamai priority <claude|codex> <account> <rank|auto>
```

`<account>` is the account's label (usually the email) or its id, exactly as
`teamai accounts` prints it.

### TTY requirement

`tai`, `teamai start`, `teamai restart`, and `teamai tui` render a full-screen
dashboard and **throw `TUI requires a terminal` without a TTY**. In a
non-interactive context use `teamai status` to read state and `teamai server` to
run the relay. Never wrap the TUI in a pty to scrape it.

### Launching sessions

`tac` / `tax` / `teamai claude` / `teamai codex` spawn the official client with
stdio inherited — they are interactive sessions for the user, not something to
run and parse. Start the relay with `teamai server` and let the user drive the
client.

## Configuration

Config and credentials live in `$TEAMAI_HOME`, falling back to
`$XDG_CONFIG_HOME/teamai`, then `~/.config/teamai`. Set `TEAMAI_HOME` to sandbox
a test install:

```bash
TEAMAI_HOME=/tmp/teamai-test teamai status
```

`config.json` keys and defaults are tabulated in the README's Configuration
section. The proxy binds to `127.0.0.1` only. Do not change `proxy.host` to
`0.0.0.0` — it would expose the user's subscription accounts to the network.

Startup failures write their reason to `$TEAMAI_HOME/server-start.log`. Read it
before speculating; a port conflict is the common cause.

## Repository map

| Path | Contents |
| --- | --- |
| `src/cli.ts` | Command dispatch, client launching, on-demand server start |
| `src/runtime.ts` | Server lifecycle, warmup timer, profile refresh |
| `src/account-pool.ts` | Selection order, quota windows, warmup probes |
| `src/proxy.ts` | Request relaying and retry-on-another-account |
| `src/providers.ts` | Claude/Codex specifics: headers, quota parsing, refresh |
| `src/tui.ts` | Dashboard rendering and key handling |
| `src/storage.ts` | Config/state persistence, paths |
| `src/auth.ts` | Login and credential import |
| `test/` | `node --test` suites |

## Before you commit

All four must pass; CI runs the same set on Node 20 and 22, Linux and macOS.

```bash
npm run typecheck && npm test && npm run lint && npm run build
```

## Constraints

- **Do not commit `dist/`.** It is gitignored and built on install.
- **Do not weaken the loopback bind** or the generated client token.
- **Do not log, echo, or copy credentials** from `$TEAMAI_HOME`, `~/.claude`, or
  `~/.codex` into any output, test fixture, or commit.
- **Do not touch the user's `~/.codex`.** Relayed sessions use an isolated Codex
  home; keep it that way.
- **Do not edit `~/.zshrc` directly.** Use `scripts/install-shell.sh`, which
  backs up and rewrites its marked block.
- **Keep the README and the code in agreement.** If you change quota ordering,
  warmup behavior, TUI column titles, CLI commands, or config defaults, update
  the README (and note the change for the translations) in the same commit.
- **Translations** (`README.ko.md`, `.ja.md`, `.zh-CN.md`, `.es.md`) mirror the
  English README, which is canonical. When English changes materially, either
  update all four or flag them as stale — do not leave a translation asserting
  something the code no longer does.
