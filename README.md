# TeamAI

**English** · [한국어](README.ko.md) · [日本語](README.ja.md) · [中文](README.zh-CN.md) · [Español](README.es.md)

TeamAI is a local multi-account relay for **Claude Code** and the official **Codex CLI**. It keeps a separate account pool for each provider and retries a request with another account when the selected subscription is unavailable or out of quota.

![TeamAI dashboard](docs/dashboard.png)

<sub>The dashboard above is a real capture, taken with <code>teamai capture --redact full</code>: real quota and activity, no account addresses.</sub>

> TeamAI is an independent open-source project. It is not affiliated with Anthropic, OpenAI, or the unrelated service at teamai.com.

## Requirements

- Node.js 20+
- macOS or Linux
- `claude` and/or `codex` installed separately
- Your own Claude Pro/Max or ChatGPT Codex subscription accounts

## Install

```bash
git clone https://github.com/soulduse/team-ai.git
cd team-ai
./scripts/install.sh
```

`install.sh` installs dependencies, builds, links the `teamai`/`tai`/`tac`/`tax`
commands, and offers to add the shell block. It is idempotent — re-run it to
upgrade. Pass `--no-shell` to skip the shell block, or `--dry-run` to see what it
would do.

To do the same by hand:

```bash
npm install
npm run build          # required: dist/ is not committed
npm link
```

Automating this from an AI agent? See [AGENTS.md](AGENTS.md), which states the
same steps as deterministic commands with verification and failure branches.

## Quick start

```bash
teamai login
tai
```

`login` asks whether to add `[1] Claude` or `[2] Codex`. Repeat it for additional accounts. `tai` is the short session command and is equivalent to `teamai start`: it launches the local relay and opens the dashboard. From the TUI press `1` to launch Claude Code or `2` to launch Codex. When the client exits, the dashboard returns.

For a direct provider session, use the dedicated launchers. They automatically start the TeamAI relay when necessary and pass every trailing argument to the official client:

```bash
tac                   # Claude Code through the TeamAI account pool
tac --resume          # same as: teamai claude --resume
tax                   # Codex through the TeamAI account pool
tax resume            # same as: teamai codex resume
teamai claude         # long form of tac
teamai codex          # long form of tax
teamai session        # choose [1] Claude or [2] Codex interactively
```

The names intentionally avoid replacing an existing TeamClaude `tc` shell function. `tc` can continue to target TeamClaude while `tac` and `tax` target TeamAI.

## Shell setup

```bash
./scripts/install-shell.sh            # adds a marked block to ~/.zshrc
./scripts/install-shell.sh --dry-run  # show the diff, write nothing
./scripts/install-shell.sh --uninstall
```

It defines `cl` (Claude Code) and `co` (Codex) through the pool, plus `tai`,
`tais` and `taistart`/`tairestart`/`taistop` for the LaunchAgent, and unsets a
globally pinned `ANTHROPIC_BASE_URL` — TeamAI points each session at its own
port, so a stale global value only routes traffic to a proxy that may no longer
be running. The block is delimited by markers and rewritten in place, so
re-running it upgrades rather than appends; every write leaves a timestamped
backup, and install/uninstall cycles restore the file byte for byte.

A supervisor is optional: `cl`, `co`, `tai` and `teamai run` all start the relay
themselves when nothing is listening, so they keep working if the LaunchAgent is
unloaded, fails, or was never installed. A stale `server.json` left by a killed
process is ignored and replaced. When startup does fail, the reason from the
server (a port already in use, an unreadable credential file) is reported
instead of a bare "did not start", and the full output is kept at
`~/.config/teamai/server-start.log`.

### Running the relay as a login item

This is optional. The `taistart`/`tairestart`/`taistop` aliases installed above
drive a LaunchAgent labeled `com.teamai.proxy`, so use exactly that label:

```xml
<!-- ~/Library/LaunchAgents/com.teamai.proxy.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>          <string>com.teamai.proxy</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/ABSOLUTE/PATH/TO/team-ai/dist/src/cli.js</string>
    <string>server</string>
  </array>
  <key>RunAtLoad</key>      <true/>
  <key>KeepAlive</key>      <true/>
  <key>StandardErrorPath</key> <string>/tmp/teamai.err.log</string>
</dict>
</plist>
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.teamai.proxy.plist
```

Use `command -v node` for the real Node path; a LaunchAgent does not inherit
your shell's PATH.

## Accounts

Codex uses its normal browser login flow. TeamAI does not require ChatGPT's optional device-code authentication setting to be enabled.

Credential import is optional and only works when an exportable credential file exists:

```bash
# Import every account from an existing TeamClaude config.
teamai import claude --from ~/.config/teamclaude.json

# Import Codex CLI's current file-based login, when present.
teamai import codex
```

Recent Claude Code versions may store credentials in the macOS Keychain rather than `~/.claude/.credentials.json`; use `teamai login` in that case. `import` never modifies the original TeamClaude, Claude Code, or Codex files. TeamAI uses a persistent isolated Codex home for relayed sessions, so the user's original `~/.codex` remains untouched.

## Operations

```bash
teamai status                                  # server state + account table
teamai accounts [claude|codex]                 # account table only
teamai start                                   # start relay, open dashboard
teamai stop                                    # stop the relay
teamai restart                                 # stop, start, open dashboard
teamai server                                  # run the relay in the foreground
teamai tui                                     # dashboard only, no auto-start
teamai disable codex user@example.com
teamai enable codex user@example.com
teamai priority claude user@example.com 1      # or: auto
teamai capture [--redact partial|full|none] [--out DIR]   # dashboard → .txt + .png, no TTY needed
```

Accounts are ordered by how much quota they have left, least-spent first, in
both the dashboard and the pool's own selection — so the top row is the account
the next request would go to. Claude is judged on its model-weekly (Fable)
window rather than the overall one, because that is what actually refuses the
top model first. Once every account is spent they all tie, and the order falls
through to whichever frees up soonest — on a fleet where nothing can serve a
request today, time-to-reset is the only thing that separates them (Claude on
its Fable window, Codex on its weekly one). An unmeasured
account sorts last (unknown is not the same as empty), a pinned priority still
wins, and `c` toggles back to configured order.

**Model-aware routing.** Only the top model (Claude's Fable tier) draws on the
model-weekly window, so a request that does not need it — Opus, Sonnet, Haiku —
is routed away from accounts that still have Fable budget and onto accounts
whose Fable window is already spent (at or above `fableReserveThreshold`),
ranked within that group by their overall weekly window. This keeps each
account's scarce Fable budget for the requests that actually need it, and puts
otherwise-idle weekly headroom to use. When no spent account is free the request
falls back to a reserved one rather than failing. A Fable request keeps the
plain least-spent order; set `fableReserveThreshold` to `1` to turn the split
off.

A Fable-tier 429 (`7d_oi` rejected while the shared `5h`/`7d` windows are still
allowed) benches only that account's Fable window, not the account: every other
model keeps being served from it, instead of the whole account sitting idle for
up to a week over a budget only the top model spends. A 429 that rejects a
shared window benches the account as usual.

The full-screen TUI groups Claude and Codex accounts and keeps the currently selected account anchored even when usage changes. Claude rows show the `5h session`, `7d overall`, and model-scoped `7d Fable` windows independently; Codex rows show its primary and secondary windows, each titled with the span that account actually reports (`1w limit`). Quotas are learned from official-client responses and retained across restarts.

The footer exposes the same account workflow as TeamClaude: launch Claude/Codex, select, switch, enable/disable, order, delete, add/login, re-measure (`R`), and quit. `switch` pins the selected account to the front of its provider pool; order mode can assign a rank or return an account to automatic scheduling. Claude profile refreshes show the plan tier and unhealthy subscription states such as `past_due` in red.

`p` saves a capture of the dashboard, and `teamai capture` does the same from a script or an agent, no terminal required. Each capture is a pair of files under `~/.config/teamai/captures/` (or `--out DIR`): the frame as text with its colors intact, and the same frame as a PNG drawn with a built-in bitmap font, so nothing beyond Node is needed. Account addresses are masked before the frame is drawn — in the account column, the footer and the activity log alike — as `de•••••••••w@gm•••.com` by default; `--redact full` replaces them with `account #N`, and `--redact none` keeps them for a capture that stays private. From the dashboard, `p` also reveals the PNG in your file manager and puts the image on the clipboard — on macOS out of the box, on Linux where `xdg-open` and `wl-copy` or `xclip` are installed — and the footer says which of those happened. The image at the top of this README is one such capture.

`R` re-measures quota across the whole fleet. Quota is never polled from a separate endpoint — it is learned from the rate-limit headers upstream returns, so an account that has served no traffic shows `-` until something measures it. `R` replays a known-accepted request shape against every idle account in parallel (including already-measured and throttled ones, whose 429s still carry authoritative headers) and reports an honest `measured/targets` count. That shape is committed only from a real 2xx that flowed through the proxy, so until one request has succeeded `R` reports that no probe template exists yet rather than guessing a payload. Accounts missing the model-scoped weekly (Fable) window get one extra top-up probe, because that window only appears on responses to Fable-tier requests.

The server also warms up on its own every five minutes (`warmupIntervalMs`, 0 to disable): it clears quota windows upstream has already reset and measures only the accounts that are unmeasured, so a settled fleet costs nothing per tick and a window that rolls over refills without anyone pressing `R`. An account whose upstream never reports quota is dropped after three fruitless attempts, and that budget is renewed whenever its window resets or you press `R`.

Idle accounts are kept alive on the same five-minute cycle: any account whose token is expiring or whose last attempt errored is refreshed, one at a time. Ordinary traffic sticks to a few accounts and warm-up deliberately never refreshes, so without this an account no one uses could let its refresh-token chain lapse and be invalidated upstream. The sweep is sequential on purpose — refreshing the whole fleet at once after a long downtime would burst the token endpoint into a rate limit.

Learned quota (usage, windows, reset times, subscription profile) is written to disk and restored on the next start, so the dashboard and ranking survive a restart without re-measuring; the probe shape `R` replays is persisted the same way. Per-response signals are not: a cooldown or an error is deliberately dropped on restart, so an account is never re-benched by a stale 429's retry-after — if it really is spent, the next request re-derives the right state.

If more requests arrive at once than the fleet's combined per-account concurrency can serve, the relay rejects the overflow with `429` (`x-teamai-429-reason: concurrency_saturated`) before reading the request body, rather than buffering unbounded bodies. The same header distinguishes a busy fleet from a spent one (`quota_exhausted`) on the "no account available" 429.

The `~D-N` subscription value is an estimate, not an authoritative expiry date: Anthropic's profile endpoint exposes subscription status and creation time, but no current billing-period end. TeamAI therefore estimates the next monthly billing anniversary and marks it with `~`. Profile state is refreshed at server startup and every six hours.

## Configuration

Configuration and credentials live in `$TEAMAI_HOME`, falling back to
`$XDG_CONFIG_HOME/teamai` and then `~/.config/teamai`. The proxies bind to
`127.0.0.1` and require a generated local client token.

`config.json` is created on first run with these defaults:

| Key | Default | Meaning |
| --- | --- | --- |
| `proxy.host` | `127.0.0.1` | Bind address. Loopback only by design. |
| `proxy.claudePort` | `3456` | Claude relay port. |
| `proxy.codexPort` | `3457` | Codex relay port. |
| `proxy.controlPort` | `3556` | Control channel the TUI talks to. |
| `proxy.clientToken` | generated | Local token every relayed client must send. |
| `switchThreshold` | `0.98` | Usage ratio above which an account stops being selected. |
| `warmupIntervalMs` | `300000` | Background re-measure interval. `0` disables it. |
| `maxConcurrentPerAccount` | `16` | In-flight requests allowed per account. `0` means unlimited. |
| `fableReserveThreshold` | `0.8` | Fable-window usage at or above which an account is preferred for non-Fable requests. `1` turns model-aware routing off. |
| `proxy.legacyPorts` | — | Optional. Extra ports to keep answering on, per provider — e.g. `{ "claude": [3400] }`. |

Change a port if something else already owns it — that is the usual cause of a
failed start, and the reason appears in `server-start.log`.

A client is handed its base URL at startup and cannot be redirected afterwards,
so moving a port in `config.json` would otherwise strand every session already
open with connection refused. The relay therefore also answers on the built-in
default port and any `proxy.legacyPorts` you list, keeping open sessions alive
across a port change. A legacy port that something else already owns is skipped
without affecting the main port, and a socket error after startup is logged
rather than allowed to take the relay down.

## Scope and compliance

Version 0.1 targets subscription OAuth accounts and wrapper-launched CLI sessions. It does not expose a public OpenAI-compatible API, convert Claude requests to Codex requests, support Codex Desktop, or pool credentials between different people. You are responsible for complying with provider terms and policies. Production/commercial API workloads should use the providers' official API billing mechanisms.

## Development

```bash
npm run typecheck
npm test
npm run lint
```

See [NOTICE](NOTICE) for derived work and [SECURITY.md](SECURITY.md) for the local security model.

TeamAI persists relay routing in the isolated `codex-home/config.toml` and passes `TEAMAI_PROXY_TOKEN` to the client so nested `codex exec` processes that retain this environment can use the relay. The original `~/.codex` is unchanged. A launcher that replaces the home or higher-priority provider settings can still select another route; the outer CLI's `-c` arguments are not automatically inherited by child processes. Automation that requires the relay should pass the provider overrides explicitly and verify `provider: teamai` in its execution log. Missing relay credentials must be treated as an error rather than silently falling back to direct authentication.

<!-- transient-recovery-2026-09-22 -->
Transient upstream errors retain their original HTTP status, body and Retry-After. After account failover, the relay allows up to two retry rounds (at most 10 seconds of backoff per round and 20 seconds total); longer waits are returned to the client. Successful streams are never replayed. Codex HTTP retries remain disabled to avoid multiplying relay retries. Restart the relay after rebuilding to activate changes.
