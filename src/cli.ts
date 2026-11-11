#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { prepareClaudeArgs, requestClaudeAdopt } from './claude-session-control.js';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { importAuth, loginClaude, loginCodex } from './auth.js';
import { captureDashboard } from './capture.js';
import { describeApply, reloadServerConfig } from './config-apply.js';
import { stripAnsi } from './columns.js';
import { linkShadowEntries, relayedCodexConfig } from './codex-config.js';
import { claudeGroupArgs, groupStatusLines } from './groups.js';
import { hostText, measureHost } from './host-metrics.js';
import { isRedactLevel } from './redact.js';
import { resetCreditSettings } from './reset-credits.js';
import { addRoute, describeReload, removeRoute } from './route-config.js';
import { parseRoutes } from './routes.js';
import { ensureServer, runServer, runningPid } from './runtime.js';
import { loadConfig, loadSessions, loadState, updateConfig, upsertAccount } from './storage.js';
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
    case 'login': { const id = await loginProvider(); const result = id === 'claude' ? await loginClaude({ manual: args.includes('--manual') }) : await loginCodex({ deviceAuth: args.includes('--device-auth') }); const account = await upsertAccount(id, result.label, result.credential); console.log(`Added ${id} account: ${account.label}`); await reportReload(); break; }
    case 'import': { const id = provider(args[0]); const results = await importAuth(id, flag('--from')); for (const result of results) { const account = await upsertAccount(id, result.label, result.credential); console.log(`Imported ${id} account: ${account.label}`); } await reportReload(); break; }
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
    case 'route': case 'routes': await route(); break;
    case 'adopt': await adopt(); break;
    case 'capture': {
      const level = flag('--redact') ?? 'partial'; if (!isRedactLevel(level)) throw new Error('--redact must be partial, full or none');
      const result = await captureDashboard({ level, outDir: flag('--out'), width: process.stdout.columns });
      console.log(result.text); console.log(result.png); break;
    }
    case 'help': case '--help': case '-h': help(); break;
    default: throw new Error(`Unknown command: ${command}`);
  }
}

// `--manual` is Claude's paste-only login and `--device-auth` Codex's device
// code; either one names the provider when none is given.
async function loginProvider(): Promise<ProviderId> {
  const unknown = args.find((arg) => arg.startsWith('-') && arg !== '--manual' && arg !== '--device-auth'); if (unknown) throw new Error(`Unknown login option ${unknown}`);
  const named = args.find((arg) => !arg.startsWith('-'));
  const id = named ? provider(named) : args.includes('--manual') ? 'claude' : args.includes('--device-auth') ? 'codex' : await selectProvider('Login provider');
  if (id === 'codex' && args.includes('--manual')) throw new Error('--manual is for Claude; use --device-auth for Codex');
  if (id === 'claude' && args.includes('--device-auth')) throw new Error('--device-auth is for Codex; use --manual for Claude');
  return id;
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
async function toggle(enabled: boolean): Promise<void> { const id = provider(args[0]); const name = args.slice(1).join(' '); let label = ''; await updateConfig((config) => { const account = config.accounts.find((a) => a.provider === id && (a.id === name || a.label === name)); if (!account) throw new Error('Account not found'); account.enabled = enabled; label = account.label; }); console.log(`${enabled ? 'Enabled' : 'Disabled'} ${label}`); await reportReload(); }
async function priority(): Promise<void> { const id = provider(args[0]); const rankRaw = args.at(-1); const name = args.slice(1, -1).join(' '); if (!rankRaw || (rankRaw !== 'auto' && (!Number.isInteger(Number(rankRaw)) || Number(rankRaw) < 1))) throw new Error('Priority must be a positive integer or auto'); const rank = rankRaw === 'auto' ? null : Number(rankRaw); let label = ''; await updateConfig((config) => { const account = config.accounts.find((a) => a.provider === id && (a.id === name || a.label === name)); if (!account) throw new Error('Account not found'); account.priority = rank; label = account.label; }); console.log(`Priority ${rank ?? 'auto'}: ${label}`); await reportReload(); }
// After an account write: a running server applies it in place; a stopped one
// reads it when it starts. A refusal or an unreachable server is an error exit.
async function reportReload(): Promise<void> { const outcome = await reloadServerConfig(); console.log(`Server: ${describeApply(outcome)}`); if (outcome.status === 'refused' || outcome.status === 'failed') process.exitCode = 1; }

async function status(): Promise<void> {
  const pid = await runningPid();
  console.log(pid ? `TeamAI server running (pid ${pid})` : 'TeamAI server is stopped');
  const host = await measureHost(); console.log(`Host: ${stripAnsi(hostText(host, true))} (${host.cpu.cores} cores)`);
  await accounts(); await resetCreditStatus(); await routeStatus();
  const config = await loadConfig(); const state = await loadState();
  for (const line of groupStatusLines(config, state)) console.log(line);
  for (const binding of Object.values(await loadSessions())) if (binding.group) console.log(`Session ${binding.sessionId} group ${binding.group}`);
}

// Configured model routes, as the server will apply them.
async function routeStatus(): Promise<void> {
  const config = await loadConfig();
  for (const id of ['claude', 'codex'] as const) {
    const routes = parseRoutes(config.routes?.[id], id); if (!routes.length) continue;
    console.log(`Routes (${id}):`);
    for (const route of routes) console.log(`  ${route.name} [${route.mode}]: ${route.match.join(', ')} → ${route.accounts.join(', ')}`);
  }
}

// `teamai route list|add|rm`. Saved through the same validation and reload as
// the dashboard's route editor.
async function route(): Promise<void> {
  const [action = 'list', name] = args; const only = flag('--provider'); const id = only === undefined ? undefined : provider(only);
  const list = (value: string | undefined): string[] => (value ?? '').split(',').map((part) => part.trim()).filter(Boolean);
  if (action === 'list' || action === 'ls') {
    const config = await loadConfig(); let any = false;
    for (const each of id ? [id] : (['claude', 'codex'] as const)) {
      const routes = parseRoutes(config.routes?.[each], each); if (!routes.length) continue; any = true;
      console.log(`Routes (${each}) — first match wins:`);
      routes.forEach((r, i) => console.log(`  ${i + 1}. ${r.name} [${r.mode}${r.color ? `, ${r.color}` : ''}]: ${r.match.join(', ')} → ${r.accounts.join(', ')}`));
    }
    if (!any) console.log('No routes configured');
    return;
  }
  if (!name || name.startsWith('--')) throw new Error(`Usage: teamai route ${action === 'rm' || action === 'remove' ? 'rm <name> [--provider claude|codex]' : 'add <name> [--provider claude|codex] --match a,b --accounts x,y [--mode prefer|exclusive] [--color c]'}`);
  if (action === 'add') {
    const target = id ?? 'claude';
    const result = await addRoute(target, { name, match: list(flag('--match')), accounts: list(flag('--accounts')), mode: flag('--mode'), color: flag('--color') });
    for (const ref of result.unknown) console.log(`warning: account ${ref} not found among ${target} accounts — the server will skip it`);
    console.log(`${result.replaced ? 'Updated' : 'Added'} ${target} route ${name}: ${describeReload(result.outcome)}`);
    if (result.outcome.status === 'failed') process.exitCode = 1;
    return;
  }
  if (action === 'rm' || action === 'remove') {
    const result = await removeRoute(name, id);
    console.log(`Removed ${result.provider} route ${name}: ${describeReload(result.outcome)}`);
    if (result.outcome.status === 'failed') process.exitCode = 1;
    return;
  }
  throw new Error(`Unknown route action: ${action} (list, add or rm)`);
}

// `teamai adopt claude <session-id> --account <account>`: a conversation that
// was running before this relay issued IDs (it started under an older relay)
// is recorded as first bound to the named account, on the running relay, which
// looks the account up in its own pool. Only Claude conversations are pinned.
async function adopt(): Promise<void> {
  const usage = 'Usage: teamai adopt claude <session-id> --account <account>';
  const id = args[0]; if (id !== 'claude') throw new Error(id === 'codex' ? 'Only Claude sessions are pinned to an account; Codex needs no adoption' : usage);
  const account = flag('--account'); const positional = args.slice(1).filter((arg, i, all) => arg !== '--account' && all[i - 1] !== '--account');
  if (positional.length !== 1 || !account || account.startsWith('--')) throw new Error(usage);
  if (!(await runningPid())) throw new Error('TeamAI server is not running; start the relay first (teamai server or teamai start), then adopt');
  const { status, body } = await requestClaudeAdopt(await loadConfig(), positional[0]!, account);
  if (status === 201) { console.log(`Adopted Claude session ${body.sessionId}: first account ${body.account}`); return; }
  if (status === 200) { console.log(`Claude session ${body.sessionId} is already bound to ${body.account}`); return; }
  throw new Error(`${body.error || 'adoption refused'} (control ${status})`);
}

// Reset credits per account, from what the server last recorded.
async function resetCreditStatus(): Promise<void> {
  const config = await loadConfig(); const state = await loadState(); const settings = resetCreditSettings(config);
  const providers: ProviderId[] = ['codex', 'claude'];
  for (const prov of providers) {
    const list = config.accounts.filter((a) => a.provider === prov);
    if (!list.length) continue;
    const autoOn = prov === 'codex' ? settings.enabled : settings.claudeEnabled;
    const prefix = prov === 'codex' ? 'Reset credits' : 'Claude reset credits';
    console.log(`${prefix}: auto-redeem ${autoOn ? `on (policy ${settings.policy}, cooldown ${Math.round(settings.cooldownMs / 60_000)}m, reserve ${settings.reserve}${settings.sessionWindow ? ', 5h window too' : ''})` : 'off'}`);
    for (const account of list) {
      const saved = state.accounts[account.credentialId];
      const count = typeof saved?.resetCredits === 'number' ? saved.resetCredits : null;
      const used = saved?.resetCreditsConsumed ? `, ${saved.resetCreditsConsumed} redeemed` : '';
      const last = saved?.resetCreditLastOutcome ? ` (last: ${saved.resetCreditLastOutcome})` : '';
      console.log(`  ${account.label}: ${count === null ? (autoOn ? 'unknown (no usage read has reported a count yet)' : 'unknown') : `${count} available${used}${last}`}`);
    }
  }
}
async function stop(quiet = false): Promise<void> { const pid = await runningPid(); if (!pid) { if (!quiet) console.log('TeamAI server is not running'); return; } process.kill(pid, 'SIGTERM'); for (let i = 0; i < 30 && await runningPid(); i++) await new Promise((r) => setTimeout(r, 100)); if (!quiet) console.log(`Stopped TeamAI server ${pid}`); }

async function runClient(id: ProviderId, clientArgs: string[]): Promise<void> {
  const config = await loadConfig();
  const selection = id === 'claude' ? claudeGroupArgs(clientArgs, config) : undefined;
  if (id !== 'claude' && (process.env.TEAMAI_GROUP || clientArgs.some((arg) => arg === '--group' || arg.startsWith('--group=')))) throw new Error('--group and TEAMAI_GROUP are supported only for Claude');
  if (!config.accounts.some((a) => a.provider === id && a.enabled)) throw new Error(`No enabled ${id} accounts`); await ensureServer();
  if (id === 'claude') {
    const argsToPass = await prepareClaudeArgs(clientArgs, config);
    const result = spawnSync('claude', argsToPass, { stdio: 'inherit', env: { ...process.env, ANTHROPIC_BASE_URL: `http://${config.proxy.host}:${config.proxy.claudePort}`, ANTHROPIC_AUTH_TOKEN: config.proxy.clientToken, ...(selection?.group ? { ANTHROPIC_CUSTOM_HEADERS: [process.env.ANTHROPIC_CUSTOM_HEADERS, `x-teamai-group: ${selection.group}`].filter(Boolean).join('\n') } : {}) } });
    if (result.error) throw result.error; process.exitCode = result.status ?? 1; return;
  }
  const shadow = join(process.env.TEAMAI_HOME || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'teamai'), 'codex-home'); await mkdir(shadow, { recursive: true, mode: 0o700 });
  const originalHome = process.env.CODEX_HOME || join(homedir(), '.codex'); let original = ''; try { original = await readFile(join(originalHome, 'config.toml'), 'utf8'); } catch { /* optional */ }
  // The relayed config is rewritten on every launch; the previous one is read
  // first so hook trust granted inside a relayed session is not lost.
  let previousShadow = ''; try { previousShadow = await readFile(join(shadow, 'config.toml'), 'utf8'); } catch { /* first launch */ }
  await writeFile(join(shadow, 'config.toml'), relayedCodexConfig(original, config.proxy.host, config.proxy.codexPort, { originalHome, shadowHome: shadow, previousShadow }), { mode: 0o600 }); await chmod(shadow, 0o700);
  await linkShadowEntries(originalHome, shadow);
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
  const result = spawnSync('codex', [...overrides, ...clientArgs], { stdio: 'inherit', env: { ...process.env, CODEX_HOME: shadow, TEAMAI_PROXY_TOKEN: config.proxy.clientToken } });
  if (result.error) throw result.error; process.exitCode = result.status ?? 1;
}

function help(): void { console.log(`TeamAI — multi-account relay for Claude Code and Codex CLI

Usage:
  tai                                  Open the TeamAI dashboard
  tac [CLAUDE_ARGS...]                 Start a relayed Claude Code session
  tax [CODEX_ARGS...]                  Start a relayed Codex session
  teamai claude [--group NAME] [CLAUDE_ARGS...]  Start a relayed Claude Code session
                                       TEAMAI_GROUP supplies the default group
  teamai codex [CODEX_ARGS...]         Start a relayed Codex session
  teamai session [CLIENT_ARGS...]      Choose Claude or Codex interactively
  teamai login [claude|codex]          Claude: the browser callback, or paste the
                                       redirect URL or code it ends on
  teamai login claude --manual         Paste-only Claude login (no callback server)
  teamai login codex --device-auth     Codex device-code login (codex login --device-auth)
  teamai import <claude|codex> [--from PATH]
  teamai accounts [claude|codex]
  teamai start|restart|status|stop
  teamai enable|disable <provider> <account>
  teamai priority <provider> <account> <rank|auto>
                                       Saved and applied to a running server
                                       without a restart (login and import too)
  teamai route list [--provider claude|codex]
  teamai route add <name> [--provider claude|codex] --match a,b --accounts x,y
                   [--mode prefer|exclusive] [--color red|green|yellow|blue|magenta|cyan]
  teamai route rm <name> [--provider claude|codex]
                                       Model routes; saved and applied to a
                                       running server without a restart
  teamai adopt claude <session-id> --account <account>
                                       Record a Claude session that started
                                       under an older relay as first bound to
                                       <account> (on the running relay)
  teamai capture [--redact partial|full|none] [--out DIR]
                                       Save the dashboard as .txt and .png,
                                       account addresses masked (no TTY needed)

Run "teamai start", then press 1 for Claude Code or 2 for Codex.`); }

main().catch((error) => { console.error(`teamai: ${(error as Error).message}`); process.exitCode = 1; });
