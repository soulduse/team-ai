import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loginClaude, loginCodex } from './auth.js';
import { captureDashboard } from './capture.js';
import { copyImageToClipboard, revealInFolder } from './desktop.js';
import { buildFrame, displayOrder, ESC, type FrameMode } from './frame.js';
import { runningPid } from './runtime.js';
import { loadConfig, loadState, removeAccount, saveConfig, upsertAccount } from './storage.js';
import type { StoredAccount } from './types.js';

export async function runTui(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('TUI requires a terminal');
  let selectedId: string | null = null; let mode: FrameMode = 'normal'; let message = ''; let busy = false; let closed = false;
  // Least-spent first by default: the dashboard is mostly read to answer "which
  // account has room left", and that ordering answers it at a glance. 'c' puts
  // it back in configured order for anyone reading it as a roster.
  let sortByHeadroom = true;
  const rows = async (): Promise<StoredAccount[]> => displayOrder((await loadConfig()).accounts, await loadState(), sortByHeadroom);
  const selected = (accounts: StoredAccount[]): StoredAccount | null => accounts.find((account) => account.credentialId === selectedId) || accounts[0] || null;

  const render = async (): Promise<void> => {
    const config = await loadConfig(); const state = await loadState(); const current = selected(displayOrder(config.accounts, state, sortByHeadroom)); if (current && !selectedId) selectedId = current.credentialId;
    const width = Math.max(80, process.stdout.columns || 120); const height = Math.max(24, process.stdout.rows || 40);
    const lines = buildFrame(config, state, { width, height, selectedId, mode, message, sortByHeadroom });
    process.stdout.write(`${ESC}H${lines.join('\n')}`);
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
  // Snapshot what is on screen — same width, cursor and sort — with account
  // addresses masked, so the result can be pasted somewhere public as is.
  // Then hand it over: reveal it in the file manager and put the image on the
  // clipboard, saying which of those actually happened.
  const capture = async (): Promise<void> => {
    busy = true;
    try {
      const result = await captureDashboard({ level: 'partial', width: Math.max(80, process.stdout.columns || 120), selectedId, mode, sortByHeadroom });
      const [copied, revealed] = await Promise.all([copyImageToClipboard(result.png), revealInFolder(result.png)]);
      const extras = [copied ? 'copied to clipboard' : 'clipboard unavailable', revealed ? 'opened folder' : ''].filter(Boolean).join(', ');
      message = `Captured ${result.png.slice(result.png.lastIndexOf('/') + 1)} — ${extras}`;
    } catch (error) { message = `Capture failed: ${(error as Error).message}`; }
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
    if (key === '' || (mode === 'normal' && key === 'q')) { closed = true; resolve(); return; }
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
      else if (key === 'o') mode = 'order'; else if (key === 'd') mode = 'delete'; else if (key === 'a') mode = 'add'; else if (key === 'R') { await remeasure(); } else if (key === 'p') { await capture(); }
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
