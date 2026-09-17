import { writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Server } from 'node:http';
import { AccountPool } from './account-pool.js';
import { createProxy, secureEqual } from './proxy.js';
import { createServer } from 'node:http';
import { providers } from './providers.js';
import { loadConfig, loadCredentials, loadState, paths, saveCredentials, saveState } from './storage.js';
import type { PersistedState } from './types.js';

export async function runServer(): Promise<void> {
  const config = await loadConfig(); const credentials = await loadCredentials(); const state = await loadState();
  const pools = (['claude', 'codex'] as const).map((id) => new AccountPool(providers[id], config.accounts, credentials, state, config.switchThreshold, config.maxConcurrentPerAccount));
  if (pools.every((p) => p.accounts.length === 0)) throw new Error('No accounts configured');
  let saveTimer: NodeJS.Timeout | null = null; let saving = Promise.resolve(); const events = [...(state.events || [])].slice(-200);
  const persistNow = async (): Promise<void> => { const next: PersistedState = { version: 1, accounts: {}, events }; pools.forEach((p) => p.exportState(next)); const updated = await loadCredentials(); for (const p of pools) for (const a of p.accounts) updated[a.credentialId] = a.credential; await Promise.all([saveState(next), saveCredentials(updated)]); };
  const persist = (event?: string): void => { if (event) { events.push({ at: Date.now(), message: event }); if (events.length > 200) events.splice(0, events.length - 200); } if (saveTimer) return; saveTimer = setTimeout(() => { saveTimer = null; saving = saving.then(persistNow, persistNow); }, 25); };
  const servers: Server[] = [];
  for (const pool of pools) {
    if (!pool.accounts.length) continue;
    const port = pool.provider.id === 'claude' ? config.proxy.claudePort : config.proxy.codexPort;
    const server = createProxy(pool, config.proxy.clientToken, persist); servers.push(server);
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, config.proxy.host, () => { server.removeListener('error', reject); resolve(); }); });
    console.log(`[TeamAI] ${pool.provider.label} proxy: http://${config.proxy.host}:${port}`);
  }
  const refreshProfiles = async (): Promise<void> => { const count = (await Promise.all(pools.map((pool) => pool.refreshProfiles()))).reduce((a, b) => a + b, 0); if (count) persist(`Refreshed subscription status for ${count} account(s)`); };
  void refreshProfiles(); const profileTimer = setInterval(() => void refreshProfiles(), 6 * 60 * 60_000); profileTimer.unref();
  // Local control channel: the TUI runs in a separate process, so a fleet-wide
  // quota re-measure (R) has to reach the pools living here. Bound to the proxy
  // host and gated by the same client token as the proxies.
  const control = createServer(async (req, res) => {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') || '';
    if (!secureEqual(token, config.proxy.clientToken)) { res.writeHead(401).end('{}'); return; }
    if (!req.url?.startsWith('/probe')) { res.writeHead(404).end('{}'); return; }
    // Pick up accounts added or removed by the TUI (a separate process) before
    // measuring, so `R` reflects the current fleet without a server restart.
    const [latestConfig, latestCredentials] = await Promise.all([loadConfig(), loadCredentials()]);
    const changes = pools.map((p) => p.sync(latestConfig.accounts, latestCredentials)).reduce((a, b) => ({ added: a.added + b.added, removed: a.removed + b.removed }), { added: 0, removed: 0 });
    if (changes.added || changes.removed) {
      persist(`Fleet updated: ${changes.added} added, ${changes.removed} removed`);
      // A new account has no profile yet; fill it so its plan renders with its
      // first measurement rather than one refresh cycle later.
      await Promise.all(pools.map((p) => p.refreshProfiles().catch(() => 0)));
    }
    const results = await Promise.all(pools.filter((p) => p.accounts.length).map((p) => p.probeAll()));
    const total = results.reduce((acc, r) => ({ targets: acc.targets + r.targets, measured: acc.measured + r.measured }), { targets: 0, measured: 0 });
    const ready = pools.some((p) => p.hasProbe());
    if (total.targets) persist(`Quota re-measure: ${total.measured}/${total.targets} account(s)`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ...total, ready, ...changes }));
  });
  await new Promise<void>((resolve, reject) => { control.once('error', reject); control.listen(config.proxy.controlPort ?? config.proxy.claudePort + 100, config.proxy.host, () => { control.removeListener('error', reject); resolve(); }); });
  servers.push(control);

  const serverPath = paths().server; await mkdir(dirname(serverPath), { recursive: true }); await writeFile(serverPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { mode: 0o600 });
  const shutdown = async (): Promise<void> => { clearInterval(profileTimer); if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))); await saving; await persistNow(); await rm(serverPath, { force: true }); process.exit(0); };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
}

export async function runningPid(): Promise<number | null> { try { const value = JSON.parse(await readFile(paths().server, 'utf8')) as { pid?: number }; if (!value.pid) return null; process.kill(value.pid, 0); return value.pid; } catch { return null; } }
