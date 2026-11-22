import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { login } from './auth.js';
import { captureDashboard } from './capture.js';
import { copyImageToClipboard, revealInFolder } from './desktop.js';
import { buildFrame, color, DISPLAY_ITEMS, displayOrder, ESC, remeasured, SPINNER, toggleShown, visibleProviders, type FrameMode, type RemeasureView } from './frame.js';
import type { RedactLevel } from './redact.js';
import { runningPid } from './runtime.js';
import { loadConfig, loadState, removeAccount, saveConfig, upsertAccount } from './storage.js';
import type { PersistedState, ProviderId, StoredAccount, TeamAIConfig } from './types.js';
import type { UsageAccountReport, UsageReport } from './usage.js';

// How long the per-row ✓/✗ marks stay after `R` finishes, before the rows go
// back to showing each reading's age.
const REMEASURE_LINGER_MS = 4_000;
// Why an account was not read, in a word: its bench first, then the read's own failure.
function failureOf(account: UsageAccountReport): string | null {
  if (account.errorKind === 'blocked') return 'blocked';
  if (account.errorKind === 'refused') return 're-login';
  if (account.errorKind === 'unreachable') return 'retrying';
  return account.measureError ?? null;
}
const shortLabel = (label: string): string => (label.length > 16 ? `${label.slice(0, 15)}…` : label);

export async function runTui(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('TUI requires a terminal');
  let selectedId: string | null = null; let mode: FrameMode = 'normal'; let message = ''; let busy = false; let closed = false;
  // Least-spent first by default: the dashboard is mostly read to answer "which
  // account has room left", and that ordering answers it at a glance. 'c' puts
  // it back in configured order for anyone reading it as a roster.
  let sortByHeadroom = true;
  // Cursor row in the `v` show/hide menu.
  let viewCursor = 0;
  // Set while `R` runs and for a few seconds after; the frame draws per-row progress from it.
  let remeasureView: RemeasureView | null = null;
  const ordering = (config: TeamAIConfig, state: PersistedState): StoredAccount[] => displayOrder(config.accounts, state, sortByHeadroom, visibleProviders(config));
  const rows = async (): Promise<StoredAccount[]> => ordering(await loadConfig(), await loadState());
  const selected = (accounts: StoredAccount[]): StoredAccount | null => accounts.find((account) => account.credentialId === selectedId) || accounts[0] || null;

  const render = async (): Promise<void> => {
    const config = await loadConfig(); const state = await loadState(); const visibleRows = ordering(config, state); const current = selected(visibleRows); if (current && !visibleRows.some((a) => a.credentialId === selectedId)) selectedId = current.credentialId;
    const width = Math.max(80, process.stdout.columns || 120); const height = Math.max(24, process.stdout.rows || 40);
    const lines = buildFrame(config, state, { width, height, selectedId, mode, message, sortByHeadroom, viewCursor, remeasure: remeasureView ?? undefined });
    process.stdout.write(`${ESC}H${lines.join('\n')}`);
  };

  const move = async (delta: number): Promise<void> => { const accounts = await rows(); const index = Math.max(0, accounts.findIndex((a) => a.credentialId === selectedId)); selectedId = accounts[Math.min(accounts.length - 1, Math.max(0, index + delta))]?.credentialId || null; };
  // Only a row on screen can be changed: with its section hidden, the stale
  // selection must not toggle an account nobody can see.
  const mutate = async (fn: (account: StoredAccount, accounts: StoredAccount[]) => void): Promise<void> => { const config = await loadConfig(); const account = selected(ordering(config, await loadState())); if (!account) return; fn(account, config.accounts); await saveConfig(config); await restartDaemon(); };
  // Fleet-wide quota re-measure. The server owns the pools (and the committed
  // probe template), so this asks it over the local control channel rather than
  // restarting it — a restart only re-read profiles and left every bar blank.
  //
  // It can take most of a minute, and one static line made that look hung. So
  // while it runs the footer spins with a count and the elapsed time, and each
  // row's age column shows a spinner until the server has read that account,
  // then ✓ — or ✗ and why, once the run is over. The server writes state.json
  // only at the end, so progress is polled from GET /usage, which is live.
  const remeasure = async (): Promise<void> => {
    busy = true;
    const view: RemeasureView = { startedAt: Date.now(), finishedAt: null, tick: 0, live: {} };
    remeasureView = view;
    const config = await loadConfig();
    const base = `http://${config.proxy.host}:${config.proxy.controlPort ?? config.proxy.claudePort + 100}`;
    const headers = { authorization: `Bearer ${config.proxy.clientToken}` };
    const credentialOf = new Map(config.accounts.map((account) => [account.id, account.credentialId]));
    const done = (): number => config.accounts.filter((account) => remeasured(view, account.credentialId)).length;
    // One poll at a time: a read can take up to 2s against a 500ms interval, and
    // a slow one landing after the final read would put rows back to ✗.
    let polling: Promise<void> | null = null;
    const poll = (): Promise<void> => (polling ??= read().finally(() => { polling = null; }));
    const read = async (): Promise<void> => {
      try {
        // Masked: only ids, times and failures are read here.
        const response = await fetch(`${base}/usage?redact=full`, { headers, signal: AbortSignal.timeout(2_000) });
        if (!response.ok) return;
        const report = await response.json() as UsageReport;
        for (const group of Object.values(report.providers ?? {})) for (const account of group?.accounts ?? []) {
          const credentialId = credentialOf.get(account.id);
          if (credentialId) view.live[credentialId] = { measuredAt: account.measuredAt ? Date.parse(account.measuredAt) : null, failure: failureOf(account) };
        }
      } catch { /* the next poll tries again; the final one decides */ }
    };
    const progress = (): void => {
      const seconds = ((Date.now() - view.startedAt) / 1000).toFixed(1);
      message = color(33, `${SPINNER[view.tick % SPINNER.length]} Re-measuring quota… ${done()}/${config.accounts.length} read · ${seconds}s`);
    };
    progress(); await render();
    const ticker = setInterval(() => { view.tick++; progress(); void render(); }, 120);
    const poller = setInterval(() => void poll(), 500);
    try {
      const response = await fetch(`${base}/probe`, { headers, signal: AbortSignal.timeout(90_000) });
      if (!response.ok) throw new Error(`control ${response.status}`);
      const result = await response.json() as { targets: number; measured: number; profiles?: number; ready: boolean; added: number; removed: number };
      clearInterval(poller); if (polling) await polling; await poll();
      const fleet = [result.added ? `+${result.added}` : '', result.removed ? `-${result.removed}` : ''].filter(Boolean).join(' ');
      const live = Object.keys(view.live).length > 0;
      const read = live ? done() : result.measured; const total = live ? config.accounts.length : result.targets;
      const missed = config.accounts.filter((account) => live && !remeasured(view, account.credentialId));
      const why = missed.slice(0, 3).map((account) => `${shortLabel(account.label)} ${view.live[account.credentialId]?.failure ?? 'no reading'}`).join(', ');
      const summary = `Re-measured ${read}/${total} account(s)${fleet ? ` (${fleet})` : ''}${result.profiles ? ' · plans refreshed' : ''}${missed.length ? ` · ✗ ${missed.length}: ${why}${missed.length > 3 ? ', …' : ''}` : ''}`;
      message = !result.ready ? color(33, 'No probe template yet — run one request through the proxy first')
        : read === 0 ? color(31, `✗ ${summary}`) : missed.length ? color(33, `! ${summary}`) : color(32, `✓ ${summary}`);
    } catch (error) { message = color(31, `✗ Re-measure failed: ${(error as Error).message}`); }
    finally {
      clearInterval(ticker); clearInterval(poller);
      view.finishedAt = Date.now(); busy = false;
      setTimeout(() => { if (remeasureView === view) { remeasureView = null; if (!closed) void render(); } }, REMEASURE_LINGER_MS).unref();
    }
  };
  // Snapshot what is on screen — same width, cursor and sort — with account
  // addresses masked, so the result can be pasted somewhere public as is.
  // Then hand it over: reveal it in the file manager and put the image on the
  // clipboard, saying which of those actually happened. `p` masks the
  // addresses in part; `P` swaps them for `account #N`, for a capture that
  // should not hint at who the accounts belong to.
  const capture = async (level: RedactLevel): Promise<void> => {
    busy = true;
    try {
      const result = await captureDashboard({ level, width: Math.max(80, process.stdout.columns || 120), selectedId, mode, sortByHeadroom });
      const [copied, revealed] = await Promise.all([copyImageToClipboard(result.png), revealInFolder(result.png)]);
      const extras = [level === 'full' ? 'accounts numbered' : '', copied ? 'copied to clipboard' : 'clipboard unavailable', revealed ? 'opened folder' : ''].filter(Boolean).join(', ');
      message = `Captured ${result.png.slice(result.png.lastIndexOf('/') + 1)} — ${extras}`;
    } catch (error) { message = `Capture failed: ${(error as Error).message}`; }
    finally { busy = false; }
  };

  const add = async (provider: ProviderId): Promise<void> => { busy = true; message = `Logging into ${provider}...`; process.stdin.setRawMode(false); await render(); try { const result = await login(provider); const account = await upsertAccount(provider, result.label, result.credential); selectedId = account.credentialId; message = `Added ${account.label}`; await restartDaemon(); } catch (error) { message = (error as Error).message; } finally { process.stdin.setRawMode(true); busy = false; mode = 'normal'; } };
  const launch = async (provider: ProviderId): Promise<void> => {
    busy = true; process.stdin.setRawMode(false); process.stdout.write(`${ESC}?25h${ESC}?1049l`);
    const cli = fileURLToPath(new URL('./cli.js', import.meta.url)); const result = spawnSync(process.execPath, [cli, 'run', provider], { stdio: 'inherit', env: process.env });
    process.stdout.write(`${ESC}?1049h${ESC}?25l`); process.stdin.setRawMode(true); busy = false; message = result.status === 0 ? `${provider} session closed` : `${provider} exited (${result.status ?? 'error'})`;
  };

  process.stdout.write(`${ESC}?1049h${ESC}?25l`); process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8'); await render(); const timer = setInterval(() => void render(), 500);
  await new Promise<void>((resolve) => process.stdin.on('data', async (key: string) => {
    if (busy) return; message = '';
    if (key === '' || (mode === 'normal' && key === 'q')) { closed = true; resolve(); return; }
    if (key === '\x1b') mode = 'normal';
    else if (mode === 'add') { if (key === '1' || key === 'c') await add('claude'); else if (key === '2' || key === 'x') await add('codex'); else if (key === '3' || key === 'g') await add('grok'); }
    else if (mode === 'delete') { if (key === 'y' || key === '\r') { const account = selected(await rows()); if (account) { await removeAccount(account.credentialId); selectedId = null; message = `Deleted ${account.label}`; await restartDaemon(); } mode = 'normal'; } }
    else if (mode === 'view') {
      if (key === '\x1b[A' || key === 'k') viewCursor = Math.max(0, viewCursor - 1);
      else if (key === '\x1b[B' || key === 'j') viewCursor = Math.min(DISPLAY_ITEMS.length - 1, viewCursor + 1);
      // Display only: saved straight to config, no relay restart.
      else if (key === ' ' || key === '\r') { const item = DISPLAY_ITEMS[viewCursor]!; const config = await loadConfig(); const now = toggleShown(config, item.key); await saveConfig(config); message = `${item.label} ${now ? 'shown' : 'hidden'}`; }
    } else if (mode === 'order') {
      if (key === 'a' || key === 'c') { await mutate((account) => { account.priority = null; }); }
      else if (key === '\x1b[A' || key === 'k') await mutate((account) => { account.priority = Math.max(1, (account.priority ?? 2) - 1); });
      else if (key === '\x1b[B' || key === 'j') await mutate((account) => { account.priority = (account.priority ?? 0) + 1; });
      else if (key === '\r') mode = 'normal';
    } else {
      if (key === '\x1b[A' || key === 'k') await move(-1); else if (key === '\x1b[B' || key === 'j') await move(1);
      else if (key === 'e') await mutate((account) => { account.enabled = !account.enabled; });
      else if (key === 's') await mutate((account, accounts) => { for (const other of accounts.filter((x) => x.provider === account.provider && x.priority === 0)) other.priority = null; account.priority = 0; });
      else if (key === '1' || key === 'C') await launch('claude'); else if (key === '2' || key === 'X') await launch('codex'); else if (key === '3' || key === 'G') await launch('grok');
      else if (key === 'o') mode = 'order'; else if (key === 'v') mode = 'view'; else if (key === 'd') mode = 'delete'; else if (key === 'a') mode = 'add'; else if (key === 'R') { await remeasure(); } else if (key === 'p') { await capture('partial'); } else if (key === 'P') { await capture('full'); }
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
