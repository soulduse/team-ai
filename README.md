# TeamAI

TeamAI is a local multi-account relay for **Claude Code** and the official **Codex CLI**. It keeps a separate account pool for each provider and retries a request with another account when the selected subscription is unavailable or out of quota.

> TeamAI is an independent open-source project. It is not affiliated with Anthropic, OpenAI, or the unrelated service at teamai.com.

## Requirements

- Node.js 20+
- macOS or Linux
- `claude` and/or `codex` installed separately
- Your own Claude Pro/Max or ChatGPT Codex subscription accounts

## Install for development

```bash
npm install
npm run build
npm link
```

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
teamai status
teamai start
teamai disable codex user@example.com
teamai enable codex user@example.com
teamai priority claude user@example.com 1
teamai restart
```

The full-screen TUI groups Claude and Codex accounts and keeps the currently selected account anchored even when usage changes. Claude rows show the 5-hour session (`Ses`), overall weekly (`Wk`), and model-scoped Fable (`Fbl`) windows independently; Codex rows show its primary and secondary windows. Quotas are learned from official-client responses and retained across restarts.

The footer exposes the same account workflow as TeamClaude: launch Claude/Codex, select, switch, enable/disable, order, delete, add/login, re-measure (`R`), and quit. `switch` pins the selected account to the front of its provider pool; order mode can assign a rank or return an account to automatic scheduling. Claude profile refreshes show the plan tier and unhealthy subscription states such as `past_due` in red.

`R` re-measures quota across the whole fleet. Quota is never polled from a separate endpoint — it is learned from the rate-limit headers upstream returns, so an account that has served no traffic shows `-` until something measures it. `R` replays a known-accepted request shape against every idle account in parallel (including already-measured and throttled ones, whose 429s still carry authoritative headers) and reports an honest `measured/targets` count. That shape is committed only from a real 2xx that flowed through the proxy, so until one request has succeeded `R` reports that no probe template exists yet rather than guessing a payload. Accounts missing the model-scoped weekly (Fable) window get one extra top-up probe, because that window only appears on responses to Fable-tier requests.

The server also warms up on its own every five minutes (`warmupIntervalMs`, 0 to disable): it clears quota windows upstream has already reset and measures only the accounts that are unmeasured, so a settled fleet costs nothing per tick and a window that rolls over refills without anyone pressing `R`. An account whose upstream never reports quota is dropped after three fruitless attempts, and that budget is renewed whenever its window resets or you press `R`.

The `~D-N` subscription value is an estimate, not an authoritative expiry date: Anthropic's profile endpoint exposes subscription status and creation time, but no current billing-period end. TeamAI therefore estimates the next monthly billing anniversary and marks it with `~`. Profile state is refreshed at server startup and every six hours.

Configuration and credentials live under `~/.config/teamai` by default. Set `TEAMAI_HOME` to override it. The proxies bind to `127.0.0.1` and require a generated local client token.

## Scope and compliance

Version 0.1 targets subscription OAuth accounts and wrapper-launched CLI sessions. It does not expose a public OpenAI-compatible API, convert Claude requests to Codex requests, support Codex Desktop, or pool credentials between different people. You are responsible for complying with provider terms and policies. Production/commercial API workloads should use the providers' official API billing mechanisms.

## Development

```bash
npm run typecheck
npm test
npm run lint
```

See [NOTICE](NOTICE) for derived work and [SECURITY.md](SECURITY.md) for the local security model.
