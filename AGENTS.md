# AGENTS.md — instructions for AI coding agents

This file is the machine-facing companion to [README.md](README.md). It states
installation and operation as deterministic commands with verification steps and
failure branches. Follow it literally; prefer it over prose in the README when
the two seem to differ, and report the discrepancy.

## What TeamAI is

A local relay that fronts **Claude Code** and the official **Codex CLI** with a
pool of the user's own subscription accounts. For Codex CLI, it retries on
another account when one is out of quota. For Claude Code, each session is
permanently pinned to its initial account (`sessions.json` and persistent ledger)
to preserve conversation history; automatic handover to other accounts on quota
exhaustion or error is blocked. It is not an API gateway and holds no keys of its own.

### Claude session pinning and resumption scope

- **New sessions:** Before launching Claude Code, `tac` and `teamai claude` request a UUID from the relay's authenticated local control port. The relay persists its registration and atomically consumes it when binding the first conversation request. An unregistered ID is rejected with `409`, regardless of message count, role or client account metadata. User-supplied `--session-id` and `--fork-session` are rejected.
- **Turns, compaction and sub-requests:** Requests using the same canonical ID (`x-claude-code-session-id` or matching metadata) retain the initial binding across model changes and compaction. A subagent or in-session `/resume`, `/clear` or fork that introduces an unregistered ID is rejected; TeamAI does not infer parentage or register IDs from conversation bodies. Compatibility depends on the client preserving that ID; these boundaries are tested with synthetic requests, not live subscription sessions.
- **Resumed sessions (`--resume`, `--continue`):** These flags pass through without registering anything. Only a previously recorded binding can resume on its original account. Unproven sessions return `409`; missing or inconsistent storage returns `500`. Resume pickers and names work only if the resulting ID already has a binding.
- **Storage and migration:** Registration, ledger checks and binding use one cross-process file lock. Missing, unreadable, corrupt or inconsistent session files fail closed with `500`, including deletion of an entry followed by restart. An interrupted binding write also fails closed. Existing complete bindings with a consistent older ledger remain usable; conversations without those records are not adopted automatically (see below). Restore a consistent backup rather than deleting files to repair storage. Internal account warmups use a private process token and cannot register conversation IDs.
- **Adopting a session that predates registration:** After an upgrade, a Claude session started under an older relay has no registration and gets `409`. An administrator can record it explicitly: `teamai adopt claude <session-id> --account <account>` (`<account>` is the label or id `teamai accounts` prints) asks the running relay over its authenticated control port (`POST /claude/sessions/adopt`, body `{"sessionId", "account"}`). The relay takes the credential and actual account id from its own pool and writes the binding and its ledger record together under the session lock; no credential is sent or returned. **The chosen account becomes that session's first account**: from then on it is served only there, with no handover on quota, disable or error, so pick the account the session was actually using. Repeating it with the same account changes nothing; another account, a relay-issued ID that is still pending, a disabled, removed or unknown account, or an invalid ID is refused, and damaged storage fails closed with `500` without writing anything. The session ID is the full value Claude Code sends as `x-claude-code-session-id` (the name of its transcript file under `~/.claude/projects/`). Adoption decides which account a conversation belongs to: an agent runs it only for a session ID and an account the user named.

The [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference) documents UUID `--session-id`, resume/continue, and the new ID created by `--fork-session`. Its [hooks reference](https://code.claude.com/docs/en/hooks#common-input-fields) distinguishes the session ID from subagent IDs; it does not guarantee HTTP header behavior for every client feature or version.


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
teamai login claude            # browser callback, or paste the redirect URL / code
teamai login claude --manual   # paste-only: no callback server
teamai login codex --device-auth   # codex login --device-auth (code on any device)
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
teamai capture [--redact partial|full|none] [--out DIR]   # dashboard → .txt + .png; no TTY needed
teamai adopt claude <session-id> --account <account>   # needs a running relay; makes <account> that session's first account
teamai route list [--provider claude|codex]
teamai route add <name> [--provider claude|codex] --match a,b --accounts x,y [--mode prefer|exclusive] [--color c]
teamai route rm <name> [--provider claude|codex]
```

`teamai route` validates with the server's own route parser before writing,
changes only `routes.<provider>` in `config.json`, and asks a running server to
reload over the control port; prefer it to hand-editing `routes`, which a typo
turns into a server that refuses to start.

`enable`, `disable`, `priority`, `login` and `import` save `config.json` and
then ask a running server to apply it in place (`POST /reload` on the control
port) — no restart, nothing in flight cut. The dashboard does the same for
every account change and starts a server only when none is running. A file the
server cannot use is refused (the command prints the reason and exits 1) and the
server keeps its settings. Only an update of TeamAI itself needs
`teamai restart`.

`<account>` is the account's label (usually the email) or its id, exactly as
`teamai accounts` prints it.

### TTY requirement

`tai`, `teamai start`, `teamai restart`, and `teamai tui` render a full-screen
dashboard and **throw `TUI requires a terminal` without a TTY**. In a
non-interactive context use `teamai status` to read state and `teamai server` to
run the relay. Never wrap the TUI in a pty to scrape it.

To see what the dashboard shows, run `teamai capture`: it draws the same frame
headlessly and writes it to `$TEAMAI_HOME/captures/` as `.txt` (colors kept)
and `.png`, printing both paths. Account addresses are masked by default
(`--redact partial`); `--redact full` numbers them, `--redact none` keeps them.
Read the `.txt` for the data; never try to read the live TUI instead.

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

Codex upstream capacity handling is on by default. `codexCapacityEnabled`
(default `true`), `codexCapacityRetryMs` (`500`),
`codexCapacityPreambleHoldMs` (`500`, `0` for no deadline) and
`codexCapacityRotation` (`false`) are checked at startup and applied atomically
by `POST /reload`. Retry intervals are whole milliseconds from 1 to 86400000;
hold deadlines are whole milliseconds from 0 to 86400000. A bad value refuses
the whole reload. Capacity retries have no count or elapsed-time ceiling and
keep the account's slot reserved by default; disconnecting the client stops
them. The Activity line stays active with a retry count, and server output
records each retry. After output, capacity failures become stream disconnects
without a terminal event so Codex can retry. The preamble/frame buffer is
bounded at 4 MiB; an oversized unfinished frame also ends without a terminal
event. Tests must use fake upstreams and an isolated `TEAMAI_HOME`; `npm test`
enforces the isolation through `test/isolation.ts` (a temporary `TEAMAI_HOME`
and `HOME` per test, port-0 listeners only, and no access to the real
TeamAI/Codex/Claude directories, the relay's ports or non-loopback hosts). Start
the real server in a test with `startOnAnyPorts` from `test/server-ports.ts`.

Changes to `config.json` and `credentials.json` go through `updateConfig` /
`updateCredentials` in `src/storage.ts`: a read/change/write under
`<file>.lock`, serialized in-process and across processes, with a unique temp
file per write. Do not load, edit and `saveConfig` a file the server or another
command may be changing at the same time.

Startup failures write their reason to `$TEAMAI_HOME/server-start.log`. Read it
before speculating; a port conflict is the common cause.

## Repository map

| Path | Contents |
| --- | --- |
| `src/cli.ts` | Command dispatch, client launching, on-demand server start |
| `src/runtime.ts` | Server lifecycle, warmup timer, profile refresh |
| `src/account-pool.ts` | Selection order, quota windows, warmup probes |
| `src/proxy.ts` | Request relaying and retry-on-another-account |
| `src/codex-capacity.ts` | Codex capacity detection, bounded SSE gate and reloadable settings |
| `src/providers.ts` | Claude/Codex specifics: headers, quota parsing, refresh |
| `src/frame.ts` | The dashboard as text: display order, gauges, the frame builder both the TUI and capture draw through, and the narrow (< 80 columns) summary layout |
| `src/columns.ts` | Terminal cell widths (wide/zero-width characters), `fit`, and the usage grid every dashboard panel shares (identity, three gauges, tail) |
| `src/tui.ts` | Interactive loop and key handling |
| `src/capture.ts` | `teamai capture` / the `p` key: redact, build the frame, write `.txt` + `.png` |
| `src/redact.ts` | Account-address masking (partial / full / none), applied to data before drawing |
| `src/png.ts` | Dependency-free PNG encoder (own CRC-32: `zlib.crc32` is Node 22.2+) and SGR-to-pixel renderer |
| `src/font.ts` | Generated 9×18 bitmap glyphs; regenerate with `scripts/gen-font.py` (needs Pillow, build-time only) |
| `src/font-cjk.ts` | Generated GNU Unifont glyphs (SIL OFL 1.1) for Hangul, kana, kanji, fullwidth forms and wider symbol blocks, deflated; regenerate with `scripts/gen-font-cjk.py` (needs Pillow and Unifont, build-time only) |
| `src/routes.ts` | Model-route parsing and matching (`parseRoutes` is the one validator) |
| `src/route-config.ts` | Saving routes (validate, write only `routes`, reload a running server); `teamai route` |
| `src/route-control.ts` | Control-port `POST /routes/reload` |
| `src/config-reload.ts` | Control-port `POST /reload`: validate `config.json` whole, then apply accounts, routes and Codex capacity settings to the running pools in place |
| `src/config-apply.ts` | What the dashboard and account commands call after a write: reload a running server, start one only when none runs |
| `src/route-editor.ts` | The dashboard's route editor (`g`): pure key handling and drawing |
| `src/claude-session-control.ts` | Control-port Claude session issuance (`POST /claude/sessions`) and adoption (`POST /claude/sessions/adopt`); `tac`'s registration and `teamai adopt claude` |
| `src/storage.ts` | Config/state persistence, paths, the per-file lock that serializes config and credential changes |
| `src/auth.ts` | Login and credential import |
| `test/` | `node --test` suites; `isolation.ts` is the guard every run loads, `server-ports.ts` starts the real server on port 0 |

## Before you commit

All four must pass. There is no CI; this local gate is the whole gate, and the
code must keep working on Node 20 (`engines`), not just on whatever is installed.

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
