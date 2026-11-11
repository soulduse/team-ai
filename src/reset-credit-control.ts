// The control-port routes for reset credits: list an account's tickets, and
// spend one by hand. Local only — checked on the socket's own address, since a
// forwarding header could claim loopback from anywhere — and behind the same
// client token as everything else on the control port.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AccountPool } from './account-pool.js';
import { secureEqual } from './proxy.js';
import { weeklyWindow } from './reset-credits.js';
import type { RuntimeAccount } from './types.js';

export function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  const plain = address.startsWith('::ffff:') ? address.slice(7) : address;
  return plain === '::1' || /^127\.\d+\.\d+\.\d+$/.test(plain);
}

function send(res: ServerResponse, status: number, value: unknown): void { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); }

async function hasBody(req: IncomingMessage): Promise<boolean> {
  let size = 0;
  for await (const chunk of req) { size += (chunk as Buffer).length; if (size > 4096) break; }
  return size > 0;
}

// An account by credential id, id or label, as the TUI and status print them.
function findAccount(pool: AccountPool, name: string | null): RuntimeAccount | undefined {
  if (!name) return undefined;
  return pool.accounts.find((a) => a.credentialId === name) ?? pool.accounts.find((a) => a.id === name) ?? pool.accounts.find((a) => a.label === name);
}

// Returns false when the URL is not one of these routes.
export async function handleResetCreditControl(req: IncomingMessage, res: ServerResponse, targetPool: AccountPool | AccountPool[] | undefined, token: string): Promise<boolean> {
  const url = new URL(req.url || '/', 'http://localhost');
  const path = url.pathname;
  let provider: 'codex' | 'claude' | null = null;
  let isList = false;
  let isRedeem = false;
  if (path === '/codex/reset-credits') { provider = 'codex'; isList = true; }
  else if (path === '/codex/reset-credit') { provider = 'codex'; isRedeem = true; }
  else if (path === '/claude/reset-credits') { provider = 'claude'; isList = true; }
  else if (path === '/claude/reset-credit') { provider = 'claude'; isRedeem = true; }
  if (!provider) return false;

  if (!isLoopback(req.socket.remoteAddress)) { send(res, 403, { error: 'local only' }); return true; }
  const given = req.headers.authorization?.replace(/^Bearer\s+/i, '') || '';
  if (!secureEqual(given, token)) { send(res, 401, { error: 'unauthorized' }); return true; }
  if (isList && req.method !== 'GET') { send(res, 405, { error: 'GET only' }); return true; }
  if (isRedeem && req.method !== 'POST') { send(res, 405, { error: 'POST only' }); return true; }
  if (isRedeem && await hasBody(req)) { send(res, 400, { error: 'no request body is accepted' }); return true; }

  const pool = Array.isArray(targetPool) ? targetPool.find((p) => p.provider.id === provider) : targetPool;
  const account = pool && findAccount(pool, url.searchParams.get('account'));
  if (!pool || !account) { send(res, 404, { error: 'unknown account' }); return true; }
  if (listOrRedeemWrongProvider(pool, provider)) { send(res, 404, { error: 'unknown account' }); return true; }

  if (isList) {
    try { send(res, 200, { credits: await pool.listResetCredits(account) }); } catch (error) { send(res, 502, { error: (error as Error).message }); }
    return true;
  }
  // The operator's own choice: no eligibility gate, but still one redemption
  // per account at a time. The usage and list are re-read here rather than by
  // the delayed recheck, so the answer already reflects them.
  const creditId = url.searchParams.get('credit_id')?.slice(0, 512) || undefined;
  const result = await pool.redeemResetCredit(account, 'operator', { creditId, recheck: false });
  await pool.recheckUsage(account);
  await pool.listResetCredits(account, true).catch(() => []);
  const reset = !result.skipped && result.kind === 'reset';
  const u5h = (account.windows['5h'] ?? account.windows.primary)?.usage ?? null;
  const u7d = weeklyWindow(account)?.usage ?? null;
  send(res, reset ? 200 : 409, { account: account.label, reset, outcome: account.resetCreditLastOutcome ?? result.code, resetCredits: account.resetCredits ?? null, unified5h: u5h, unified7d: u7d });
  return true;
}

function listOrRedeemWrongProvider(pool: AccountPool, expected: 'codex' | 'claude'): boolean {
  return pool.provider.id !== expected;
}
