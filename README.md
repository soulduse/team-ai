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
# Explicitly import the account currently logged into each official client.
teamai import claude
teamai import codex

# Import every account from an existing TeamClaude config at once.
teamai import claude --from ~/.config/teamclaude.json

# Log into another account and repeat, or use TeamAI's login command.
teamai login claude
teamai login codex

teamai accounts
teamai run claude
teamai run codex
```

`import` reads and copies credentials only when invoked. It never modifies the original TeamClaude, Claude Code, or Codex files. `run codex` uses a persistent isolated Codex home containing TeamAI's local provider configuration; the user's original `~/.codex` remains untouched.

## Operations

```bash
teamai status
teamai tui
teamai disable codex user@example.com
teamai enable codex user@example.com
teamai priority claude user@example.com 1
teamai restart
```

The full-screen TUI groups Claude and Codex accounts and keeps the currently selected account anchored even when usage changes. Claude rows show the 5-hour session (`Ses`), overall weekly (`Wk`), and model-scoped Fable (`Fbl`) windows independently; Codex rows show its primary and secondary windows. Quotas are learned from official-client responses and retained across restarts.

The footer exposes the same account workflow as TeamClaude: select, switch, enable/disable, order, delete, add/login, reload, and quit. `switch` pins the selected account to the front of its provider pool; order mode can assign a rank or return an account to automatic scheduling. Claude profile refreshes show the plan tier and unhealthy subscription states such as `past_due` in red.

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
