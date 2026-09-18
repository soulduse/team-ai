import { writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Server } from 'node:http';
import { AccountPool } from './account-pool.js';
import { createProxy, secureEqual } from './proxy.js';
import { createServer } from 'node:http';
import { providers } from './providers.js';
import { defaultConfig, loadConfig, loadCredentials, loadState, paths, saveCredentials, saveState } from './storage.js';
import type { PersistedState, ProviderId, TeamAIConfig } from './types.js';

// Ports this provider should still answer on besides the configured one:
// whatever the user listed in proxy.legacyPorts, plus the built-in default,
// which is the port every session started before the config was edited was
// handed. Deduplicated, and never the live port itself.
export function legacyPorts(config: TeamAIConfig, id: ProviderId): number[] {
  const current = id === 'claude' ? config.proxy.claudePort : config.proxy.codexPort;
  const fallback = defaultConfig().proxy;
  const declared = config.proxy.legacyPorts?.[id] ?? [];
  const builtIn = id === 'claude' ? fallback.claudePort : fallback.codexPort;
  return [...new Set([...declared, builtIn])].filter((p) => Number.isInteger(p) && p > 0 && p !== current);
}

export async function runServer(): Promise<void> {
  const config = await loadConfig(); const credentials = await loadCredentials(); const state = await loadState();
  const pools = (['claude', 'codex'] as const).map((id) => new AccountPool(providers[id], config.accounts, credentials, state, config.switchThreshold, config.maxConcurrentPerAccount, config.fableReserveThreshold ?? 0.8));
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
    // Past startup, a socket-level error must never end the process: the relay
    // is the only route its clients have, and killing it over one bad socket
    // strands every open session with connection refused.
    server.on('error', (error) => console.log(`[TeamAI] ${pool.provider.label} proxy error: ${error.message}`));
    console.log(`[TeamAI] ${pool.provider.label} proxy: http://${config.proxy.host}:${port}`);

    // Also answer on ports this provider used before. A client is handed its
    // base URL through the environment when it starts (cli.ts), and a running
    // process cannot be told about a new one — so changing a port in config
    // strands every session already open, permanently, with connection refused.
    // Keeping the old port alive is what makes a port change survivable.
    // Failures here are not fatal: a port taken by something else just means
    // that one legacy address is unavailable, not that the proxy cannot serve.
    for (const legacy of legacyPorts(config, pool.provider.id)) {
      const alias = createProxy(pool, config.proxy.clientToken, persist);
      try {
        await new Promise<void>((resolve, reject) => { alias.once('error', reject); alias.listen(legacy, config.proxy.host, () => { alias.removeListener('error', reject); resolve(); }); });
        servers.push(alias);
        console.log(`[TeamAI] ${pool.provider.label} proxy (legacy): http://${config.proxy.host}:${legacy}`);
      } catch (error) {
        // The port is taken (often by an older instance of this very proxy).
        // Close the half-built server rather than leaving it attached: an
        // abandoned one keeps an 'error' listener on a live handle, and the
        // next error it emits is unhandled — which takes down the process that
        // is still serving the main port, and looks to clients exactly like the
        // connection refused this feature exists to prevent.
        alias.close();
        alias.removeAllListeners();
        console.log(`[TeamAI] ${pool.provider.label} legacy port ${legacy} unavailable: ${(error as Error).message}`);
      }
    }
  }
  // Periodic warm-up: fill in accounts the dashboard shows as unmeasured —
  // including ones whose window just rolled over — without waiting for the user
  // to press R or for client traffic to happen to reach them. Only unmeasured
  // accounts are probed, so a settled fleet costs nothing per tick.
  const warmupIntervalMs = config.warmupIntervalMs ?? 5 * 60_000;
  if (warmupIntervalMs > 0) {
    const runWarmup = async (): Promise<void> => {
      const swept = pools.reduce((total, pool) => total + pool.sweepExpired(), 0);
      const measured = (await Promise.all(pools.map((pool) => pool.warmup().catch(() => 0)))).reduce((a, b) => a + b, 0);
      if (measured) persist(`Warm-up measured ${measured} account(s)${swept ? ` after ${swept} window reset(s)` : ''}`);
      else if (swept) persist(`${swept} quota window(s) reset`);
    };
    const warmupTimer = setInterval(() => void runWarmup(), warmupIntervalMs);
    warmupTimer.unref();
    setTimeout(() => void runWarmup(), 5_000).unref();
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
