#!/usr/bin/env node
import './threadpool.js';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, open, readFile, rm, writeFile, lstat, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { connect } from 'node:net';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { importAuth, login } from './auth.js';
import { captureDashboard } from './capture.js';
import { refreshErrorKind, resetTicketsNote } from './frame.js';
import { relayedCodexConfig } from './codex-config.js';
import { launchCommand } from './launch.js';
import { isRedactLevel } from './redact.js';
import { buildUsageReport, formatUsageTable, type UsageReport } from './usage.js';
import { releaseServerFile, runServer, runningPid } from './runtime.js';
import { dataDir, loadConfig, loadState, paths, providerPort, saveConfig, upsertAccount } from './storage.js';
import { runTui } from './tui.js';
import { PROVIDER_IDS, type ProviderId, type TeamAIConfig } from './types.js';

const invokedAs = basename(process.argv[1] || 'teamai');
const inputArgs = process.argv.slice(2);
const invocation = invokedAs === 'tai' ? ['start', ...inputArgs] : invokedAs === 'tac' ? ['run', 'claude', ...inputArgs] : invokedAs === 'tax' ? ['run', 'codex', ...inputArgs] : invokedAs === 'tag' ? ['run', 'grok', ...inputArgs] : inputArgs;
const [command = 'help', ...args] = invocation;

function provider(value?: string): ProviderId { const id = PROVIDER_IDS.find((x) => x === value); if (!id) throw new Error(`Provider must be ${PROVIDER_IDS.join(', ')}`); return id; }
function flag(name: string): string | undefined { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; }

async function main(): Promise<void> {
  switch (command) {
    case 'login': { const id = args[0] ? provider(args[0]) : await selectProvider('Login provider'); const result = await login(id); const account = await upsertAccount(id, result.label, result.credential); console.log(`Added ${id} account: ${account.label}`); break; }
    case 'import': { const id = provider(args[0]); const results = await importAuth(id, flag('--from')); for (const result of results) { const account = await upsertAccount(id, result.label, result.credential); console.log(`Imported ${id} account: ${account.label}`); } break; }
    case 'accounts': await accounts(args[0] ? provider(args[0]) : undefined); break;
    case 'enable': await toggle(true); break;
    case 'disable': await toggle(false); break;
    case 'priority': await priority(); break;
    case 'fable-only': await fableOnly(); break;
    case 'server': await runServer(); break;
    case 'start': await ensureServer(); await runTui(); break;
    case 'status': await status(); break;
    case 'usage': await usage(); break;
    case 'stop': await stop(); break;
    case 'restart': await stop(true); await ensureServer(); await runTui(); break;
    case 'session': await runClient(await selectProvider('Select session'), args.filter((x) => x !== '--')); break;
    case 'claude': await runClient('claude', args.filter((x) => x !== '--')); break;
    case 'codex': await runClient('codex', args.filter((x) => x !== '--')); break;
    case 'grok': await runClient('grok', args.filter((x) => x !== '--')); break;
    case 'run': await runClient(provider(args[0]), args.slice(args[0] ? 1 : 0).filter((x) => x !== '--')); break;
    case 'tui': await runTui(); break;
    case 'capture': {
      const level = flag('--redact') ?? 'partial'; if (!isRedactLevel(level)) throw new Error('--redact must be partial, full or none');
      const result = await captureDashboard({ level, outDir: flag('--out'), width: process.stdout.columns });
      console.log(result.text); console.log(result.png); break;
    }
    case 'help': case '--help': case '-h': help(); break;
    default: throw new Error(`Unknown command: ${command}`);
  }
}

async function selectProvider(promptLabel: string): Promise<ProviderId> {
  if (!process.stdin.isTTY) throw new Error(`Specify ${PROVIDER_IDS.join(', ')} explicitly in a non-interactive shell`);
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await prompt.question(`${promptLabel} — [1] Claude, [2] Codex, [3] Grok: `)).trim().toLowerCase();
    if (answer === '1' || answer === 'c' || answer === 'claude') return 'claude';
    if (answer === '2' || answer === 'x' || answer === 'codex') return 'codex';
    if (answer === '3' || answer === 'g' || answer === 'grok') return 'grok';
    throw new Error('Choose 1 for Claude, 2 for Codex or 3 for Grok');
  } finally { prompt.close(); }
}

async function accounts(filter?: ProviderId): Promise<void> {
  const config = await loadConfig(); const state = await loadState();
  for (const a of config.accounts.filter((x) => !filter || x.provider === filter)) { const s = state.accounts[a.credentialId]; const usage = s?.usage == null ? 'unknown' : `${Math.round(s.usage * 100)}%`; console.log(`${a.provider.padEnd(7)} ${a.enabled ? 'on ' : 'off'} ${usage.padStart(7)} ${a.priority === null ? 'auto' : `#${a.priority}`} ${a.label}${a.fableOnly ? ' (fable only)' : ''}${resetTicketsNote(s?.resetCredits)}${errorNote(s)}`); }
}
function errorNote(saved: Parameters<typeof refreshErrorKind>[0]): string { const kind = refreshErrorKind(saved); return kind === 'unreachable' ? '  [retrying: token server unreachable]' : kind ? '  [error: re-login needed]' : ''; }
async function toggle(enabled: boolean): Promise<void> { const id = provider(args[0]); const name = args.slice(1).join(' '); const config = await loadConfig(); const account = config.accounts.find((a) => a.provider === id && (a.id === name || a.label === name)); if (!account) throw new Error('Account not found'); account.enabled = enabled; await saveConfig(config); console.log(`${enabled ? 'Enabled' : 'Disabled'} ${account.label}`); }
async function fableOnly(): Promise<void> { const id = provider(args[0]); if (id !== 'claude') throw new Error('fable-only applies to Claude accounts only'); const mode = args.at(-1); const name = args.slice(1, -1).join(' '); if (mode !== 'on' && mode !== 'off') throw new Error('Use on or off'); const config = await loadConfig(); const account = config.accounts.find((a) => a.provider === id && (a.id === name || a.label === name)); if (!account) throw new Error('Account not found'); account.fableOnly = mode === 'on' || undefined; await saveConfig(config); console.log(`Fable only ${mode}: ${account.label} (a running relay picks it up on R in the dashboard or teamai restart)`); }
async function priority(): Promise<void> { const id = provider(args[0]); const rankRaw = args.at(-1); const name = args.slice(1, -1).join(' '); const config = await loadConfig(); const account = config.accounts.find((a) => a.provider === id && (a.id === name || a.label === name)); if (!account) throw new Error('Account not found'); if (!rankRaw || (rankRaw !== 'auto' && (!Number.isInteger(Number(rankRaw)) || Number(rankRaw) < 1))) throw new Error('Priority must be a positive integer or auto'); account.priority = rankRaw === 'auto' ? null : Number(rankRaw); await saveConfig(config); console.log(`Priority ${account.priority ?? 'auto'}: ${account.label}`); }

// Live from the server's control port when it answers, else the same report
// built from state.json — so the command works whether or not a relay runs.
async function usage(): Promise<void> {
  const level = flag('--redact') ?? 'partial'; if (!isRedactLevel(level)) throw new Error('--redact must be partial, full or none');
  const config = await loadConfig(); let report: UsageReport | null = null;
  if (await runningPid()) {
    try {
      const port = config.proxy.controlPort ?? config.proxy.claudePort + 100;
      const response = await fetch(`http://${config.proxy.host}:${port}/usage?redact=${level}`, { headers: { authorization: `Bearer ${config.proxy.clientToken}` }, signal: AbortSignal.timeout(3_000) });
      if (response.ok) report = await response.json() as UsageReport;
    } catch { /* an older server without /usage, or a busy one: fall back to state.json */ }
  }
  report ??= buildUsageReport(config, await loadState(), { source: 'state', level });
  console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : formatUsageTable(report));
}

async function status(): Promise<void> {
  const pid = await runningPid(); console.log(pid ? `TeamAI server running (pid ${pid})` : 'TeamAI server is stopped'); await accounts();
  // Token failures and recoveries, kept apart from request lines so they are still here hours later.
  const notices = (await loadState()).notices ?? [];
  if (notices.length) { console.log('\nRecent notices:'); for (const n of notices.slice(-10)) console.log(`  ${new Date(n.at).toLocaleString('en-GB')}  ${n.message}`); }
}
// A clean stop drains for up to 5s and saves for up to 2×5s (runtime.ts). The
// wait used to be 3s, so restart routinely found the old pid still alive,
// started nothing, and left a server that had already closed its ports. Past
// the budget the server is killed: its writes are atomic, so a kill can only
// drop a save, never tear a file.
const STOP_WAIT_MS = 20_000;
async function stop(quiet = false): Promise<void> {
  const pid = await runningPid(); if (!pid) { if (!quiet) console.log('TeamAI server is not running'); return; }
  // Wait on this pid, not on whatever server.json names: a supervisor may have
  // started a replacement meanwhile, and that one is not ours to kill.
  const alive = (): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
  process.kill(pid, 'SIGTERM');
  for (let waited = 0; waited < STOP_WAIT_MS && alive(); waited += 100) await new Promise((r) => setTimeout(r, 100));
  if (alive() && await runningPid() === pid) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* exited on its own just now */ }
    for (let waited = 0; waited < 2_000 && alive(); waited += 50) await new Promise((r) => setTimeout(r, 50));
    // A killed server leaves its server.json; clear it so ensureServer starts a new one.
    await releaseServerFile(paths().server, pid);
    console.log(`TeamAI server ${pid} did not stop within ${STOP_WAIT_MS / 1000}s; killed`); return;
  }
  if (!quiet) console.log(`Stopped TeamAI server ${pid}`);
}

// Start the relay on demand. This is what makes the launchers work whether or
// not a LaunchAgent (or any other supervisor) is managing the server: if
// nothing is listening, the client starts one itself.
async function ensureServer(): Promise<void> {
  if (await runningPid()) return;
  // Capture the child's output instead of discarding it: when startup fails,
  // its stderr is the only thing that says why (a port already taken, a bad
  // credential file), and "did not start" on its own sends the user hunting.
  const log = join(dataDir(), 'server-start.log');
  await mkdir(dirname(log), { recursive: true, mode: 0o700 });
  const handle = await open(log, 'w', 0o600);
  const cli = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [cli, 'server'], { detached: true, stdio: ['ignore', handle.fd, handle.fd], env: process.env });
  child.unref();
  await handle.close();
  for (let i = 0; i < 50; i++) { if (await runningPid()) return; await new Promise((r) => setTimeout(r, 100)); }
  let detail = '';
  try { detail = (await readFile(log, 'utf8')).trim(); } catch { /* nothing was written */ }
  throw new Error(detail ? `TeamAI server did not start: ${detail}` : `TeamAI server did not start (see ${log})`);
}

// A relay started before this provider had any account does not listen for it
// (runtime.ts skips empty pools); say so instead of a bare connection refused.
async function assertListening(proxy: TeamAIConfig['proxy'], id: ProviderId): Promise<void> {
  const port = providerPort(proxy, id);
  const open = await new Promise<boolean>((resolve) => { const socket = connect(port, proxy.host); socket.setTimeout(2_000); socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('timeout', () => { socket.destroy(); resolve(false); }); socket.once('error', () => resolve(false)); });
  if (!open) throw new Error(`The running relay is not serving ${id} on ${proxy.host}:${port} — it started before this account was added. Run "teamai restart".`);
}

async function runClient(id: ProviderId, clientArgs: string[]): Promise<void> {
  const config = await loadConfig(); if (!config.accounts.some((a) => a.provider === id && a.enabled)) throw new Error(`No enabled ${id} accounts`); await ensureServer(); await assertListening(config.proxy, id);
  if (id === 'claude') {
    const launch = launchCommand('claude', clientArgs); const result = spawnSync(launch.file, launch.args, { stdio: 'inherit', windowsVerbatimArguments: launch.windowsVerbatimArguments, env: { ...process.env, ANTHROPIC_BASE_URL: `http://${config.proxy.host}:${config.proxy.claudePort}`, ANTHROPIC_AUTH_TOKEN: config.proxy.clientToken } });
    if (result.error) throw result.error; process.exitCode = result.status ?? 1; return;
  }
  if (id === 'grok') { await runGrok(config.proxy, clientArgs); return; }
  const shadow = join(process.env.TEAMAI_HOME || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'teamai'), 'codex-home'); await mkdir(shadow, { recursive: true, mode: 0o700 });
  const originalHome = process.env.CODEX_HOME || join(homedir(), '.codex'); let original = ''; try { original = await readFile(join(originalHome, 'config.toml'), 'utf8'); } catch { /* optional */ }
  await writeFile(join(shadow, 'config.toml'), relayedCodexConfig(original, config.proxy.host, config.proxy.codexPort), { mode: 0o600 }); await chmod(shadow, 0o700);
  for (const name of ['skills', 'plugins', 'rules']) { const source = join(originalHome, name); const target = join(shadow, name); try { await lstat(target); } catch { try { await lstat(source); await symlink(source, target, 'dir'); } catch { /* optional */ } } }
  const overrides = [
    '-c', 'model_provider="teamai"',
    '-c', `model_providers.teamai.name="TeamAI Codex Relay"`,
    '-c', `model_providers.teamai.base_url="http://${config.proxy.host}:${config.proxy.codexPort}/v1"`,
    '-c', 'model_providers.teamai.env_key="TEAMAI_PROXY_TOKEN"',
    '-c', 'model_providers.teamai.wire_api="responses"',
    // Request-level failover (401/429/5xx) is the relay's job, so the client
    // must not retry the initial request and double up on account rotation.
    // Stream retries are different: a mid-body SSE cut from chatgpt.com is a
    // known transient that direct Codex hides with its default of 5 retries.
    // With 0 the first cut ended the turn as a hard "stream disconnected
    // before completion" error and the in-flight answer was lost (2026-09-19).
    '-c', 'model_providers.teamai.request_max_retries=0',
    '-c', 'model_providers.teamai.stream_max_retries=5',
    // Codex declares a stream dead after stream_idle_timeout_ms without an SSE
    // event (default 300s). A high-effort turn routinely thinks for longer than
    // that before its first token, so the default cut live turns mid-reasoning
    // and the client silently reconnected — which reads as a hung session, not
    // an error (2026-09-20, gpt-5.6-luna --effort max: a 15-minute turn cut and
    // retried, a second one lost after 10 minutes of silence). The relay
    // forwards upstream chunks unbuffered and injects no keepalives, so this
    // silence is upstream's and only the client's patience can cover it.
    '-c', 'model_providers.teamai.stream_idle_timeout_ms=1800000',
  ];
  const launch = launchCommand('codex', [...overrides, ...clientArgs]); const result = spawnSync(launch.file, launch.args, { stdio: 'inherit', windowsVerbatimArguments: launch.windowsVerbatimArguments, env: { ...process.env, CODEX_HOME: shadow, TEAMAI_PROXY_TOKEN: config.proxy.clientToken } });
  if (result.error) throw result.error; process.exitCode = result.status ?? 1;
}

// Grok in a home of its own, signed in with nothing but the relay's client
// token as an API key: every request then reaches the relay, which swaps in a
// pooled account. The user's ~/.grok settings, skills and plugins are reused;
// its sign-in is not, and an auth.json left in the shadow home is removed —
// a session token there would win over the key and bypass the relay.
async function runGrok(proxy: TeamAIConfig['proxy'], clientArgs: string[]): Promise<void> {
  const shadow = join(dataDir(), 'grok-home'); await mkdir(shadow, { recursive: true, mode: 0o700 }); await chmod(shadow, 0o700);
  await rm(join(shadow, 'auth.json'), { force: true });
  const originalHome = process.env.GROK_HOME || join(homedir(), '.grok');
  try { await writeFile(join(shadow, 'config.toml'), await readFile(join(originalHome, 'config.toml')), { mode: 0o600 }); } catch { /* optional */ }
  for (const name of ['skills', 'installed-plugins', 'hooks']) { const source = join(originalHome, name); const target = join(shadow, name); try { await lstat(target); } catch { try { await lstat(source); await symlink(source, target, 'dir'); } catch { /* optional */ } } }
  const base = `http://${proxy.host}:${providerPort(proxy, 'grok')}/v1`;
  const env: NodeJS.ProcessEnv = { ...process.env, GROK_HOME: shadow, XAI_API_KEY: proxy.clientToken, GROK_CLI_CHAT_PROXY_BASE_URL: base, GROK_XAI_API_BASE_URL: base };
  delete env.GROK_AUTH; delete env.GROK_AUTH_PATH;
  const launch = launchCommand('grok', clientArgs); const result = spawnSync(launch.file, launch.args, { stdio: 'inherit', windowsVerbatimArguments: launch.windowsVerbatimArguments, env });
  if (result.error) throw result.error; process.exitCode = result.status ?? 1;
}

function help(): void { console.log(`TeamAI — multi-account relay for Claude Code, Codex CLI and Grok CLI

Usage:
  tai                                  Open the TeamAI dashboard
  tac [CLAUDE_ARGS...]                 Start a relayed Claude Code session
  tax [CODEX_ARGS...]                  Start a relayed Codex session
  tag [GROK_ARGS...]                   Start a relayed Grok session
  teamai claude [CLAUDE_ARGS...]       Start a relayed Claude Code session
  teamai codex [CODEX_ARGS...]         Start a relayed Codex session
  teamai grok [GROK_ARGS...]           Start a relayed Grok session
  teamai session [CLIENT_ARGS...]      Choose Claude, Codex or Grok
  teamai login [claude|codex|grok]
  teamai import <claude|codex|grok> [--from PATH]
  teamai accounts [claude|codex|grok]
  teamai start|restart|status|stop
  teamai usage [--json] [--redact partial|full|none]
                                       Quota per account and window, live from
                                       the server (or state.json if it is down)
  teamai enable|disable <provider> <account>
  teamai priority <provider> <account> <rank|auto>
  teamai fable-only claude <account> on|off
  teamai capture [--redact partial|full|none] [--out DIR]
                                       Save the dashboard as .txt and .png,
                                       account addresses masked (no TTY needed)

Run "teamai start", then press 1 for Claude Code, 2 for Codex or 3 for Grok.`); }

main().catch((error) => { console.error(`teamai: ${(error as Error).message}`); process.exitCode = 1; });
