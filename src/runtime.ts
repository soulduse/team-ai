import { spawn } from 'node:child_process';
import { writeFile, readFile, rm, mkdir, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { claudeWarmToken } from './claude-warm-auth.js';
import { handleClaudeSessionAdopt, handleClaudeSessionControl } from './claude-session-control.js';
import { AccountPool } from './account-pool.js';
import { ActivityLog } from './activity.js';
import { BodyBudget, bodyTimeoutMs, createProxy, maxBodyBytes, maxInflightBodyBytes, secureEqual, type BodyOptions } from './proxy.js';
import { handleResetCreditControl } from './reset-credit-control.js';
import { resetCreditSettings } from './reset-credits.js';
import { handleRouteControl } from './route-control.js';
import { configReloadHandler, type ReloadResult } from './config-reload.js';
import { parseGroups } from './groups.js';
import { parseBalance } from './pacing.js';
import { parseRoutes } from './routes.js';
import { ExternalUsageMonitor, externalUsageSettings } from './external-usage.js';
import { createServer } from 'node:http';
import { providers } from './providers.js';
import { dataDir, defaultConfig, loadConfig, loadCredentials, loadState, paths, saveState, updateCredentials } from './storage.js';
import type { ActivityEvent, PersistedState, ProviderId, TeamAIConfig } from './types.js';
import { UsageRefresher, type UsageRefreshOptions } from './usage-refresh.js';
import { codexCapacitySettings } from './codex-capacity.js';
import { Warmer } from './warmer.js';

// How long a stopping server waits for in-flight responses before cutting them.
const DRAIN_MS = 5_000;

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

// What startServer hands back: stop() drains and closes every port, saves,
// and gives up server.json; the process itself keeps running.
export interface RunningServer { stop(): Promise<void>; ports: Readonly<Record<ProviderId | 'control', number>> }
// background: false leaves out the timers that reach upstream (warm-up, usage,
// profile and token refreshes, other agents' usage) — for tests.
export interface StartOptions { background?: boolean; usageRefresh?: boolean | UsageRefreshOptions }

export async function runServer(): Promise<void> {
  const server = await startServer();
  const shutdown = async (): Promise<void> => { await server.stop(); process.exit(0); };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
}

// Every port is bound before any timer starts, and a port that cannot be bound
// (EADDRINUSE is the usual case) closes the ones already open before the error
// goes up: a half-started relay used to keep answering on the ports it got,
// while the launcher read the failure as "not running" and started another.
export async function startServer(options: StartOptions = {}): Promise<RunningServer> {
  const background = options.background ?? true;
  const config = await loadConfig(); const credentials = await loadCredentials(); const state = await loadState();
  // Checked before anything else: a bad limit is a startup error, not a relay
  // that turns away every request or none.
  const bodyLimit = maxBodyBytes(config.proxy.maxBodyMb);
  // One budget for every proxy in this process: the memory is shared.
  const body: BodyOptions = { limit: bodyLimit, budget: new BodyBudget(maxInflightBodyBytes(config.proxy.maxInflightBodyMb, bodyLimit)), timeoutMs: bodyTimeoutMs(config.proxy.bodyTimeoutMs) };
  const capacitySettings = codexCapacitySettings(config);
  const groups = parseGroups(config.groups, config.accounts);
  const pools = (['claude', 'codex'] as const).map((id) => new AccountPool(providers[id], config.accounts, credentials, state, config.switchThreshold, config.maxConcurrentPerAccount));
  if (pools.every((p) => p.accounts.length === 0)) throw new Error('No accounts configured');
  const balance = parseBalance(config.routing?.balance);
  for (const pool of pools) { pool.balance = balance; pool.codexCapacity = capacitySettings; pool.setGroups(groups); }
  // Model routes are checked before anything listens: a malformed route is a
  // startup error rather than a route that silently never applies.
  const routeWarnings = pools.flatMap((pool) => pool.setRoutes(parseRoutes(config.routes?.[pool.provider.id], pool.provider.id)).map((warning) => `${pool.provider.label} ${warning}`));
  for (const warning of routeWarnings) console.log(`[TeamAI] ${warning}`);
  let saveTimer: NodeJS.Timeout | null = null; let saving = Promise.resolve(); const events: ActivityEvent[] = [...(state.events || [])].slice(-200);
  // Requests in flight. Not restored from state.json: whatever a previous
  // process had open died with it.
  let closing = false;
  // Set by stop() as it takes the final save: nothing reaches disk after it.
  // A request cut by stop() still closes its activity line afterwards, and
  // that used to arm a save that landed after stop() had returned.
  let stopped = false;
  // Other agents' usage, read on its own timer and isolated from the relay:
  // a failure there is a row on the dashboard, never an error here.
  const external = new ExternalUsageMonitor(externalUsageSettings(config));
  external.restore(state.external);
  const activity = new ActivityLog((event) => persist(event), () => persistActivity());
  const snapshot = (): PersistedState => { const next: PersistedState = { version: 1, accounts: {}, events, active: closing ? [] : activity.snapshot(), serverPid: process.pid, external: external.snapshot() }; pools.forEach((p) => p.exportState(next)); return next; };
  // Every save first adopts any credential the TUI wrote since (a re-login),
  // then writes memory back — so a fresh token is picked up within a save
  // interval instead of being overwritten by the stale one it replaced. Only
  // tokens still on disk are written back: one the dashboard deleted along
  // with its account (and a retired account's) is not brought back.
  const persistNow = (): Promise<void> => updateCredentials(async (updated) => { const adopted = pools.reduce((n, p) => n + p.adoptCredentials(updated), 0); if (adopted) events.push({ at: Date.now(), message: `Adopted ${adopted} re-logged credential(s)` }); const next = snapshot(); for (const p of pools) for (const a of p.accounts) if (!a.retired && updated[a.credentialId]) updated[a.credentialId] = a.credential; await saveState(next); });
  // A request starting or picking an account changes only what the dashboard
  // shows, so it rewrites state.json alone; credentials wait for a real save.
  const persistStateOnly = async (): Promise<void> => { await saveState(snapshot()); };
  let fullSave = false;
  const schedule = (): void => { if (saveTimer || stopped) return; saveTimer = setTimeout(() => { saveTimer = null; const run = fullSave ? persistNow : persistStateOnly; fullSave = false; saving = saving.then(run, run); }, 25); };
  const persist = (event?: string | ActivityEvent): void => { if (typeof event === 'string' && /\bcapacity (?:retry|failure after output)\b/.test(event)) console.log(`${new Date().toISOString()} [TeamAI] ${event}`); if (event) { events.push(typeof event === 'string' ? { at: Date.now(), message: event } : event); if (events.length > 200) events.splice(0, events.length - 200); } fullSave = true; schedule(); };
  const persistActivity = (): void => schedule();
  // Reset credits: the ledger goes to disk before and after each consume call,
  // through the same save chain so it never races a scheduled save.
  const saveImmediately = (): Promise<void> => { if (stopped) return Promise.reject(new Error('server stopped')); saving = saving.then(persistNow, persistNow); return saving; };
  for (const warning of routeWarnings) persist(warning);
  for (const pool of pools) {
    pool.log = (message) => persist(message); pool.saveNow = saveImmediately;
    pool.resetCredits = resetCreditSettings(config);
  }
  const servers: Server[] = [];
  const ports = { claude: 0, codex: 0, control: 0 };
  const readExternal = async (force = false): Promise<void> => { try { if (await external.tick(force)) persistActivity(); } catch { /* display only */ } };
  const listen = (server: Server, port: number): Promise<void> => new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, config.proxy.host, () => { server.removeListener('error', reject); resolve(); }); });
  // Proxy ports per provider: bound at startup for a provider with accounts,
  // or by a reload that gives a provider its first one.
  const bound = new Set<ProviderId>();
  const bindPool = async (pool: AccountPool): Promise<void> => {
    if (bound.has(pool.provider.id)) return;
    const port = pool.provider.id === 'claude' ? config.proxy.claudePort : config.proxy.codexPort;
    const server = createProxy(pool, config.proxy.clientToken, persist, () => pool.totalCapacity(), activity, body);
    try { await listen(server, port); } catch (error) { server.close(); server.removeAllListeners(); throw error; }
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('proxy has no TCP address');
    // Port 0 asks for any free port; the running config then names the one
    // bound, so a reload of a file that lists it sees no proxy change.
    ports[pool.provider.id] = address.port;
    if (port === 0) config.proxy[pool.provider.id === 'claude' ? 'claudePort' : 'codexPort'] = address.port;
    servers.push(server); bound.add(pool.provider.id);
    // Past startup, a socket-level error must never end the process: the relay
    // is the only route its clients have, and killing it over one bad socket
    // strands every open session with connection refused.
    server.on('error', (error) => console.log(`[TeamAI] ${pool.provider.label} proxy error: ${error.message}`));
    console.log(`[TeamAI] ${pool.provider.label} proxy: http://${config.proxy.host}:${address.port}`);

    // Also answer on ports this provider used before. A client is handed its
    // base URL through the environment when it starts (cli.ts), and a running
    // process cannot be told about a new one — so changing a port in config
    // strands every session already open, permanently, with connection refused.
    // Keeping the old port alive is what makes a port change survivable.
    // Failures here are not fatal: a port taken by something else just means
    // that one legacy address is unavailable, not that the proxy cannot serve.
    // A port picked at random was never handed to a session, so it has none.
    for (const legacy of port === 0 ? [] : legacyPorts(config, pool.provider.id)) {
      const alias = createProxy(pool, config.proxy.clientToken, persist, () => pool.totalCapacity(), activity, body);
      try {
        await listen(alias, legacy);
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
  };
  // Account changes saved by the dashboard or the account commands, applied in
  // place (config-reload.ts); assigned once the warmer exists, below.
  let reloaded: (result: ReloadResult) => void = () => {};
  let usageRefresher: UsageRefresher | null = null;
  const reload = configReloadHandler(pools, config, { listen: bindPool, applied: (result) => reloaded(result) });
  try {
    for (const pool of pools) if (pool.accounts.length) await bindPool(pool);
    // Local control channel: the TUI runs in a separate process, so a fleet-wide
    // quota re-measure (R) has to reach the pools living here. Bound to the proxy
    // host and gated by the same client token as the proxies.
    const control = createServer(async (req, res) => {
      const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') || '';
      if (await handleResetCreditControl(req, res, pools, config.proxy.clientToken)) return;
      if (await handleClaudeSessionControl(req, res, config.proxy.clientToken, pools.find((p) => p.provider.id === 'claude'))) return;
      if (await handleClaudeSessionAdopt(req, res, pools.find((p) => p.provider.id === 'claude'), config.proxy.clientToken, (message) => { console.log(`${new Date().toISOString()} [TeamAI] ${message}`); persist(message); })) return;
      if (await reload(req, res)) return;
      // Routes edited in the dashboard or with `teamai route`, applied in place.
      if (await handleRouteControl(req, res, pools, config.proxy.clientToken, (warnings, counts) => { persist(`Routes reloaded: claude ${counts.claude ?? 0}, codex ${counts.codex ?? 0}`); for (const warning of warnings) persist(warning); })) return;
      if (!secureEqual(token, config.proxy.clientToken)) { res.writeHead(401).end('{}'); return; }
      if (!req.url?.startsWith('/probe')) { res.writeHead(404).end('{}'); return; }
      // Pick up accounts added or removed by the TUI (a separate process) before
      // measuring, so `R` reflects the current fleet without a server restart.
      const [latestConfig, latestCredentials] = await Promise.all([loadConfig(), loadCredentials()]);
      let latestGroups: ReturnType<typeof parseGroups>;
      try { latestGroups = parseGroups(latestConfig.groups, latestConfig.accounts); }
      catch (error) { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: (error as Error).message })); return; }
      pools.forEach((p) => p.setGroups(latestGroups));
      const changes = pools.map((p) => p.sync(latestConfig.accounts, latestCredentials)).reduce((a, b) => ({ added: a.added + b.added, removed: a.removed + b.removed }), { added: 0, removed: 0 });
      if (changes.added || changes.removed) {
        persist(`Fleet updated: ${changes.added} added, ${changes.removed} removed`);
        // A new account has no profile yet; fill it so its plan renders with its
        // first measurement rather than one refresh cycle later.
        await Promise.all(pools.map((p) => p.refreshProfiles().catch(() => 0)));
      }
      // R also re-reads the other agents, in the background: agy alone takes
      // seconds and must not hold up the account re-measure.
      void readExternal(true);
      const results = await Promise.all(pools.filter((p) => p.accounts.length).map((p) => p.probeAll()));
      usageRefresher?.reconcile();
      const total = results.reduce((acc, r) => ({ targets: acc.targets + r.targets, measured: acc.measured + r.measured }), { targets: 0, measured: 0 });
      const ready = total.measured > 0 || pools.some((p) => p.hasProbe());
      if (total.targets) persist(`Quota re-measure: ${total.measured}/${total.targets} account(s)`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ...total, ready, ...changes }));
    });
    await listen(control, config.proxy.controlPort ?? config.proxy.claudePort + 100); servers.push(control);
    const address = control.address(); if (!address || typeof address === 'string') throw new Error('control has no TCP address');
    ports.control = address.port; if (config.proxy.controlPort === 0) config.proxy.controlPort = address.port;
  } catch (error) {
    // Close what did bind, drop the save a route warning may have scheduled,
    // and let the reason go up (to server-start.log, via cli.ts).
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); })));
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } await saving;
    throw error;
  }

  const timers: NodeJS.Timeout[] = [];
  // Periodic zero-cost usage refresh for all enabled Claude and Codex accounts:
  // idle or lower-priority accounts that receive no proxied traffic still keep
  // their 5h/7d windows and reset timestamps fresh on the dashboard.
  const usageRefreshOpts = typeof options.usageRefresh === 'object' ? options.usageRefresh : {};
  const enableUsageRefresh = options.usageRefresh !== undefined ? Boolean(options.usageRefresh) : background;
  usageRefresher = enableUsageRefresh
    ? new UsageRefresher(pools, { ...usageRefreshOpts, onUpdated: (account, pool) => { usageRefreshOpts.onUpdated?.(account, pool); persist(); } })
    : null;
  // Codex keep-warm is event-driven: a reset arms one check at reset+10s,
  // which refreshes usage and then sends one real `codex exec` to that account.
  // Every decision change and
  // warm outcome also goes to stdout, which an on-demand start writes to
  // server-start.log: the dashboard's event list rolls over in hours, and a
  // warmer that silently stopped warming left no trace anywhere (2026-10-19).
  const codexPool = pools.find((pool) => pool.provider.id === 'codex');
  const claudePool = pools.find((pool) => pool.provider.id === 'claude');
  const warmupEnabled = config.warmup?.enabled !== false;
  const codexWarmer = background && codexPool && warmupEnabled && config.warmup?.codex !== false
    ? new Warmer(codexPool, {
        providerId: 'codex',
        enabled: true,
        port: ports.codex,
        clientToken: config.proxy.clientToken,
        switchThreshold: config.switchThreshold,
        refreshUsage: (account) => codexPool.refreshUsageAccount(account as typeof codexPool.accounts[number]).then(() => { persist(); }),
        log: (message) => persist(message),
        trace: (line) => console.log(`${new Date().toISOString()} [TeamAI] keep-warm ${line}`),
      })
    : null;
  const claudeWarmer = background && claudePool && warmupEnabled && config.warmup?.claude !== false
    ? new Warmer(claudePool, {
        claudeWarmToken: claudeWarmToken(claudePool),
        providerId: 'claude',
        enabled: true,
        port: ports.claude,
        clientToken: config.proxy.clientToken,
        switchThreshold: config.switchThreshold,
        getProbeTemplate: () => claudePool.getProbeTemplate(),
        refreshUsage: (account) => claudePool.refreshUsageAccount(account as typeof claudePool.accounts[number]).then(() => { persist(); }),
        log: (message) => persist(message),
        trace: (line) => console.log(`${new Date().toISOString()} [TeamAI] keep-warm ${line}`),
      })
    : null;
  if (codexWarmer && codexPool) { codexPool.setChangeListener((account) => codexWarmer.onAccountChanged(account)); codexWarmer.start(); }
  if (claudeWarmer && claudePool) { claudePool.setChangeListener((account) => claudeWarmer.onAccountChanged(account)); claudeWarmer.start(); }
  usageRefresher?.start();
  reloaded = (result) => {
    const line = (['claude', 'codex'] as const).map((id) => { const c = result.accounts[id]; return c ? `${id} +${c.added} -${c.removed}${c.retired ? ` (${c.retired} finishing)` : ''}` : ''; }).filter(Boolean).join(', ');
    persist(`Config reloaded: ${line}; routes claude ${result.routes.claude ?? 0}, codex ${result.routes.codex ?? 0}`);
    if (result.adopted) persist(`Adopted ${result.adopted} re-logged credential(s)`);
    for (const warning of result.warnings) persist(warning);
    // Keep-warm re-judges every account: one switched on or off, or new.
    if (codexWarmer && codexPool) for (const account of codexPool.accounts) codexWarmer.onAccountChanged(account);
    if (claudeWarmer && claudePool) for (const account of claudePool.accounts) claudeWarmer.onAccountChanged(account);
    usageRefresher?.reconcile();
    // A new account has no profile yet; fill it so its plan shows right away.
    if (background && Object.values(result.accounts).some((c) => c.added)) void Promise.all(pools.map((p) => p.refreshProfiles().catch(() => 0))).then((n) => { if (n.some(Boolean)) persist(); });
  };

  // The next-account arrows change quietly — a cooldown runs out, a window
  // rolls over — with no event to trigger a save. Re-derive them every 15s
  // and write state.json only when they actually moved.
  let lastMarkers = '';
  const markers = (): string => { const probe: PersistedState = { version: 1, accounts: {} }; pools.forEach((p) => p.exportState(probe)); return JSON.stringify([probe.next, probe.routes]); };
  timers.push(setInterval(() => { const now = markers(); if (now !== lastMarkers) { lastMarkers = now; persistActivity(); } }, 15_000));

  // Other agents' usage, every 30s; R (the control port) also reads it now.
  if (background) {
    timers.push(setInterval(() => void readExternal(), 30_000), setTimeout(() => void readExternal(), 5_000));
  }
  const refreshProfiles = async (): Promise<void> => { const count = (await Promise.all(pools.map((pool) => pool.refreshProfiles()))).reduce((a, b) => a + b, 0); if (count) persist(`Refreshed subscription status for ${count} account(s)`); };
  // Token keep-alive: refresh idle accounts' lapsing tokens so a chain that
  // never rotates does not get invalidated upstream. Runs once now and every
  // five minutes; the sweep itself is sequential to avoid a token-endpoint burst.
  // The sweep always schedules a save, even with nothing to report, so an idle
  // fleet still adopts a re-login (see persistNow) within five minutes.
  const refreshLapsed = async (): Promise<void> => { const results = await Promise.all(pools.map((pool) => pool.refreshLapsed())); const healed = results.reduce((a, r) => a + r.healed, 0); const failed = results.reduce((a, r) => a + r.failed, 0); if (healed) persist(`Refreshed ${healed} lapsed token(s)`); if (failed) persist(`${failed} token refresh(es) failed — re-login needed`); if (!healed && !failed) persist(); };
  if (background) {
    void refreshProfiles(); timers.push(setInterval(() => void refreshProfiles(), 6 * 60 * 60_000));
    setImmediate(() => void refreshLapsed()); timers.push(setInterval(() => void refreshLapsed(), 5 * 60_000));
  }
  for (const timer of timers) timer.unref();

  const serverPath = paths().server; await mkdir(dirname(serverPath), { recursive: true }); await writeFile(serverPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { mode: 0o600 });
  // close() stops listening at once but resolves only when every in-flight
  // response has ended. One long streaming turn held that open for minutes
  // while every other session got connection refused, because the supervisor
  // will not start a replacement until this process exits. Give drains a
  // moment, then cut what is left: the cut client retries, the rest reconnect
  // to the new process seconds later.
  const stop = async (): Promise<void> => {
    usageRefresher?.stop();
    codexWarmer?.stop();
    claudeWarmer?.stop();
    for (const timer of timers) clearTimeout(timer); if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    const drained = Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    await Promise.race([drained, new Promise<void>((resolve) => setTimeout(resolve, DRAIN_MS).unref())]);
    servers.forEach((server) => server.closeAllConnections());
    closing = true; await drained;
    // The final save goes through the save chain, after anything already on it,
    // and is the last write: later events stay in memory only.
    stopped = true; if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    saving = saving.then(persistNow, persistNow); await saving; await releaseServerFile(serverPath);
  };
  return { stop, ports };
}

// Remove server.json only while it still names this process. A restart lets the
// replacement bind and write its own server.json while this one is still
// draining; deleting unconditionally erased the live server's record, so every
// launcher took the relay for stopped and died on EADDRINUSE (2026-10-15).
async function releaseServerFile(serverPath: string): Promise<void> {
  try { const value = JSON.parse(await readFile(serverPath, 'utf8')) as { pid?: number }; if (value.pid !== process.pid) return; } catch { return; }
  await rm(serverPath, { force: true });
}
// The state as the dashboard should draw it: in-flight requests only while the
// server that recorded them is still the one running.
export async function liveState(state: PersistedState): Promise<PersistedState> {
  const pid = await runningPid();
  return pid !== null && pid === state.serverPid ? state : { ...state, active: [], next: undefined };
}
export async function runningPid(): Promise<number | null> { try { const value = JSON.parse(await readFile(paths().server, 'utf8')) as { pid?: number }; if (!value.pid) return null; process.kill(value.pid, 0); return value.pid; } catch { return null; } }

// Start the relay on demand. This is what makes the launchers work whether or
// not a LaunchAgent (or any other supervisor) is managing the server: if
// nothing is listening, the client starts one itself.
export async function ensureServer(): Promise<void> {
  if (await runningPid()) return;
  // Capture the child's output instead of discarding it: when startup fails,
  // its stderr is the only thing that says why (a port already taken, a bad
  // credential file), and "did not start" on its own sends the user hunting.
  const log = join(dataDir(), 'server-start.log');
  await mkdir(dirname(log), { recursive: true, mode: 0o700 });
  const handle = await open(log, 'w', 0o600);
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
  const child = spawn(process.execPath, [cli, 'server'], { detached: true, stdio: ['ignore', handle.fd, handle.fd], env: process.env });
  child.unref();
  await handle.close();
  for (let i = 0; i < 50; i++) { if (await runningPid()) return; await new Promise((r) => setTimeout(r, 100)); }
  let detail = '';
  try { detail = (await readFile(log, 'utf8')).trim(); } catch { /* nothing was written */ }
  throw new Error(detail ? `TeamAI server did not start: ${detail}` : `TeamAI server did not start (see ${log})`);
}
