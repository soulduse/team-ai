import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Socket } from 'node:net';
import { AccountPool } from './account-pool.js';
import type { Provider } from './types.js';

// Upper bound on waiting for upstream response headers only. Never applies to the body.
const HEADER_TIMEOUT_MS = 300_000;

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
// Which session a request belongs to, for account affinity. The provider reads
// the client's own id (Claude Code's x-claude-code-session-id, Codex's
// session-id); a request that names none is keyed by its connection, so a
// keep-alive client still sticks. Connection identity, not the port number: a
// port is recycled by the OS the moment a connection closes, and two unrelated
// sessions used to share one key that way while one session's parallel
// connections were spread over several accounts.
const connectionIds = new WeakMap<Socket, string>();
function connectionId(socket: Socket): string { let id = connectionIds.get(socket); if (!id) { id = randomUUID(); connectionIds.set(socket, id); } return id; }
function sessionKey(provider: Provider, req: IncomingMessage, body: Buffer): string { return provider.sessionKey?.(incomingHeaders(req), body) || connectionId(req.socket); }

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
        await dispatch(req, res, body, path, pool, sessionKey(pool.provider, req, body), onChange);
      } finally { pool.inFlightProxied--; }
    } catch (error) { if (!res.headersSent) json(res, (error as { status?: number }).status || 502, { error: (error as Error).message }); else res.destroy(error as Error); }
  });
}

async function dispatch(req: IncomingMessage, res: ServerResponse, body: Buffer, path: string, pool: AccountPool, session: string, onChange: (event?: string) => void): Promise<void> {
  const excluded = new Set<string>(); let authRetried = false;
  // Decided once from the request body: the retry loop must not re-read a body
  // it has already forwarded, and the answer cannot change between failovers.
  const wantsFable = pool.provider.usesFableBudget?.(path, body) ?? false;
  let lastFailure: { response: Response; body: string; transient: boolean } | null = null;
  const transientAccounts = new Set<string>();
  let retryRounds = 0;
  let retryWaitMs = 0;
  let nextRetryAt = 0;
  while (!res.destroyed) {
    const account = pool.acquire(session, excluded, wantsFable);
    if (!account) {
      // Exhausting this request's candidates does not mean exhausting quota.
      // Only retry explicit pre-stream transient HTTP failures; never replay a
      // successful/partially streamed response. Keep retries in the relay.
      if (lastFailure) {
        const delay = Math.max(1000 * 2 ** retryRounds, nextRetryAt - Date.now()) + Math.floor(Math.random() * 200);
        if (lastFailure.transient && transientAccounts.size && retryRounds < 2 && delay <= 10_000 && retryWaitMs + delay <= 20_000) {
          retryRounds++; retryWaitMs += delay;
          onChange(`${pool.provider.label} transient retry ${retryRounds}/2 after ${delay}ms`);
          await waitForRetry(delay, res);
          if (res.destroyed) return;
          for (const id of transientAccounts) excluded.delete(id);
          transientAccounts.clear(); nextRetryAt = 0;
          continue;
        }
        copyHeaders(lastFailure.response, res);
        res.writeHead(lastFailure.response.status); res.end(lastFailure.body);
        onChange(`${pool.provider.label} ${req.method} ${path} → ${lastFailure.response.status} upstream failure preserved`);
        return;
      }
      // Say what is actually short — a free slot (retry in a moment) or budget
      // (and whose, and until when) — and leave a trace in the activity log:
      // this 429 never reached upstream, so nothing else records it.
      const shortfall = pool.explainShortfall(excluded, wantsFable);
      onChange(`${pool.provider.label} ${req.method} ${path} → 429 ${shortfall.reason}${wantsFable ? ' (fable)' : ''}${shortfall.retryAfterMs ? `, next reset ${AccountPool.formatDuration(shortfall.retryAfterMs)}` : ''}`);
      const headers: Record<string, string> = { 'x-teamai-429-reason': shortfall.reason };
      // Claude Code honours retry-after; cap it so a days-away weekly reset
      // does not park a session for days when a session window may roll first.
      if (shortfall.retryAfterMs) headers['retry-after'] = String(Math.min(900, Math.ceil(shortfall.retryAfterMs / 1000)));
      return json(res, 429, { error: shortfall.message }, headers);
    }
    let response: Response;
    try {
      await pool.refresh(account);
      const headers = pool.provider.buildHeaders(incomingHeaders(req), account);
      const sendBody = pool.provider.rewriteBody(body, account);
      headers.set('content-length', String(sendBody.length));
      // AbortSignal.timeout(300_000) used to sit here, and it kept running
      // while the body streamed: a turn that thought for more than five
      // minutes was cut at exactly 300s and Claude Code showed "Connection
      // lost mid-response" (2026-09-20, two turns). The guard is only meant
      // to stop a request that never answers, so it is disarmed the moment
      // headers arrive; a streaming body has no time limit. A client that
      // goes away mid-stream is handled in pipeStream, so no slot leaks.
      const headerGuard = new AbortController();
      const headerTimer = setTimeout(() => headerGuard.abort(new Error('upstream sent no response headers within 300s')), HEADER_TIMEOUT_MS);
      try {
        response = await fetch(`${pool.provider.upstreamBase}${path}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method || '') ? undefined : new Uint8Array(sendBody), signal: headerGuard.signal });
      } finally { clearTimeout(headerTimer); }
    } catch (error) {
      lastFailure = { response: new Response(null, { status: 502 }), body: JSON.stringify({ error: 'Upstream connection failed' }), transient: false };
      pool.release(account); pool.cooldown(account, 2_000, 'network'); excluded.add(account.id); onChange(`${pool.provider.label} ${req.method} ${path} → ${account.label} network error; failover`);
      if (excluded.size >= pool.accounts.length) throw error;
      continue;
    }
    pool.updateQuota(account, response.headers);
    if (!response.ok) {
      // Read the error body before releasing the slot, but never leak the slot
      // if the read itself fails: an upstream that closes the connection
      // mid-body used to throw out of here with inflight still counted, and
      // after enough such cuts the account sat at its concurrency cap with
      // quota to spare, shown active, serving nothing until a restart.
      let errorBody: string;
      try { errorBody = await response.text(); } catch (error) { pool.release(account); throw error; }
      const decision = pool.provider.classifyFailure(response.status, response.headers, errorBody);
      pool.release(account);
      // A transient failure keeps its place as the request's failure of record:
      // a later quota or forbidden rejection on another account must not turn
      // a retryable 503 into a quota answer while retry rounds remain.
      if (!(lastFailure?.transient && transientAccounts.size && decision.kind !== 'transient')) lastFailure = { response, body: errorBody, transient: decision.kind === 'transient' };
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
      // over; when no account remains, bounded retry rounds run above before
      // the original error is returned. No quota state is mutated.
      if (decision.kind === 'transient') {
        excluded.add(account.id); onChange(`${pool.provider.label} ${req.method} ${path} → ${account.label} ${response.status} transient; failover`);
        transientAccounts.add(account.id);
        nextRetryAt = Math.max(nextRetryAt, Date.now() + decision.retryAfterMs);
        continue;
      }
      if (decision.kind === 'quota' || decision.kind === 'forbidden') {
        pool.cooldown(account, decision.retryAfterMs, decision.kind); excluded.add(account.id); onChange(`${pool.provider.label} ${req.method} ${path} → ${account.label} ${response.status} ${decision.kind}; failover`);
        // A spent account after a transient one must not end the request: the
        // transient account still has its retry rounds, and the decision block
        // at the top of the loop owns that — it returns the preserved failure
        // itself when no retry applies. Returning here abandoned the transient
        // retry and answered a 2-second 503 with a quota 429.
        if (transientAccounts.size) lastFailure = { response: lastFailure!.response, body: lastFailure!.body, transient: true };
        continue;
      }
      copyHeaders(response, res); res.writeHead(response.status); res.end(errorBody); onChange(`${pool.provider.label} ${req.method} ${path} → ${account.label} ${response.status}`); return;
    }
    pool.commitProbe(path, incomingHeaders(req), body, response.headers);
    copyHeaders(response, res); res.writeHead(response.status);
    // A stream that breaks after the 200 was written used to be logged as a
    // plain 200, indistinguishable from success; the client saw a destroyed
    // socket ("error decoding response body") and the relay showed nothing.
    let cut: string | null = null;
    try {
      if (!response.body) res.end();
      else await pipeStream(response.body, res);
    } catch (error) { cut = (error as Error).message; throw error; }
    finally { pool.release(account); onChange(`${pool.provider.label} ${req.method} ${path} → ${account.label} ${response.status}${cut ? ` stream cut mid-body: ${cut}` : ''}`); }
    return;
  }
}

// Cancellation must release admission capacity without waiting out backoff.
async function waitForRetry(ms: number, res: ServerResponse): Promise<void> {
  if (res.destroyed) return;
  await new Promise<void>((resolve) => {
    const done = () => { clearTimeout(timer); res.removeListener('close', done); resolve(); };
    const timer = setTimeout(done, ms);
    res.once('close', done);
  });
}

// Forward the upstream body chunk by chunk, honouring backpressure. The client
// can vanish mid-stream (Esc, a cancelled tool, a retry): a destroyed response
// returns false from write() and never emits 'drain', so waiting on drain alone
// hung here forever and the account's inflight slot leaked until restart. On
// close the upstream read is cancelled too, so the model stops generating into
// the void instead of spending the account's quota on a response nobody reads.
async function pipeStream(body: ReadableStream<Uint8Array>, res: ServerResponse): Promise<void> {
  const reader = body.getReader();
  const closed = new Promise<void>((resolve) => { if (res.destroyed) resolve(); else res.once('close', () => resolve()); });
  const onClose = () => { void reader.cancel().catch(() => {}); };
  res.once('close', onClose);
  try {
    while (!res.destroyed) {
      const part = await reader.read(); if (part.done) break;
      if (!res.write(Buffer.from(part.value)) && !res.destroyed) await Promise.race([new Promise<void>((resolve) => res.once('drain', resolve)), closed]);
    }
    if (!res.destroyed) res.end();
  } finally { res.removeListener('close', onClose); await reader.cancel().catch(() => {}); }
}

// fetch decompresses the upstream body transparently, so what we forward is
// already plain text. Passing its content-encoding through would tell the
// client to decompress it a second time — the client then fails on a body that
// was never compressed (BrotliDecompressionError). content-length is dropped
// for the same reason: it describes the compressed length.
function copyHeaders(response: Response, res: ServerResponse): void { for (const [key, value] of response.headers) if (!['connection', 'transfer-encoding', 'content-length', 'content-encoding'].includes(key)) res.setHeader(key, value); }
function json(res: ServerResponse, status: number, value: unknown, headers?: Record<string, string>): void { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(value)); }
