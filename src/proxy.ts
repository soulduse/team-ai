import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { AccountPool } from './account-pool.js';

const MAX_BODY = 32 * 1024 * 1024;

export function secureEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a); const bb = Buffer.from(b); const size = Math.max(aa.length, bb.length, 1); const pa = Buffer.alloc(size); const pb = Buffer.alloc(size); aa.copy(pa); bb.copy(pb);
  return timingSafeEqual(pa, pb) && aa.length === bb.length;
}
function authorized(req: IncomingMessage, token: string): boolean { const raw = req.headers.authorization?.replace(/^Bearer\s+/i, '') || String(req.headers['x-api-key'] || ''); return secureEqual(raw, token); }
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = []; let size = 0;
  for await (const chunk of req) { const value = Buffer.from(chunk); size += value.length; if (size > MAX_BODY) throw Object.assign(new Error('Request too large'), { status: 413 }); parts.push(value); }
  return Buffer.concat(parts);
}
function incomingHeaders(req: IncomingMessage): Headers { const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) { if (Array.isArray(v)) v.forEach((x) => headers.append(k, x)); else if (v !== undefined) headers.set(k, v); } return headers; }
function sessionKey(req: IncomingMessage, body: Buffer): string { const explicit = req.headers['session_id'] || req.headers['conversation_id']; if (explicit) return String(explicit); try { const value = JSON.parse(body.toString()) as Record<string, unknown>; return String(value.previous_response_id || value.prompt_cache_key || req.socket.remotePort || randomUUID()); } catch { return String(req.socket.remotePort || randomUUID()); } }

export function createProxy(pool: AccountPool, clientToken: string, onChange: (event?: string) => void, capacity?: () => number): Server {
  return createServer(async (req, res) => {
    try {
      if (!authorized(req, clientToken)) return json(res, 401, { error: 'Unauthorized local client' });
      const path = pool.provider.normalizePath(req.url || '/');
      if (!path) return json(res, 404, { error: 'Unsupported proxy path' });
      // Admission control: reject before buffering a body. localhost is trusted,
      // so a flood of local clients could otherwise pin one 32 MB buffer each.
      // The counter lives on the pool so the main port and its legacy aliases
      // share one budget. Drain the request first or the socket leaks.
      if (capacity && pool.inFlightProxied >= capacity()) {
        req.resume();
        return json(res, 429, { error: `${pool.provider.label} relay is at capacity` }, { 'retry-after': '5', 'x-teamai-429-reason': 'concurrency_saturated' });
      }
      pool.inFlightProxied++;
      try {
        const body = await readBody(req);
        await dispatch(req, res, body, path, pool, sessionKey(req, body), onChange);
      } finally { pool.inFlightProxied--; }
    } catch (error) { if (!res.headersSent) json(res, (error as { status?: number }).status || 502, { error: (error as Error).message }); else res.destroy(error as Error); }
  });
}

async function dispatch(req: IncomingMessage, res: ServerResponse, body: Buffer, path: string, pool: AccountPool, session: string, onChange: (event?: string) => void): Promise<void> {
  const excluded = new Set<string>(); let authRetried = false;
  // Decided once from the request body: the retry loop must not re-read a body
  // it has already forwarded, and the answer cannot change between failovers.
  const wantsFable = pool.provider.usesFableBudget?.(path, body) ?? true;
  while (!res.destroyed) {
    const account = pool.acquire(session, excluded, wantsFable);
    if (!account) {
      // Distinguish "every account is busy right now" (retry) from "no account
      // has budget left" (wait for a reset) so the caller — and the logs — know
      // which one they hit.
      const reason = pool.saturatedButHealthy(excluded) ? 'concurrency_saturated' : 'quota_exhausted';
      return json(res, 429, { error: `No ${pool.provider.label} account is currently available` }, { 'x-teamai-429-reason': reason });
    }
    let response: Response;
    try {
      await pool.refresh(account);
      const headers = pool.provider.buildHeaders(incomingHeaders(req), account);
      const sendBody = pool.provider.rewriteBody(body, account);
      headers.set('content-length', String(sendBody.length));
      response = await fetch(`${pool.provider.upstreamBase}${path}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method || '') ? undefined : new Uint8Array(sendBody), signal: AbortSignal.timeout(300_000) });
    } catch (error) {
      pool.release(account); pool.cooldown(account, 2_000); excluded.add(account.id); onChange(`${pool.provider.label} ${req.method} ${path} → ${account.label} network error; failover`);
      if (excluded.size >= pool.accounts.length) throw error;
      continue;
    }
    pool.updateQuota(account, response.headers);
    if (!response.ok) {
      const errorBody = await response.text();
      const decision = pool.provider.classifyFailure(response.status, response.headers, errorBody);
      pool.release(account);
      if (decision.kind === 'auth' && !authRetried) {
        authRetried = true;
        try { await pool.refresh(account, true); } catch (error) { pool.fail(account, (error as Error).message); excluded.add(account.id); }
        onChange(`${pool.provider.label} ${req.method} ${path} → ${account.label} auth refresh`); continue;
      }
      if (decision.kind === 'quota' || decision.kind === 'model-quota') pool.commitProbeFromQuotaRejection(path, incomingHeaders(req), body, response.headers);
      // Only the top model's budget is gone. Benching the account would idle it
      // for days over a window that other models never touch, so it is skipped
      // for this request only — and its Fable window is marked spent so ranking
      // stops sending Fable here without another rejection to learn from.
      if (decision.kind === 'model-quota') {
        pool.markFableSpent(account, decision.retryAfterMs);
        excluded.add(account.id);
        onChange(`${pool.provider.label} ${req.method} ${path} → ${account.label} ${response.status} fable-quota; failover`);
        if (excluded.size < pool.accounts.length) continue;
      }
      // A transient 429 is a request-rate spike, not exhaustion: the account
      // still has token quota, it is just being hit too fast. Do NOT cool it
      // down — a request-rate/global 429 throttled onto the account would poison
      // the fleet for unrelated requests, and a burst across the fleet would
      // bench every account at once. Exclude it for THIS request only and fail
      // over; when every account has been tried the 429 passes through to the
      // client, which backs off on its own. No account state is mutated.
      if (decision.kind === 'transient') {
        excluded.add(account.id); onChange(`${pool.provider.label} ${req.method} ${path} → ${account.label} ${response.status} transient; failover`);
        if (excluded.size < pool.accounts.length) continue;
      }
      if (decision.kind === 'quota' || decision.kind === 'forbidden') {
        pool.cooldown(account, decision.retryAfterMs); excluded.add(account.id); onChange(`${pool.provider.label} ${req.method} ${path} → ${account.label} ${response.status} ${decision.kind}; failover`);
        if (excluded.size < pool.accounts.length) continue;
      }
      copyHeaders(response, res); res.writeHead(response.status); res.end(errorBody); onChange(`${pool.provider.label} ${req.method} ${path} → ${account.label} ${response.status}`); return;
    }
    pool.commitProbe(path, incomingHeaders(req), body, response.headers);
    copyHeaders(response, res); res.writeHead(response.status);
    try {
      if (!response.body) res.end();
      else { const reader = response.body.getReader(); while (true) { const part = await reader.read(); if (part.done) break; if (!res.write(Buffer.from(part.value))) await new Promise<void>((resolve) => res.once('drain', resolve)); } res.end(); }
    } finally { pool.release(account); onChange(`${pool.provider.label} ${req.method} ${path} → ${account.label} ${response.status}`); }
    return;
  }
}

// fetch decompresses the upstream body transparently, so what we forward is
// already plain text. Passing its content-encoding through would tell the
// client to decompress it a second time — the client then fails on a body that
// was never compressed (BrotliDecompressionError). content-length is dropped
// for the same reason: it describes the compressed length.
function copyHeaders(response: Response, res: ServerResponse): void { for (const [key, value] of response.headers) if (!['connection', 'transfer-encoding', 'content-length', 'content-encoding'].includes(key)) res.setHeader(key, value); }
function json(res: ServerResponse, status: number, value: unknown, headers?: Record<string, string>): void { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(value)); }
