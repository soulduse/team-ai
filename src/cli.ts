#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, open, readFile, writeFile, lstat, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { importAuth, loginClaude, loginCodex } from './auth.js';
import { runServer, runningPid } from './runtime.js';
import { dataDir, loadConfig, loadState, saveConfig, upsertAccount } from './storage.js';
import { runTui } from './tui.js';
import type { ProviderId } from './types.js';

const invokedAs = basename(process.argv[1] || 'teamai');
const inputArgs = process.argv.slice(2);
const invocation = invokedAs === 'tai' ? ['start', ...inputArgs] : invokedAs === 'tac' ? ['run', 'claude', ...inputArgs] : invokedAs === 'tax' ? ['run', 'codex', ...inputArgs] : inputArgs;
const [command = 'help', ...args] = invocation;

function provider(value?: string): ProviderId { if (value !== 'claude' && value !== 'codex') throw new Error('Provider must be claude or codex'); return value; }
function flag(name: string): string | undefined { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; }

async function main(): Promise<void> {
  switch (command) {
    case 'login': { const id = args[0] ? provider(args[0]) : await selectProvider('Login provider'); const result = id === 'claude' ? await loginClaude() : await loginCodex(); const account = await upsertAccount(id, result.label, result.credential); console.log(`Added ${id} account: ${account.label}`); break; }
    case 'import': { const id = provider(args[0]); const results = await importAuth(id, flag('--from')); for (const result of results) { const account = await upsertAccount(id, result.label, result.credential); console.log(`Imported ${id} account: ${account.label}`); } break; }
    case 'accounts': await accounts(args[0] ? provider(args[0]) : undefined); break;
    case 'enable': await toggle(true); break;
    case 'disable': await toggle(false); break;
    case 'priority': await priority(); break;
    case 'server': await runServer(); break;
    case 'start': await ensureServer(); await runTui(); break;
    case 'status': await status(); break;
    case 'stop': await stop(); break;
    case 'restart': await stop(true); await ensureServer(); await runTui(); break;
    case 'session': await runClient(await selectProvider('Select session'), args.filter((x) => x !== '--')); break;
    case 'claude': await runClient('claude', args.filter((x) => x !== '--')); break;
    case 'codex': await runClient('codex', args.filter((x) => x !== '--')); break;
    case 'run': await runClient(provider(args[0]), args.slice(args[0] ? 1 : 0).filter((x) => x !== '--')); break;
    case 'tui': await runTui(); break;
    case 'help': case '--help': case '-h': help(); break;
    default: throw new Error(`Unknown command: ${command}`);
  }
}

async function selectProvider(promptLabel: string): Promise<ProviderId> {
  if (!process.stdin.isTTY) throw new Error('Specify claude or codex explicitly in a non-interactive shell');
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await prompt.question(`${promptLabel} — [1] Claude, [2] Codex: `)).trim().toLowerCase();
    if (answer === '1' || answer === 'c' || answer === 'claude') return 'claude';
    if (answer === '2' || answer === 'x' || answer === 'codex') return 'codex';
    throw new Error('Choose 1 for Claude or 2 for Codex');
  } finally { prompt.close(); }
}

async function accounts(filter?: ProviderId): Promise<void> {
  const config = await loadConfig(); const state = await loadState();
  for (const a of config.accounts.filter((x) => !filter || x.provider === filter)) { const s = state.accounts[a.credentialId]; const usage = s?.usage == null ? 'unknown' : `${Math.round(s.usage * 100)}%`; console.log(`${a.provider.padEnd(7)} ${a.enabled ? 'on ' : 'off'} ${usage.padStart(7)} ${a.priority === null ? 'auto' : `#${a.priority}`} ${a.label}`); }
}
async function toggle(enabled: boolean): Promise<void> { const id = provider(args[0]); const name = args.slice(1).join(' '); const config = await loadConfig(); const account = config.accounts.find((a) => a.provider === id && (a.id === name || a.label === name)); if (!account) throw new Error('Account not found'); account.enabled = enabled; await saveConfig(config); console.log(`${enabled ? 'Enabled' : 'Disabled'} ${account.label}`); }
async function priority(): Promise<void> { const id = provider(args[0]); const rankRaw = args.at(-1); const name = args.slice(1, -1).join(' '); const config = await loadConfig(); const account = config.accounts.find((a) => a.provider === id && (a.id === name || a.label === name)); if (!account) throw new Error('Account not found'); if (!rankRaw || (rankRaw !== 'auto' && (!Number.isInteger(Number(rankRaw)) || Number(rankRaw) < 1))) throw new Error('Priority must be a positive integer or auto'); account.priority = rankRaw === 'auto' ? null : Number(rankRaw); await saveConfig(config); console.log(`Priority ${account.priority ?? 'auto'}: ${account.label}`); }

async function status(): Promise<void> { const pid = await runningPid(); console.log(pid ? `TeamAI server running (pid ${pid})` : 'TeamAI server is stopped'); await accounts(); }
async function stop(quiet = false): Promise<void> { const pid = await runningPid(); if (!pid) { if (!quiet) console.log('TeamAI server is not running'); return; } process.kill(pid, 'SIGTERM'); for (let i = 0; i < 30 && await runningPid(); i++) await new Promise((r) => setTimeout(r, 100)); if (!quiet) console.log(`Stopped TeamAI server ${pid}`); }

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

async function runClient(id: ProviderId, clientArgs: string[]): Promise<void> {
  const config = await loadConfig(); if (!config.accounts.some((a) => a.provider === id && a.enabled)) throw new Error(`No enabled ${id} accounts`); await ensureServer();
  if (id === 'claude') {
    const result = spawnSync('claude', clientArgs, { stdio: 'inherit', env: { ...process.env, ANTHROPIC_BASE_URL: `http://${config.proxy.host}:${config.proxy.claudePort}`, ANTHROPIC_AUTH_TOKEN: config.proxy.clientToken } });
    if (result.error) throw result.error; process.exitCode = result.status ?? 1; return;
  }
  const shadow = join(process.env.TEAMAI_HOME || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'teamai'), 'codex-home'); await mkdir(shadow, { recursive: true, mode: 0o700 });
  const originalHome = process.env.CODEX_HOME || join(homedir(), '.codex'); let original = ''; try { original = await readFile(join(originalHome, 'config.toml'), 'utf8'); } catch { /* optional */ }
  await writeFile(join(shadow, 'config.toml'), original, { mode: 0o600 }); await chmod(shadow, 0o700);
  for (const name of ['skills', 'plugins', 'rules']) { const source = join(originalHome, name); const target = join(shadow, name); try { await lstat(target); } catch { try { await lstat(source); await symlink(source, target, 'dir'); } catch { /* optional */ } } }
  const overrides = [
    '-c', 'model_provider="teamai"',
    '-c', `model_providers.teamai.name="TeamAI Codex Relay"`,
    '-c', `model_providers.teamai.base_url="http://${config.proxy.host}:${config.proxy.codexPort}/v1"`,
    '-c', 'model_providers.teamai.env_key="TEAMAI_PROXY_TOKEN"',
    '-c', 'model_providers.teamai.wire_api="responses"',
    '-c', 'model_providers.teamai.request_max_retries=0',
    '-c', 'model_providers.teamai.stream_max_retries=0',
  ];
  const result = spawnSync('codex', [...overrides, ...clientArgs], { stdio: 'inherit', env: { ...process.env, CODEX_HOME: shadow, TEAMAI_PROXY_TOKEN: config.proxy.clientToken } });
  if (result.error) throw result.error; process.exitCode = result.status ?? 1;
}

function help(): void { console.log(`TeamAI — multi-account relay for Claude Code and Codex CLI

Usage:
  tai                                  Open the TeamAI dashboard
  tac [CLAUDE_ARGS...]                 Start a relayed Claude Code session
  tax [CODEX_ARGS...]                  Start a relayed Codex session
  teamai claude [CLAUDE_ARGS...]       Start a relayed Claude Code session
  teamai codex [CODEX_ARGS...]         Start a relayed Codex session
  teamai session [CLIENT_ARGS...]      Choose Claude or Codex interactively
  teamai login [claude|codex]
  teamai import <claude|codex> [--from PATH]
  teamai accounts [claude|codex]
  teamai start|restart|status|stop
  teamai enable|disable <provider> <account>
  teamai priority <provider> <account> <rank|auto>

Run "teamai start", then press 1 for Claude Code or 2 for Codex.`); }

main().catch((error) => { console.error(`teamai: ${(error as Error).message}`); process.exitCode = 1; });
