import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import test from 'node:test';
import { AccountPool } from '../src/account-pool.js';
import { createProxy } from '../src/proxy.js';
import { claudeProvider, codexProvider } from '../src/providers.js';
import type { OAuthCredential, PersistedState, Provider, StoredAccount } from '../src/types.js';

test('proxy strips client secrets and fails quota account over to the next account', async () => {
  const seen: Array<{ account: string | null; cookie: string | null }> = [];
  const upstream = createServer(async (req, res) => {
    const headers = new Headers(); for (const [key, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(key, String(value));
    seen.push({ account: headers.get('chatgpt-account-id'), cookie: headers.get('cookie') });
    req.resume(); await new Promise<void>((resolve) => req.once('end', resolve));
    if (headers.get('chatgpt-account-id') === 'a') { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' }); res.end('{"code":"usage_limit_reached"}'); }
    else { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: {"type":"response.completed"}\n\n'); }
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve)); const address = upstream.address(); assert(address && typeof address !== 'string');
  const provider: Provider = {
    id: 'codex', label: 'Codex', upstreamBase: `http://127.0.0.1:${address.port}`,
    normalizePath: () => '/codex/responses', rewriteBody: (body) => body, readQuota: () => null, refresh: async (c) => c,
    buildHeaders(incoming, account) { const result = new Headers(incoming); result.delete('cookie'); result.delete('authorization'); result.set('authorization', `Bearer ${account.credential.accessToken}`); result.set('chatgpt-account-id', account.id); return result; },
    classifyFailure(status) { return { kind: status === 429 ? 'quota' : 'fatal', retryAfterMs: 1000 }; },
  };
  const stored = (id: string, priority: number): StoredAccount => ({ id, provider: 'codex', label: id, enabled: true, priority, credentialId: id, createdAt: '' });
  const credential = (id: string): OAuthCredential => ({ accessToken: `secret-${id}`, refreshToken: null, expiresAt: null, accountId: id });
  const state: PersistedState = { version: 1, accounts: {} };
  const pool = new AccountPool(provider, [stored('a', 1), stored('b', 2)], { a: credential('a'), b: credential('b') }, state);
  const proxy = createProxy(pool, 'local-secret', () => {}); await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve)); const proxyAddress = proxy.address(); assert(proxyAddress && typeof proxyAddress !== 'string');
  try {
    const response = await fetch(`http://127.0.0.1:${proxyAddress.port}/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer local-secret', cookie: 'never-forward', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 200); assert.match(await response.text(), /response.completed/);
    assert.deepEqual(seen.map((x) => x.account), ['a', 'b']); assert.deepEqual(seen.map((x) => x.cookie), [null, null]);
  } finally { proxy.close(); upstream.close(); }
});

test('admission control rejects before buffering once the pool is at capacity', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const upstream = createServer(async (req, res) => {
    req.resume(); await new Promise<void>((r) => req.once('end', r));
    await gate; // hold the first request open so the second finds the pool full
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: {}\n\n');
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r)); const up = upstream.address(); assert(up && typeof up !== 'string');
  const provider: Provider = {
    id: 'codex', label: 'Codex', upstreamBase: `http://127.0.0.1:${up.port}`,
    normalizePath: () => '/codex/responses', rewriteBody: (b) => b, readQuota: () => null, refresh: async (c) => c,
    buildHeaders: (incoming, account) => { const h = new Headers(incoming); h.set('authorization', `Bearer ${account.credential.accessToken}`); return h; },
    classifyFailure: () => ({ kind: 'fatal', retryAfterMs: 0 }),
  };
  const stored: StoredAccount = { id: 'a', provider: 'codex', label: 'a', enabled: true, priority: 1, credentialId: 'a', createdAt: '' };
  const state: PersistedState = { version: 1, accounts: {} };
  // maxConcurrent 1, single account → totalCapacity 1.
  const pool = new AccountPool(provider, [stored], { a: { accessToken: 's', refreshToken: null, expiresAt: null, accountId: 'a' } }, state, 0.98, 1);
  const proxy = createProxy(pool, 'local-secret', () => {}, () => pool.totalCapacity());
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r)); const pa = proxy.address(); assert(pa && typeof pa !== 'string');
  const call = () => fetch(`http://127.0.0.1:${pa.port}/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' }, body: '{}' });
  try {
    const first = call();
    // Wait until the first request is actually in flight (counted) before firing the second.
    for (let i = 0; i < 50 && pool.inFlightProxied === 0; i++) await new Promise((r) => setTimeout(r, 10));
    const second = await call();
    assert.equal(second.status, 429);
    assert.equal(second.headers.get('retry-after'), '5');
    assert.equal(second.headers.get('x-teamai-429-reason'), 'concurrency_saturated');
    release();
    assert.equal((await first).status, 200);
  } finally { release(); proxy.close(); upstream.close(); }
});

test('admission control is off when no capacity function is given', async () => {
  const provider: Provider = {
    id: 'codex', label: 'Codex', upstreamBase: 'http://127.0.0.1:1',
    normalizePath: () => '/codex/responses', rewriteBody: (b) => b, readQuota: () => null, refresh: async (c) => c,
    buildHeaders: (h) => h, classifyFailure: () => ({ kind: 'fatal', retryAfterMs: 0 }),
  };
  const stored: StoredAccount = { id: 'a', provider: 'codex', label: 'a', enabled: true, priority: 1, credentialId: 'a', createdAt: '' };
  const pool = new AccountPool(provider, [stored], { a: { accessToken: 's', refreshToken: null, expiresAt: null, accountId: 'a' } }, { version: 1, accounts: {} }, 0.98, 1);
  pool.inFlightProxied = 999; // would be rejected IF admission were active
  const proxy = createProxy(pool, 'local-secret', () => {}); // no capacity arg
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r)); const pa = proxy.address(); assert(pa && typeof pa !== 'string');
  try {
    // Reaches dispatch (not a 429-capacity short-circuit); upstream is unreachable → 502, not 429.
    const res = await fetch(`http://127.0.0.1:${pa.port}/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' }, body: '{}' });
    assert.notEqual(res.headers.get('x-teamai-429-reason'), 'concurrency_saturated');
    await res.text();
  } finally { proxy.close(); }
});

test('acquire-null 429 reports quota_exhausted when accounts are spent, not busy', async () => {
  const provider: Provider = {
    id: 'codex', label: 'Codex', upstreamBase: 'http://127.0.0.1:1',
    normalizePath: () => '/codex/responses', rewriteBody: (b) => b, readQuota: () => null, refresh: async (c) => c,
    buildHeaders: (h) => h, classifyFailure: () => ({ kind: 'fatal', retryAfterMs: 0 }),
  };
  const stored: StoredAccount = { id: 'a', provider: 'codex', label: 'a', enabled: true, priority: 1, credentialId: 'a', createdAt: '' };
  const pool = new AccountPool(provider, [stored], { a: { accessToken: 's', refreshToken: null, expiresAt: null, accountId: 'a' } }, { version: 1, accounts: {} }, 0.98, 1);
  pool.accounts[0]!.usage = 1; // spent, not busy
  const proxy = createProxy(pool, 'local-secret', () => {}, () => pool.totalCapacity());
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r)); const pa = proxy.address(); assert(pa && typeof pa !== 'string');
  try {
    const res = await fetch(`http://127.0.0.1:${pa.port}/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('x-teamai-429-reason'), 'quota_exhausted');
    const body = JSON.parse(await res.text()) as { error: string };
    assert.match(body.error, /1 used up the session window/);
  } finally { proxy.close(); }
});

test('acquire-null 429 for a Fable request names the spent Fable budgets, the earliest reset and that other models still work', async () => {
  const provider: Provider = {
    id: 'claude', label: 'Claude', upstreamBase: 'http://127.0.0.1:1',
    normalizePath: () => '/v1/messages', rewriteBody: (b) => b, readQuota: () => null, refresh: async (c) => c,
    buildHeaders: (h) => h, classifyFailure: () => ({ kind: 'fatal', retryAfterMs: 0 }),
    usesFableBudget: (_path, body) => /fable/i.test(body.toString()),
  };
  const stored = (id: string): StoredAccount => ({ id, provider: 'claude', label: `${id}@example.com`, enabled: true, priority: null, credentialId: id, createdAt: '' });
  const credential = (id: string): OAuthCredential => ({ accessToken: 's', refreshToken: null, expiresAt: null, accountId: id });
  const pool = new AccountPool(provider, [stored('a'), stored('b')], { a: credential('a'), b: credential('b') }, { version: 1, accounts: {} });
  const events: string[] = [];
  const now = Date.now();
  // a: Fable weekly spent, rolls over in ~3 days. b: still has Fable but its
  // session window is fully used and resets in ~9 minutes.
  pool.accounts[0]!.windows = { '7d_oi': { usage: 1, resetsAt: now + 3 * 24 * 3_600_000 }, '5h': { usage: 0.1, resetsAt: now + 3_600_000 } };
  pool.accounts[1]!.windows = { '7d_oi': { usage: 0.6, resetsAt: now + 6 * 24 * 3_600_000 }, '5h': { usage: 1, resetsAt: now + 9 * 60_000 } };
  pool.accounts[1]!.usage = 1; pool.accounts[1]!.resetsAt = now + 9 * 60_000;
  const proxy = createProxy(pool, 'local-secret', (e) => { if (e) events.push(e); });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r)); const pa = proxy.address(); assert(pa && typeof pa !== 'string');
  const call = (model: string) => fetch(`http://127.0.0.1:${pa.port}/v1/messages`, { method: 'POST', headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' }, body: JSON.stringify({ model }) });
  try {
    const res = await call('claude-fable-5-1');
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('x-teamai-429-reason'), 'quota_exhausted');
    assert.equal(res.headers.get('retry-after'), '540');
    const body = JSON.parse(await res.text()) as { error: string };
    assert.match(body.error, /^No Claude account can serve Fable right now \(2 accounts: 1 spent the Fable weekly budget, 1 used up the session window\)\./);
    assert.match(body.error, /Earliest reset in 9m: b@example\.com session\./);
    assert.match(body.error, /Other models are still served/);
    assert.ok(events.some((e) => /429 quota_exhausted \(fable\), next reset 9m/.test(e)), `activity log should record the 429: ${events.join(' | ')}`);
    // A non-Fable request is still routed to account a: it reaches the (unreachable)
    // upstream and fails over instead of being refused before dispatch.
    const opus = await call('claude-opus-5'); await opus.text();
    assert.ok(events.some((e) => /→ a@example\.com network error; failover/.test(e)), `non-Fable request should have tried account a: ${events.join(' | ')}`);
  } finally { proxy.close(); }
});

test('a transient 429 fails over without cooling down the account', async () => {
  // Upstream returns a transient 429 (no rejected quota window) with a long
  // retry-after. The account must NOT be benched at all — a request-rate 429
  // throttled onto the account would poison the fleet for unrelated requests.
  let hits = 0;
  const upstream = createServer(async (req, res) => {
    req.resume(); await new Promise<void>((r) => req.once('end', r));
    hits++;
    // First account: transient 429 with a 60s retry-after. Second: success.
    if (hits === 1) { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '60' }); res.end('{"error":"slow down"}'); }
    else { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: {}\n\n'); }
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r)); const up = upstream.address(); assert(up && typeof up !== 'string');
  const provider: Provider = {
    id: 'codex', label: 'Codex', upstreamBase: `http://127.0.0.1:${up.port}`,
    normalizePath: () => '/codex/responses', rewriteBody: (b) => b, readQuota: () => null, refresh: async (c) => c,
    buildHeaders: (incoming, account) => { const h = new Headers(incoming); h.set('authorization', `Bearer ${account.credential.accessToken}`); return h; },
    // A 429 with no rejected quota window classifies as transient.
    classifyFailure: (status) => status === 429 ? { kind: 'transient', retryAfterMs: 60_000 } : { kind: 'fatal', retryAfterMs: 0 },
  };
  const st = (id: string, priority: number): StoredAccount => ({ id, provider: 'codex', label: id, enabled: true, priority, credentialId: id, createdAt: '' });
  const cred = (id: string): OAuthCredential => ({ accessToken: `s-${id}`, refreshToken: null, expiresAt: null, accountId: id });
  const state: PersistedState = { version: 1, accounts: {} };
  const pool = new AccountPool(provider, [st('a', 1), st('b', 2)], { a: cred('a'), b: cred('b') }, state);
  const proxy = createProxy(pool, 'local-secret', () => {});
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r)); const pa = proxy.address(); assert(pa && typeof pa !== 'string');
  try {
    const res = await fetch(`http://127.0.0.1:${pa.port}/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 200, 'the transient 429 fails over to the second account'); await res.text();
    // Account 'a' got a transient 429 — it must be left immediately usable.
    const a = pool.accounts.find((x) => x.id === 'a')!;
    assert.equal(a.cooldownUntil, null, 'a transient 429 must not cool the account down');
    assert.equal(pool.acquire('next', new Set(), false)?.id, 'a', 'account a stays selectable right after a transient 429');
  } finally { proxy.close(); upstream.close(); }
});

test('a client that disconnects mid-stream releases its account slot and tears down the upstream stream', async () => {
  // Claude Code drops a streaming response whenever the user presses Esc, a
  // tool is cancelled or the client retries. The proxy used to wait for a
  // 'drain' that a destroyed response never emits, so every such abort leaked
  // one inflight slot on the account until the process was restarted.
  let upstreamClosed = false;
  const upstream = createServer(async (req, res) => {
    req.resume(); await new Promise<void>((r) => req.once('end', r));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const tick = setInterval(() => { if (!res.destroyed) res.write(`data: ${'x'.repeat(4096)}\n\n`); }, 2);
    res.once('close', () => { clearInterval(tick); upstreamClosed = true; });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r)); const up = upstream.address(); assert(up && typeof up !== 'string');
  const provider: Provider = {
    id: 'codex', label: 'Codex', upstreamBase: `http://127.0.0.1:${up.port}`,
    normalizePath: () => '/codex/responses', rewriteBody: (b) => b, readQuota: () => null, refresh: async (c) => c,
    buildHeaders: (incoming, account) => { const h = new Headers(incoming); h.set('authorization', `Bearer ${account.credential.accessToken}`); return h; },
    classifyFailure: () => ({ kind: 'fatal', retryAfterMs: 0 }),
  };
  const stored: StoredAccount = { id: 'a', provider: 'codex', label: 'a', enabled: true, priority: 1, credentialId: 'a', createdAt: '' };
  const state: PersistedState = { version: 1, accounts: {} };
  const pool = new AccountPool(provider, [stored], { a: { accessToken: 's', refreshToken: null, expiresAt: null, accountId: 'a' } }, state, 0.98, 1);
  const proxy = createProxy(pool, 'local-secret', () => {});
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r)); const pa = proxy.address(); assert(pa && typeof pa !== 'string');
  try {
    await new Promise<void>((resolve) => {
      const req = request({ host: '127.0.0.1', port: pa.port, path: '/v1/responses', method: 'POST', headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' } }, (res) => {
        res.once('data', () => { req.destroy(); resolve(); });
      });
      req.on('error', () => {}); req.end('{}');
    });
    const account = pool.accounts[0]!;
    const deadline = Date.now() + 2_000;
    while ((account.inflight > 0 || !upstreamClosed) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.equal(account.inflight, 0, 'inflight slot must be released after the client aborts');
    assert.equal(upstreamClosed, true, 'upstream stream must be cancelled, not left generating into the void');
  } finally { proxy.close(); upstream.close(); }
});

test('an account over the switch threshold still serves when no other account can', async () => {
  // 98% is where the pool prefers to switch, not a promise to strand the last
  // 2%. With every alternative spent, the request goes upstream on the account
  // over the threshold instead of being refused on a number we chose ourselves.
  const upstream = createServer(async (req, res) => { req.resume(); await new Promise<void>((r) => req.once('end', r)); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: {}\n\n'); });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r)); const up = upstream.address(); assert(up && typeof up !== 'string');
  const provider: Provider = {
    id: 'claude', label: 'Claude', upstreamBase: `http://127.0.0.1:${up.port}`,
    normalizePath: () => '/v1/messages', rewriteBody: (b) => b, readQuota: () => null, refresh: async (c) => c,
    buildHeaders: (h) => h, classifyFailure: () => ({ kind: 'fatal', retryAfterMs: 0 }),
    usesFableBudget: (_path, body) => /fable/i.test(body.toString()),
  };
  const stored = (id: string): StoredAccount => ({ id, provider: 'claude', label: `${id}@example.com`, enabled: true, priority: null, credentialId: id, createdAt: '' });
  const credential = (id: string): OAuthCredential => ({ accessToken: 's', refreshToken: null, expiresAt: null, accountId: id });
  const pool = new AccountPool(provider, [stored('a'), stored('b')], { a: credential('a'), b: credential('b') }, { version: 1, accounts: {} });
  const now = Date.now();
  pool.accounts[0]!.windows = { '7d_oi': { usage: 1, resetsAt: now + 3 * 24 * 3_600_000 } };
  pool.accounts[1]!.windows = { '7d_oi': { usage: 0.6, resetsAt: now + 6 * 24 * 3_600_000 }, '5h': { usage: 0.98, resetsAt: now + 9 * 60_000 } };
  pool.accounts[1]!.usage = 0.98; pool.accounts[1]!.resetsAt = now + 9 * 60_000;
  const events: string[] = [];
  const proxy = createProxy(pool, 'local-secret', (e) => { if (e) events.push(e); });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r)); const pa = proxy.address(); assert(pa && typeof pa !== 'string');
  try {
    const res = await fetch(`http://127.0.0.1:${pa.port}/v1/messages`, { method: 'POST', headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-fable-5-1' }) });
    await res.text();
    assert.equal(res.status, 200, 'must not refuse while b still has 2% of its window');
    assert.ok(events.some((e) => /→ b@example\.com 200/.test(e)), `request should have gone upstream on b: ${events.join(' | ')}`);
    assert.equal(pool.accounts[1]!.inflight, 0);
  } finally { proxy.close(); upstream.close(); }
});

// A fake upstream that records which account each request reached, keyed by
// whichever header the real provider stamps on it (Claude: the bearer token,
// Codex: chatgpt-account-id), and answers 200 with an SSE body.
async function recordingUpstream(pick: (headers: Record<string, string | string[] | undefined>) => string | undefined): Promise<{ port: number; seen: string[]; close: () => void }> {
  const seen: string[] = [];
  const upstream = createServer(async (req, res) => {
    req.resume(); await new Promise<void>((r) => req.once('end', r));
    seen.push(pick(req.headers) ?? '?');
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: {}\n\n');
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r)); const address = upstream.address(); assert(address && typeof address !== 'string');
  return { port: address.port, seen, close: () => upstream.close() };
}

test('a Claude Code session stays on one account across connections', async () => {
  // Captured live: Claude Code names its session in an x-claude-code-session-id
  // header and again inside metadata.user_id. Node's fetch opens a fresh socket
  // per request here, so a relay keyed by connection would spread these four
  // requests over the fleet and cold-start the prompt cache each time.
  const up = await recordingUpstream((h) => String(h.authorization).replace('Bearer s-', ''));
  const provider: Provider = { ...claudeProvider, upstreamBase: `http://127.0.0.1:${up.port}`, readQuota: () => null, refresh: async (c) => c };
  const st = (id: string): StoredAccount => ({ id, provider: 'claude', label: id, enabled: true, priority: null, credentialId: id, createdAt: '' });
  const cred = (id: string): OAuthCredential => ({ accessToken: `s-${id}`, refreshToken: null, expiresAt: null, accountId: id });
  const pool = new AccountPool(provider, [st('a'), st('b'), st('c')], { a: cred('a'), b: cred('b'), c: cred('c') }, { version: 1, accounts: {} });
  const proxy = createProxy(pool, 'local-secret', () => {});
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r)); const pa = proxy.address(); assert(pa && typeof pa !== 'string');
  const send = async (headers: Record<string, string>, body: string): Promise<void> => { const res = await fetch(`http://127.0.0.1:${pa.port}/v1/messages?beta=true`, { method: 'POST', headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json', ...headers }, body }); assert.equal(res.status, 200); await res.text(); };
  try {
    for (let i = 0; i < 3; i++) await send({ 'x-claude-code-session-id': 'sess-1' }, '{}');
    // No header: the same id inside metadata.user_id must reach the same account.
    await send({}, JSON.stringify({ metadata: { user_id: JSON.stringify({ device_id: 'd', account_uuid: '', session_id: 'sess-1' }) } }));
    assert.equal(up.seen.length, 4);
    assert.equal(new Set(up.seen).size, 1, `one session, one account — got ${up.seen.join(',')}`);
  } finally { proxy.close(); up.close(); }
});

test('a Codex session stays on one account across connections', async () => {
  // Captured live from `codex exec`: a plain session-id header, plus
  // x-codex-window-id carrying the same id with a :N window suffix.
  const up = await recordingUpstream((h) => String(h['chatgpt-account-id']));
  const provider: Provider = { ...codexProvider, upstreamBase: `http://127.0.0.1:${up.port}`, readQuota: () => null, refresh: async (c) => c };
  const st = (id: string): StoredAccount => ({ id, provider: 'codex', label: id, enabled: true, priority: null, credentialId: id, createdAt: '' });
  const cred = (id: string): OAuthCredential => ({ accessToken: `s-${id}`, refreshToken: null, expiresAt: null, accountId: id });
  const pool = new AccountPool(provider, [st('a'), st('b'), st('c')], { a: cred('a'), b: cred('b'), c: cred('c') }, { version: 1, accounts: {} });
  const proxy = createProxy(pool, 'local-secret', () => {});
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r)); const pa = proxy.address(); assert(pa && typeof pa !== 'string');
  const send = async (headers: Record<string, string>): Promise<void> => { const res = await fetch(`http://127.0.0.1:${pa.port}/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json', ...headers }, body: '{}' }); assert.equal(res.status, 200); await res.text(); };
  try {
    await send({ 'session-id': 'thread-1' }); await send({ 'session-id': 'thread-1' });
    await send({ 'x-codex-window-id': 'thread-1:0' });
    assert.equal(up.seen.length, 3);
    assert.equal(new Set(up.seen).size, 1, `one session, one account — got ${up.seen.join(',')}`);
  } finally { proxy.close(); up.close(); }
});

test('a transient 429 spills one request elsewhere without re-homing the session', async () => {
  // The first request to account a is throttled, so it fails over to b. That
  // is a one-request diversion: the session's next request must come back to
  // a, whose prompt cache is the one that is warm.
  const seen: string[] = []; let throttled = false;
  const upstream = createServer(async (req, res) => {
    req.resume(); await new Promise<void>((r) => req.once('end', r));
    const account = String(req.headers.authorization).replace('Bearer s-', ''); seen.push(account);
    if (account === 'a' && !throttled) { throttled = true; res.writeHead(429, { 'content-type': 'application/json' }); res.end('{"error":"slow down"}'); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: {}\n\n');
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r)); const up = upstream.address(); assert(up && typeof up !== 'string');
  const provider: Provider = {
    id: 'codex', label: 'Codex', upstreamBase: `http://127.0.0.1:${up.port}`,
    normalizePath: () => '/codex/responses', rewriteBody: (b) => b, readQuota: () => null, refresh: async (c) => c,
    buildHeaders: (incoming, account) => { const h = new Headers(incoming); h.set('authorization', `Bearer ${account.credential.accessToken}`); return h; },
    classifyFailure: (status) => status === 429 ? { kind: 'transient', retryAfterMs: 60_000 } : { kind: 'fatal', retryAfterMs: 0 },
    sessionKey: (headers) => headers.get('session-id'),
  };
  const st = (id: string, priority: number): StoredAccount => ({ id, provider: 'codex', label: id, enabled: true, priority, credentialId: id, createdAt: '' });
  const cred = (id: string): OAuthCredential => ({ accessToken: `s-${id}`, refreshToken: null, expiresAt: null, accountId: id });
  const pool = new AccountPool(provider, [st('a', 1), st('b', 2)], { a: cred('a'), b: cred('b') }, { version: 1, accounts: {} });
  const proxy = createProxy(pool, 'local-secret', () => {});
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r)); const pa = proxy.address(); assert(pa && typeof pa !== 'string');
  try {
    for (let i = 0; i < 2; i++) { const res: Response = await fetch(`http://127.0.0.1:${pa.port}/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json', 'session-id': 't1' }, body: '{}' }); assert.equal(res.status, 200); await res.text(); }
    assert.deepEqual(seen, ['a', 'b', 'a']);
  } finally { proxy.close(); upstream.close(); }
});
