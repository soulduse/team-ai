import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { AccountPool } from '../src/account-pool.js';
import { createProxy } from '../src/proxy.js';
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
    await res.text();
  } finally { proxy.close(); }
});
