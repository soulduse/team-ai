import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loginClaude, loginCodex } from './auth.js';
import { runningPid } from './runtime.js';
import { loadConfig, loadState, removeAccount, saveConfig, upsertAccount } from './storage.js';
import type { StoredAccount, SubscriptionProfile } from './types.js';

const ESC = '\x1b['; const RESET = `${ESC}0m`; const ANSI = new RegExp(`${ESC.replace('[', '\\[')}[0-9;]*m`, 'g');
const color = (code: number, text: string): string => `${ESC}${code}m${text}${RESET}`;
const visible = (text: string): number => text.replace(ANSI, '').length;
const fit = (text: string, width: number): string => { const plain = text.replace(ANSI, ''); if (plain.length > width) return `${plain.slice(0, Math.max(0, width - 1))}…`; return text + ' '.repeat(Math.max(0, width - visible(text))); };

function duration(reset: number | null | undefined): string {
  if (!reset || reset <= Date.now()) return '';
  const mins = Math.ceil((reset - Date.now()) / 60_000); if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60); if (hours < 24) return `${hours}h${mins % 60 ? `${mins % 60}m` : ''}`;
  return `${Math.floor(hours / 24)}d${hours % 24 ? `${hours % 24}h` : ''}`;
}

function bar(usage: number | null | undefined, reset: number | null | undefined, width: number): string {
  const remaining = duration(reset); const ratio = usage == null ? null : Math.max(0, Math.min(1, usage));
  const label = ratio == null ? (remaining || '-') : `${Math.round(ratio * 100)}%${remaining && `${Math.round(ratio * 100)}% ${remaining}`.length <= width ? ` ${remaining}` : ''}`;
  const text = label.slice(0, width).padStart(Math.floor((width + label.length) / 2)).padEnd(width);
  if (ratio == null) return `${ESC}100;37m${text}${RESET}`;
  const filled = Math.round(ratio * width); const bg = ratio >= 0.9 ? 41 : ratio >= 0.7 ? 43 : 42;
  return `${ESC}${bg};97m${text.slice(0, filled)}${ESC}100;37m${text.slice(filled)}${RESET}`;
}

function healthy(profile: SubscriptionProfile | null | undefined): boolean { return !profile?.status || ['active', 'trialing'].includes(profile.status); }
// ChatGPT plan ids are lowercase slugs ('pro', 'prolite', 'plus', 'team'); show
// them the way the product names them so a Codex row reads like a Claude one.
function codexPlan(profile: SubscriptionProfile | null | undefined): string {
  const raw = profile?.rateLimitTier;
  // Before the first profile refresh there is nothing to show yet; say so
  // rather than printing a brand name that looks like a plan.
  if (!raw) return '—';
  const names: Record<string, string> = { pro: 'Pro', prolite: 'Pro Lite', plus: 'Plus', team: 'Team', business: 'Business', enterprise: 'Enterprise', free: 'Free' };
  // ChatGPT exposes no Max-style multiplier anywhere: not in the token claims,
  // not in a header that arrives on every response, and not derivable from the
  // quota windows either — Pro and Pro Lite both report a 10080-minute window
  // and a percentage, never the absolute allowance the percentage is of. The
  // plan name is the whole of what can be known.
  return names[raw.toLowerCase()] || raw;
}
function tier(profile: SubscriptionProfile | null | undefined): string {
  if (!profile) return 'OAuth'; const match = /(\d+x)$/i.exec(profile.rateLimitTier || '');
  if (match) return `Max ${match[1]}`; if (profile.hasClaudeMax || profile.orgType === 'claude_max') return 'Max'; if (profile.hasClaudePro || profile.orgType === 'claude_pro') return 'Pro'; return 'OAuth';
}
function renewal(profile: SubscriptionProfile | null | undefined): string {
  if (!profile?.createdAt || !healthy(profile)) return '—'; const created = new Date(profile.createdAt); if (!Number.isFinite(created.getTime())) return '—';
  const now = new Date(); const day = created.getDate(); const build = (year: number, month: number): Date => new Date(year, month, Math.min(day, new Date(year, month + 1, 0).getDate())); let target = build(now.getFullYear(), now.getMonth()); if (target < new Date(now.getFullYear(), now.getMonth(), now.getDate())) target = build(now.getFullYear(), now.getMonth() + 1);
  const left = Math.round((target.getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86_400_000); return left <= 0 ? 'D-DAY' : `D-${left}`;
}

// A quota window upstream is actually enforcing. ChatGPT sends both `primary`
// and `secondary` on every response, but an account may have only one in play:
// the unused one arrives with a zero-length window, no reset and 0% — which
// would otherwise render as a full, untouched bar and read as spare capacity.
function activeWindow(window: { usage: number | null; resetsAt: number | null; minutes?: number | null } | undefined): boolean {
  if (!window) return false;
  return Boolean(window.minutes) || window.resetsAt !== null || (window.usage ?? 0) > 0;
}

// A quota window's own length, named the way a person would say it ("5h", "7d").
// Codex reports the span in its headers; Claude's window names already carry it.
function windowLabel(minutes: number | null | undefined, fallback: string): string {
  if (!minutes) return fallback;
  if (minutes % 10080 === 0) return `${minutes / 10080}w`;
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

export async function runTui(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('TUI requires a terminal');
  let selectedId: string | null = null; let mode: 'normal' | 'order' | 'delete' | 'add' = 'normal'; let message = ''; let busy = false; let closed = false;
  // Least-spent first by default: the dashboard is mostly read to answer "which
  // account has room left", and that ordering answers it at a glance. 'c' puts
  // it back in configured order for anyone reading it as a roster.
  let sortByHeadroom = true;
  const rows = async (): Promise<StoredAccount[]> => (await loadConfig()).accounts;
  const selected = (accounts: StoredAccount[]): StoredAccount | null => accounts.find((account) => account.credentialId === selectedId) || accounts[0] || null;

  const render = async (): Promise<void> => {
    const config = await loadConfig(); const state = await loadState(); const accounts = config.accounts; const current = selected(accounts); if (current && !selectedId) selectedId = current.credentialId;
    const width = Math.max(80, process.stdout.columns || 120); const height = Math.max(24, process.stdout.rows || 40); const barWidth = width >= 120 ? 18 : 12; const lines: string[] = [];
    const claudeCount = accounts.filter((account) => account.provider === 'claude').length; const codexCount = accounts.filter((account) => account.provider === 'codex').length;
    const headerLeft = color(1, ' TeamAI'); const headerRight = `${color(32, '● running')}  Claude ${claudeCount}  Codex ${codexCount}  ${config.proxy.host}:${config.proxy.claudePort}/${config.proxy.codexPort} `;
    lines.push(`${headerLeft}${' '.repeat(Math.max(1, width - visible(headerLeft) - visible(headerRight)))}${headerRight}`); lines.push('━'.repeat(width));
    for (const provider of ['claude', 'codex'] as const) {
      const group = accounts.filter((account) => account.provider === provider); if (!group.length) continue;
      if (sortByHeadroom) {
        // Mirrors AccountPool.byHeadroom so the top row is the account the pool
        // would actually pick next: the Fable window when upstream reports one,
        // the routing window otherwise, unmeasured last.
        const spent = (account: StoredAccount): { primary: number | null; overall: number } => {
          const saved = state.accounts[account.credentialId];
          const fable = Object.entries(saved?.windows || {}).find(([name]) => /^7d_[a-z0-9]+$/i.test(name))?.[1];
          return { primary: fable?.usage ?? saved?.usage ?? null, overall: saved?.usage ?? 1 };
        };
        group.sort((a, b) => {
          if (a.priority !== null || b.priority !== null) return (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER);
          const sa = spent(a); const sb = spent(b);
          if (sa.primary === null || sb.primary === null) return (sa.primary === null ? 1 : 0) - (sb.primary === null ? 1 : 0);
          if (sa.primary !== sb.primary) return sa.primary - sb.primary;
          return sa.overall - sb.overall;
        });
      }
      const sectionTitle = ` ${provider === 'claude' ? 'Claude' : 'Codex'} accounts (${group.length}) `;
      lines.push(color(36, `┌─${sectionTitle}${'─'.repeat(Math.max(0, width - sectionTitle.length - 3))}┐`));
      // Column titles: the rows are dense and every field below is an
      // abbreviation, so name them once per section rather than expecting the
      // reader to infer what "auto" or a bare percentage refers to.
      const slot = (title: string): string => ` ${fit(title, barWidth)}`;
      // Codex titles follow whatever windows are actually in play for this
      // section, so the header never advertises a gauge that no row renders.
      const codexWindowCount = Math.max(...group.map((account) => {
        const saved = state.accounts[account.credentialId];
        return [saved?.windows?.primary || saved?.windows?.requests, saved?.windows?.secondary].filter(activeWindow).length;
      }), 0);
      // Codex window lengths vary by account, so the title carries the span the
      // rows no longer repeat; fall back to a neutral name when they disagree.
      const codexSpans = group.map((account) => {
        const saved = state.accounts[account.credentialId];
        return [saved?.windows?.primary || saved?.windows?.requests, saved?.windows?.secondary].filter(activeWindow).map((window) => windowLabel(window!.minutes, ''));
      });
      const spanAt = (index: number): string => {
        const seen = new Set(codexSpans.map((spans) => spans[index]).filter(Boolean));
        return seen.size === 1 ? `${[...seen][0]} limit` : index === 0 ? 'usage limit' : 'second limit';
      };
      const usageTitles = provider === 'claude'
        ? `${slot('5h session')}${slot('7d overall')}${slot('7d Fable')}`
        : Array.from({ length: codexWindowCount }, (_, index) => slot(spanAt(index))).join('');
      lines.push(color(90, fit(`  ${fit('account', 24)} ${fit('plan', 10)} ${fit('state', 10)} ${'order'.padEnd(4)}${usageTitles}`, width)));
      for (const account of group) {
        const saved = state.accounts[account.credentialId]; const profile = saved?.profile; const cursor = account.credentialId === selectedId ? color(36, '>') : ' '; const enabled = account.enabled ? (saved?.error ? color(31, 'error') : saved?.cooldownUntil && saved.cooldownUntil > Date.now() ? color(33, 'cooldown') : color(32, 'active')) : color(90, 'disabled'); const rank = account.priority == null ? 'auto' : `#${account.priority}`;
        const plan = provider === 'claude' && profile && !healthy(profile) ? color(31, profile.status || 'inactive') : provider === 'claude' ? tier(profile) : codexPlan(profile);
        const head = `${cursor} ${fit(account.label, 24)} ${fit(plan, 10)} ${fit(enabled, 10)} ${rank.padEnd(4)}`;
        if (provider === 'claude') {
          const session = saved?.windows?.['5h']; const weekly = saved?.windows?.['7d']; const fable = saved?.windows?.['7d_oi'] || Object.entries(saved?.windows || {}).find(([name]) => name.startsWith('7d_'))?.[1]; const renew = renewal(profile); const renewColored = renew === 'D-DAY' || /^D-[0-3]$/.test(renew) ? color(31, renew) : /^D-[4-7]$/.test(renew) ? color(33, renew) : color(32, renew);
          lines.push(`${head} ${bar(session?.usage, session?.resetsAt, barWidth)} ${bar(weekly?.usage, weekly?.resetsAt, barWidth)} ${bar(fable?.usage, fable?.resetsAt, barWidth)} ~${renewColored}`);
        } else {
          const shown = [saved?.windows?.primary || saved?.windows?.requests, saved?.windows?.secondary].filter(activeWindow);
          const gauges = shown.map((window) => bar(window!.usage, window!.resetsAt, barWidth)).join(' ');
          lines.push(`${head} ${gauges || color(90, 'no quota data yet')}`);
        }
      }
      lines.push(color(36, `└${'─'.repeat(Math.max(0, width - 2))}┘`));
    }
    const activityRows = Math.max(4, height - lines.length - 5); lines.push(''); lines.push(` Activity ${'─'.repeat(Math.max(0, width - 10))}`);
    for (const event of [...(state.events || [])].reverse().slice(0, activityRows)) lines.push(`${color(90, new Date(event.at).toLocaleTimeString('en-GB'))} ${event.message}`);
    while (lines.length < height - 2) lines.push(''); lines.push('─'.repeat(width));
    const footer = mode === 'normal' ? ` 1 Claude   2 Codex   ↑↓ select   s switch   e enable   o order   d delete   a add   R Reload   c ${sortByHeadroom ? 'quota' : 'config'}-sort   q quit` : mode === 'order' ? ' ORDER: ↑↓ rank   a/c auto   Enter/Esc done' : mode === 'delete' ? ' DELETE selected account? y/Enter confirm   Esc cancel' : ' ADD: 1 Claude login   2 Codex login   Esc cancel';
    lines.push(fit(`${footer}${message ? `   ${message}` : ''}`, width)); process.stdout.write(`${ESC}H${lines.slice(0, height).map((line) => fit(line, width)).join('\n')}`);
  };

  const move = async (delta: number): Promise<void> => { const accounts = await rows(); const index = Math.max(0, accounts.findIndex((a) => a.credentialId === selectedId)); selectedId = accounts[Math.min(accounts.length - 1, Math.max(0, index + delta))]?.credentialId || null; };
  const mutate = async (fn: (account: StoredAccount, accounts: StoredAccount[]) => void): Promise<void> => { const config = await loadConfig(); const account = selected(config.accounts); if (!account) return; fn(account, config.accounts); await saveConfig(config); await restartDaemon(); };
  // Fleet-wide quota re-measure. The server owns the pools (and the committed
  // probe template), so this asks it over the local control channel rather than
  // restarting it — a restart only re-read profiles and left every bar blank.
  const remeasure = async (): Promise<void> => {
    busy = true; message = 'Re-measuring quota...'; await render();
    try {
      const config = await loadConfig();
      const port = config.proxy.controlPort ?? config.proxy.claudePort + 100;
      const response = await fetch(`http://${config.proxy.host}:${port}/probe`, { headers: { authorization: `Bearer ${config.proxy.clientToken}` }, signal: AbortSignal.timeout(90_000) });
      if (!response.ok) throw new Error(`control ${response.status}`);
      const result = await response.json() as { targets: number; measured: number; ready: boolean; added: number; removed: number };
      const fleet = [result.added ? `+${result.added}` : '', result.removed ? `-${result.removed}` : ''].filter(Boolean).join(' ');
      message = !result.ready
        ? 'No probe template yet — run one request through the proxy first'
        : `Re-measured ${result.measured}/${result.targets} account(s)${fleet ? ` (${fleet})` : ''}`;
    } catch (error) { message = `Re-measure failed: ${(error as Error).message}`; }
    finally { busy = false; }
  };

  const add = async (provider: 'claude' | 'codex'): Promise<void> => { busy = true; message = `Logging into ${provider}...`; process.stdin.setRawMode(false); await render(); try { const result = provider === 'claude' ? await loginClaude() : await loginCodex(); const account = await upsertAccount(provider, result.label, result.credential); selectedId = account.credentialId; message = `Added ${account.label}`; await restartDaemon(); } catch (error) { message = (error as Error).message; } finally { process.stdin.setRawMode(true); busy = false; mode = 'normal'; } };
  const launch = async (provider: 'claude' | 'codex'): Promise<void> => {
    busy = true; process.stdin.setRawMode(false); process.stdout.write(`${ESC}?25h${ESC}?1049l`);
    const cli = fileURLToPath(new URL('./cli.js', import.meta.url)); const result = spawnSync(process.execPath, [cli, 'run', provider], { stdio: 'inherit', env: process.env });
    process.stdout.write(`${ESC}?1049h${ESC}?25l`); process.stdin.setRawMode(true); busy = false; message = result.status === 0 ? `${provider} session closed` : `${provider} exited (${result.status ?? 'error'})`;
  };

  process.stdout.write(`${ESC}?1049h${ESC}?25l`); process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8'); await render(); const timer = setInterval(() => void render(), 500);
  await new Promise<void>((resolve) => process.stdin.on('data', async (key: string) => {
    if (busy) return; message = '';
    if (key === '\u0003' || (mode === 'normal' && key === 'q')) { closed = true; resolve(); return; }
    if (key === '\x1b') mode = 'normal';
    else if (mode === 'add') { if (key === '1' || key === 'c') await add('claude'); else if (key === '2' || key === 'x') await add('codex'); }
    else if (mode === 'delete') { if (key === 'y' || key === '\r') { const account = selected(await rows()); if (account) { await removeAccount(account.credentialId); selectedId = null; message = `Deleted ${account.label}`; await restartDaemon(); } mode = 'normal'; } }
    else if (mode === 'order') {
      if (key === 'a' || key === 'c') { await mutate((account) => { account.priority = null; }); }
      else if (key === '\x1b[A' || key === 'k') await mutate((account) => { account.priority = Math.max(1, (account.priority ?? 2) - 1); });
      else if (key === '\x1b[B' || key === 'j') await mutate((account) => { account.priority = (account.priority ?? 0) + 1; });
      else if (key === '\r') mode = 'normal';
    } else {
      if (key === '\x1b[A' || key === 'k') await move(-1); else if (key === '\x1b[B' || key === 'j') await move(1);
      else if (key === 'e') await mutate((account) => { account.enabled = !account.enabled; });
      else if (key === 's') await mutate((account, accounts) => { for (const other of accounts.filter((x) => x.provider === account.provider && x.priority === 0)) other.priority = null; account.priority = 0; });
      else if (key === '1' || key === 'C') await launch('claude'); else if (key === '2' || key === 'X') await launch('codex');
      else if (key === 'o') mode = 'order'; else if (key === 'd') mode = 'delete'; else if (key === 'a') mode = 'add'; else if (key === 'R') { await remeasure(); }
      else if (key === 'c') { sortByHeadroom = !sortByHeadroom; message = sortByHeadroom ? 'Sorted by remaining quota' : 'Sorted by configured order'; }
    }
    await render();
  }));
  clearInterval(timer); if (closed) { process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write(`${ESC}?25h${ESC}?1049l`); }
}

async function restartDaemon(): Promise<void> {
  const pid = await runningPid(); if (pid) { try { process.kill(pid, 'SIGTERM'); } catch { /* stale */ } for (let i = 0; i < 30 && await runningPid(); i++) await new Promise((resolve) => setTimeout(resolve, 100)); }
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url)); const child = spawn(process.execPath, [cli, 'server'], { detached: true, stdio: 'ignore', env: process.env }); child.unref();
  for (let i = 0; i < 30 && !(await runningPid()); i++) await new Promise((resolve) => setTimeout(resolve, 100));
}
