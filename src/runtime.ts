import { writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Server } from 'node:http';
import { AccountPool } from './account-pool.js';
import { createProxy, secureEqual } from './proxy.js';
import { createServer } from 'node:http';
import { providers } from './providers.js';
import { defaultConfig, loadConfig, loadCredentials, loadState, paths, providerPort, readCredentialsText, saveCredentialsIfUnchanged, saveState } from './storage.js';
import { PROVIDER_IDS, type OAuthCredential, type PersistedState, type ProviderId, type RefreshSweep, type TeamAIConfig } from './types.js';
import { buildUsageReport, requestUrl, serveUsage } from './usage.js';

// How long a stopping server waits for in-flight responses before cutting them.
const DRAIN_MS = 5_000;
// How long one save may take before the next is allowed to start, and how long
// a stopping server waits on saves. A save normally takes milliseconds; one
// stuck behind a saturated thread pool (see threadpool.ts) used to hold every
// later save, and the shutdown that awaits them, indefinitely (2026-10-22).
const SAVE_TIMEOUT_MS = 30_000;
const SHUTDOWN_SAVE_MS = 5_000;
// Retry spacing for a token endpoint that did not answer (see runServer).
const QUICK_RETRY_MIN_MS = 30_000;
const QUICK_RETRY_MAX_MS = 4 * 60_000;
// How many notices state.json keeps, and which relay lines count as one.
const NOTICE_LIMIT = 100;
// An organization refusing OAuth is kept with them: it needs the user (billing), not a retry.
const REFRESH_FAILURE = /auth refresh (unreachable|refused)| blocked: organization refuses OAuth/;

// Wait for work, but no longer than ms. The work keeps running past the
// deadline; whoever waits simply stops waiting. Failures are logged, not
// thrown, so one bad save cannot break the chain behind it.
function bounded(work: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { console.log(`[TeamAI] save still pending after ${ms}ms; moving on`); resolve(); }, ms); timer.unref();
    work.catch((error) => console.log(`[TeamAI] save failed: ${(error as Error).message}`)).finally(() => { clearTimeout(timer); resolve(); });
  });
}

// Ports this provider should still answer on besides the configured one:
// whatever the user listed in proxy.legacyPorts, plus the built-in default,
// which is the port every session started before the config was edited was
// handed. Deduplicated, and never the live port itself.
export function legacyPorts(config: TeamAIConfig, id: ProviderId): number[] {
  const current = providerPort(config.proxy, id);
  const fallback = defaultConfig().proxy;
  const declared = config.proxy.legacyPorts?.[id] ?? [];
  const builtIn = providerPort(fallback, id);
  return [...new Set([...declared, builtIn])].filter((p) => Number.isInteger(p) && p > 0 && p !== current);
}

export async function runServer(): Promise<void> {
  const config = await loadConfig(); const credentials = await loadCredentials(); const state = await loadState();
  const pools = PROVIDER_IDS.map((id) => new AccountPool(providers[id], config.accounts, credentials, state, config.switchThreshold, config.maxConcurrentPerAccount, config.fableReserveThreshold ?? 0.8));
  if (pools.every((p) => p.accounts.length === 0)) throw new Error('No accounts configured');
  let saveTimer: NodeJS.Timeout | null = null; let saving = Promise.resolve(); const events = [...(state.events || [])].slice(-200); const notices = [...(state.notices || [])].slice(-NOTICE_LIMIT);
  // Every save first adopts any credential the TUI wrote since (a re-login),
  // then writes memory back — so a fresh token is picked up within a save
  // interval instead of being overwritten by the stale one it replaced.
  // The credentials write is conditional on the file still reading as it did at
  // the start: a save delayed past a re-login otherwise wrote the token that
  // re-login replaced back over it (2026-10-22). On a mismatch nothing is
  // written and the save runs again, adopting the new token first. A save that
  // outlived its timeout is also superseded by any later one (the generation),
  // so it can land neither file with what memory held minutes ago.
  let saveGeneration = 0;
  const persistNow = async (): Promise<boolean> => {
    const generation = ++saveGeneration; const current = (): boolean => generation === saveGeneration;
    const snapshot = await readCredentialsText(); const updated = (snapshot ? JSON.parse(snapshot) : {}) as Record<string, OAuthCredential>;
    const adopted = pools.reduce((n, p) => n + p.adoptCredentials(updated), 0); if (adopted) record(`Adopted ${adopted} re-logged credential(s)`, true);
    const next: PersistedState = { version: 1, accounts: {}, events, notices }; pools.forEach((p) => p.exportState(next)); for (const p of pools) for (const a of p.accounts) updated[a.credentialId] = a.credential;
    const [, written] = await Promise.all([saveState(next, async () => current()), saveCredentialsIfUnchanged(updated, snapshot, current)]);
    if (!written && current()) persist('Credentials changed on disk during a save; saving again', true);
    return written;
  };
  // A notice also goes to `notices`, which request lines never reach, so a
  // token failure can still be read back (`teamai status`) hours later.
  const record = (message: string, notice: boolean): void => {
    const entry = { at: Date.now(), message };
    events.push(entry); if (events.length > 200) events.splice(0, events.length - 200);
    if (notice) { notices.push(entry); if (notices.length > NOTICE_LIMIT) notices.splice(0, notices.length - NOTICE_LIMIT); }
  };
  const persist = (event?: string, notice = false): void => { if (event) record(event, notice); if (saveTimer) return; saveTimer = setTimeout(() => { saveTimer = null; saving = saving.then(() => bounded(persistNow(), SAVE_TIMEOUT_MS)); }, 25); };
  // A token endpoint that did not answer is retried sooner than the sweep:
  // 30s, then doubling to 4 min, back to 30s once it answers. Only accounts
  // benched that way are retried; a refused token waits for the sweep. Armed
  // by a sweep that met one and by a request whose 401 refresh did.
  let quickDelay = QUICK_RETRY_MIN_MS; let quickTimer: NodeJS.Timeout | null = null; let quickDueAt = 0;
  const armQuickRetry = (): number => {
    if (quickTimer) return quickDueAt;
    quickDueAt = Date.now() + quickDelay;
    quickTimer = setTimeout(() => { quickTimer = null; void retryUnreachable(); }, quickDelay); quickTimer.unref();
    quickDelay = Math.min(quickDelay * 2, QUICK_RETRY_MAX_MS);
    return quickDueAt;
  };
  // An account's outcome becomes a notice only when it changes, so a long
  // outage leaves one "unreachable" line per account rather than one per retry
  // pushing the rest — a refusal that does need a re-login — out of the log.
  const lastOutcome = new Map<string, string>();
  const report = (results: RefreshSweep[]): void => {
    // A sweep that found another one running did nothing and says nothing,
    // least of all that the network is back.
    if (results.every((r) => r.skipped)) return;
    const unreachable = results.reduce((a, r) => a + r.unreachable, 0);
    if (!unreachable) quickDelay = QUICK_RETRY_MIN_MS;
    const dueAt = unreachable ? armQuickRetry() : 0;
    const retryIn = Math.max(1, Math.round((dueAt - Date.now()) / 1000));
    for (const outcome of results.flatMap((r) => r.outcomes)) {
      const changed = lastOutcome.get(outcome.label) !== outcome.kind; lastOutcome.set(outcome.label, outcome.kind);
      const suffix = outcome.kind === 'unreachable' ? ` — retrying in ${retryIn < 60 ? `${retryIn}s` : AccountPool.formatDuration(retryIn * 1000)}` : outcome.kind === 'refused' ? ' — re-login needed' : '';
      persist(`${outcome.label}: ${outcome.message.replace(/; retrying$/, '')}${suffix}`, changed);
    }
    const routine = results.reduce((a, r) => a + r.healed, 0) - results.reduce((a, r) => a + r.outcomes.filter((o) => o.kind === 'healed').length, 0);
    if (routine) persist(`Refreshed ${routine} lapsing token(s)`);
    persist();
  };
  const retryUnreachable = async (): Promise<void> => report(await Promise.all(pools.map((pool) => pool.refreshLapsed({ onlyUnreachable: true }))));
  // Request lines stay out of the notices, except a failed token refresh; one
  // the network swallowed also starts the quick retry.
  const relayEvent = (event?: string): void => {
    const refreshFailed = event !== undefined && REFRESH_FAILURE.test(event);
    if (refreshFailed && event.includes('unreachable')) armQuickRetry();
    persist(event, refreshFailed);
  };
  const servers: Server[] = [];
  for (const pool of pools) {
    if (!pool.accounts.length) continue;
    const port = providerPort(config.proxy, pool.provider.id);
    const server = createProxy(pool, config.proxy.clientToken, relayEvent, () => pool.totalCapacity()); servers.push(server);
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
      const alias = createProxy(pool, config.proxy.clientToken, relayEvent, () => pool.totalCapacity());
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
  // Periodic warm-up. First every account whose figures are older than half a
  // tick is re-read from the usage endpoint, which spends no quota — so usage
  // run up outside this proxy shows without pressing R, and no reading is ever
  // much older than one tick. Accounts live traffic keeps fresh are skipped.
  // Then anything still unmeasured (the endpoint failed, or the provider has
  // none) is probed, which does spend quota and so is kept to that remainder.
  const warmupIntervalMs = config.warmupIntervalMs ?? 5 * 60_000;
  if (warmupIntervalMs > 0) {
    const runWarmup = async (): Promise<void> => {
      const swept = pools.reduce((total, pool) => total + pool.sweepExpired(), 0);
      const refreshed = (await Promise.all(pools.map((pool) => pool.refreshUsage(warmupIntervalMs / 2)))).reduce((a, b) => a + b.size, 0);
      const measured = (await Promise.all(pools.map((pool) => pool.warmup().catch(() => 0)))).reduce((a, b) => a + b, 0);
      if (measured) persist(`Warm-up measured ${measured} account(s)${swept ? ` after ${swept} window reset(s)` : ''}`);
      else if (swept) persist(`${swept} quota window(s) reset`);
      else if (refreshed) persist();
    };
    const warmupTimer = setInterval(() => void runWarmup(), warmupIntervalMs);
    warmupTimer.unref();
    setTimeout(() => void runWarmup(), 5_000).unref();
  }

  const refreshProfiles = async (): Promise<void> => { const count = (await Promise.all(pools.map((pool) => pool.refreshProfiles()))).reduce((a, b) => a + b, 0); if (count) persist(`Refreshed subscription status for ${count} account(s)`, true); };
  void refreshProfiles(); const profileTimer = setInterval(() => void refreshProfiles(), 6 * 60 * 60_000); profileTimer.unref();
  // Token keep-alive: refresh idle accounts' lapsing tokens so a chain that
  // never rotates does not get invalidated upstream. Runs once now and every
  // five minutes; the sweep itself is sequential to avoid a token-endpoint burst.
  // The sweep always schedules a save, even with nothing to report, so an idle
  // fleet still adopts a re-login (see persistNow) within five minutes.
  const refreshLapsed = async (): Promise<void> => report(await Promise.all(pools.map((pool) => pool.refreshLapsed())));
  setImmediate(() => void refreshLapsed()); const lapsedTimer = setInterval(() => void refreshLapsed(), 5 * 60_000); lapsedTimer.unref();
  // Local control channel: the TUI runs in a separate process, so a fleet-wide
  // quota re-measure (R) has to reach the pools living here. Bound to the proxy
  // host and gated by the same client token as the proxies.
  const control = createServer(async (req, res) => {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') || '';
    if (!secureEqual(token, config.proxy.clientToken)) { res.writeHead(401).end('{}'); return; }
    // Read-only usage report for other sessions and scripts. Answered before
    // the /probe branch: it must not sync the fleet or spend a probe.
    const url = requestUrl(req);
    if (!url) { res.writeHead(400).end('{}'); return; }
    if (req.method === 'GET' && url.pathname === '/usage') {
      await serveUsage(url, res, async (level) => {
        const snapshot: PersistedState = { version: 1, accounts: {} }; pools.forEach((p) => p.exportState(snapshot));
        // Labels, enabled flags and the switch threshold can change under a
        // running server (the TUI edits config.json), so read them fresh.
        return buildUsageReport(await loadConfig(), snapshot, { source: 'live', level, live: pools.flatMap((p) => p.liveStatus()) });
      });
      return;
    }
    if (!req.url?.startsWith('/probe')) { res.writeHead(404).end('{}'); return; }
    // Pick up accounts added or removed by the TUI (a separate process) before
    // measuring, so `R` reflects the current fleet without a server restart.
    const [latestConfig, latestCredentials] = await Promise.all([loadConfig(), loadCredentials()]);
    const changes = pools.map((p) => p.sync(latestConfig.accounts, latestCredentials)).reduce((a, b) => ({ added: a.added + b.added, removed: a.removed + b.removed }), { added: 0, removed: 0 });
    if (changes.added || changes.removed) {
      persist(`Fleet updated: ${changes.added} added, ${changes.removed} removed`, true);
    }
    // Subscription status is re-read alongside: it otherwise moves only every
    // six hours, so a bill paid a minute ago kept showing past_due after R.
    // This is also what fills a just-added account's plan.
    const [results, profiles] = await Promise.all([
      Promise.all(pools.filter((p) => p.accounts.length).map((p) => p.probeAll())),
      Promise.all(pools.map((p) => p.refreshProfiles().catch(() => 0))).then((counts) => counts.reduce((a, b) => a + b, 0)),
    ]);
    const total = results.reduce((acc, r) => ({ targets: acc.targets + r.targets, measured: acc.measured + r.measured }), { targets: 0, measured: 0 });
    const ready = total.measured > 0 || pools.some((p) => p.hasProbe());
    if (total.targets) persist(`Quota re-measure: ${total.measured}/${total.targets} account(s)${profiles ? `, subscription status refreshed for ${profiles}` : ''}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ...total, profiles, ready, ...changes }));
  });
  await new Promise<void>((resolve, reject) => { control.once('error', reject); control.listen(config.proxy.controlPort ?? config.proxy.claudePort + 100, config.proxy.host, () => { control.removeListener('error', reject); resolve(); }); });
  servers.push(control);

  const serverPath = paths().server; await mkdir(dirname(serverPath), { recursive: true }); await writeFile(serverPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { mode: 0o600 });
  // close() stops listening at once but resolves only when every in-flight
  // response has ended. One long streaming turn held that open for minutes
  // while every other session got connection refused, because the supervisor
  // will not start a replacement until this process exits. Give drains a
  // moment, then cut what is left: the cut client retries, the rest reconnect
  // to the new process seconds later.
  const shutdown = async (): Promise<void> => {
    clearInterval(profileTimer); clearInterval(lapsedTimer); if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    const drained = Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    await Promise.race([drained, new Promise<void>((resolve) => setTimeout(resolve, DRAIN_MS).unref())]);
    servers.forEach((server) => server.closeAllConnections());
    // The last save carries tokens refreshed in memory, which upstream will not
    // honour twice — so a re-login landing mid-save gets a few more tries here
    // rather than the deferred retry a running server would make.
    await drained; await bounded(saving, SHUTDOWN_SAVE_MS);
    const finalSave = async (): Promise<void> => { for (let attempt = 0; attempt < 3 && !await persistNow(); attempt++); };
    await bounded(finalSave(), SHUTDOWN_SAVE_MS); await releaseServerFile(serverPath); process.exit(0);
  };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
}

// Remove server.json only while it still names this process. A restart lets the
// replacement bind and write its own server.json while this one is still
// draining; deleting unconditionally erased the live server's record, so every
// launcher took the relay for stopped and died on EADDRINUSE (2026-10-15).
// `teamai stop` passes the pid it killed: a killed server never gets here.
export async function releaseServerFile(serverPath: string, pid = process.pid): Promise<void> {
  try { const value = JSON.parse(await readFile(serverPath, 'utf8')) as { pid?: number }; if (value.pid !== pid) return; } catch { return; }
  await rm(serverPath, { force: true });
}
export async function runningPid(): Promise<number | null> { try { const value = JSON.parse(await readFile(paths().server, 'utf8')) as { pid?: number }; if (!value.pid) return null; process.kill(value.pid, 0); return value.pid; } catch { return null; } }
