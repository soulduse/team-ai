// The control-port route that applies config.json to the running server:
// accounts (added, removed, enabled, priority) and model routes, in place,
// with no restart. The dashboard and the account commands write config.json
// in their own process; this is how the pools living here learn of it.
//
// Everything is checked before anything is touched — every account entry,
// every provider's routes, the balance setting, and a listening port for a
// provider that gains its first account — so a bad file is refused whole and
// the server keeps the settings it had. Applying is synchronous, so a request
// sees either the old settings or the new ones, never a mix. A request already
// running keeps the account it was given; a removed account it runs on is
// retired (AccountPool.sync) and leaves once that request ends. Learned state —
// usage, windows, cooldowns, the reset ledger, other agents' usage — lives on
// the objects that stay and is not re-read.
//
// Settings the running process cannot swap (ports, host, token, the switch
// threshold, the per-account concurrency cap) are reported as warnings: they
// apply at the next `teamai restart`.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AccountPool } from './account-pool.js';
import { codexCapacitySettings } from './codex-capacity.js';
import { parseGroups } from './groups.js';
import { parseBalance } from './pacing.js';
import { secureEqual } from './proxy.js';
import { isLoopback } from './reset-credit-control.js';
import { parseRoutes } from './routes.js';
import { loadConfig, loadCredentials } from './storage.js';
import type { ProviderId, StoredAccount, TeamAIConfig } from './types.js';

export const CONFIG_RELOAD_PATH = '/reload';

export interface ProviderChange { added: number; removed: number; retired: number }
export interface ReloadResult { accounts: Partial<Record<ProviderId, ProviderChange>>; routes: Partial<Record<ProviderId, number>>; adopted: number; warnings: string[] }

export interface ReloadHooks {
  // Make sure this provider's proxy port is listening; called before anything
  // is applied for a provider that has accounts in the new file. A throw
  // refuses the reload.
  listen?(pool: AccountPool): Promise<void>;
  // After a reload has been applied.
  applied?(result: ReloadResult): void;
}

// The account list as the server can use it. Messages name the entry by its
// position, never by its address.
export function checkAccounts(value: unknown): StoredAccount[] {
  if (!Array.isArray(value)) throw new Error('accounts must be a list');
  const seen = new Set<string>();
  value.forEach((entry: unknown, index) => {
    const where = `accounts[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${where} must be an object`);
    const a = entry as Record<string, unknown>;
    if (a.provider !== 'claude' && a.provider !== 'codex') throw new Error(`${where}: provider must be "claude" or "codex"`);
    for (const key of ['id', 'credentialId'] as const) if (typeof a[key] !== 'string' || !a[key]) throw new Error(`${where}: ${key} must be a non-empty string`);
    if (typeof a.label !== 'string') throw new Error(`${where}: label must be a string`);
    if (typeof a.enabled !== 'boolean') throw new Error(`${where}: enabled must be true or false`);
    if (a.priority !== null && a.priority !== undefined && !(Number.isInteger(a.priority) && (a.priority as number) >= 0)) throw new Error(`${where}: priority must be a whole number of 0 or more, or null for auto`);
    if (seen.has(a.credentialId as string)) throw new Error(`${where}: credentialId is used by an earlier account`);
    seen.add(a.credentialId as string);
  });
  return value as StoredAccount[];
}

// What changed that only a restart can apply.
function restartOnly(running: TeamAIConfig, next: TeamAIConfig): string[] {
  const changed = (a: unknown, b: unknown): boolean => JSON.stringify(a) !== JSON.stringify(b);
  return [
    changed(running.proxy, next.proxy) ? 'proxy' : '',
    changed(running.switchThreshold, next.switchThreshold) ? 'switchThreshold' : '',
    changed(running.maxConcurrentPerAccount, next.maxConcurrentPerAccount) ? 'maxConcurrentPerAccount' : '',
  ].filter(Boolean).map((key) => `${key} changed — applies after teamai restart`);
}

// Read config.json and credentials.json and apply them to the pools. Throws,
// having changed nothing, when either cannot be used.
export async function reloadPools(pools: AccountPool[], running: TeamAIConfig, hooks: ReloadHooks = {}): Promise<ReloadResult> {
  const [config, credentials] = await Promise.all([loadConfig(), loadCredentials()]);
  if (!config || typeof config !== 'object') throw new Error('config.json is not an object');
  const accounts = checkAccounts(config.accounts);
  const groups = parseGroups(config.groups, accounts);
  const routes = pools.map((pool) => parseRoutes(config.routes?.[pool.provider.id], pool.provider.id));
  const balance = parseBalance(config.routing?.balance);
  const capacity = codexCapacitySettings(config);
  // Against the settings as they were before this reload opens any port.
  const warnings = restartOnly(running, config);
  for (const pool of pools) if (accounts.some((a) => a.provider === pool.provider.id && credentials[a.credentialId])) await hooks.listen?.(pool);

  // Nothing below awaits: the swap is one step for every request.
  const result: ReloadResult = { accounts: {}, routes: {}, adopted: 0, warnings };
  pools.forEach((pool, index) => {
    result.accounts[pool.provider.id] = pool.sync(accounts, credentials);
    result.adopted += pool.adoptCredentials(credentials);
    pool.setGroups(groups);
    pool.balance = balance;
    pool.codexCapacity = capacity;
    result.routes[pool.provider.id] = routes[index]!.length;
    result.warnings.push(...pool.setRoutes(routes[index]!).map((warning) => `${pool.provider.label} ${warning}`));
  });
  return result;
}

function send(res: ServerResponse, status: number, value: unknown): void { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); }

// The handler for POST /reload. Reloads run one at a time, in the order they
// arrive, so an older read of the file can never land after a newer one.
// Returns false when the URL is not this route.
export function configReloadHandler(pools: AccountPool[], running: TeamAIConfig, hooks: ReloadHooks = {}): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  let queue: Promise<unknown> = Promise.resolve();
  return async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname !== CONFIG_RELOAD_PATH) return false;
    if (!isLoopback(req.socket.remoteAddress)) { send(res, 403, { error: 'local only' }); return true; }
    const given = req.headers.authorization?.replace(/^Bearer\s+/i, '') || '';
    if (!secureEqual(given, running.proxy.clientToken)) { send(res, 401, { error: 'unauthorized' }); return true; }
    if (req.method !== 'POST') { send(res, 405, { error: 'POST only' }); return true; }
    const run = queue.then(() => reloadPools(pools, running, hooks));
    queue = run.catch(() => {});
    try {
      const result = await run;
      hooks.applied?.(result);
      send(res, 200, result);
    } catch (error) { send(res, 400, { error: (error as Error).message }); }
    return true;
  };
}
