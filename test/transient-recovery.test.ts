import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { AccountPool } from '../src/account-pool.js';
import { codexProvider } from '../src/providers.js';
import { createProxy } from '../src/proxy.js';

for (const scenario of ['recover', 'bounded', 'long-wait', 'forbidden', 'cancel'] as const) {
  test(`one usable Codex account: ${scenario}`, async () => {
    let calls = 0;
    const events: string[] = [];
    const upstream = createServer((req, res) => {
      req.resume(); calls++;
      if (scenario === 'recover' && calls === 2) { res.writeHead(200); res.end('recovered'); return; }
      res.writeHead(scenario === 'forbidden' ? 403 : 503, { 'content-type': 'application/json', 'retry-after': scenario === 'long-wait' ? '120' : '1' });
      res.end('{"error":{"code":"synthetic_failure"}}');
    });
    await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));
    const address = upstream.address(); assert(address && typeof address !== 'string');
    const ids = ['available', 'spent1', 'spent2', 'spent3'];
    const pool = new AccountPool({ ...codexProvider, upstreamBase: `http://127.0.0.1:${address.port}`, refresh: async c => c },
      ids.map((id, priority) => ({ id, provider: 'codex', label: id, enabled: true, priority, credentialId: id, createdAt: '' })),
      Object.fromEntries(ids.map(id => [id, { accessToken: 'synthetic', refreshToken: null, expiresAt: null, accountId: id }])),
      { version: 1, accounts: Object.fromEntries(ids.map((id, i) => [id, { usage: i ? 1 : 0.29, resetsAt: Date.now() + 3600_000, cooldownUntil: null, lastUsed: null, error: null }])) });
    const proxy = createProxy(pool, 'synthetic', e => { if (e) events.push(e); });
    await new Promise<void>(r => proxy.listen(0, '127.0.0.1', r));
    const pa = proxy.address(); assert(pa && typeof pa !== 'string');
    const abort = new AbortController();
    try {
      const pending = fetch(`http://127.0.0.1:${pa.port}/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer synthetic' }, body: '{"model":"gpt-6-astra"}', signal: abort.signal });
      if (scenario === 'cancel') {
        const rejection = assert.rejects(pending, { name: 'AbortError' });
        for (let i = 0; i < 100 && !events.some(e => e.includes('transient retry')); i++) await new Promise(r => setTimeout(r, 10));
        assert(events.some(e => e.includes('transient retry')));
        abort.abort(); await rejection;
        for (let i = 0; i < 100 && pool.inFlightProxied; i++) await new Promise(r => setTimeout(r, 10));
        assert.equal(pool.inFlightProxied, 0); assert.equal(calls, 1);
      } else {
        const res = await pending;
        assert.equal(res.status, scenario === 'recover' ? 200 : scenario === 'forbidden' ? 403 : 503);
        assert.equal(res.headers.get('x-teamai-429-reason'), null);
        assert.equal(await res.text(), scenario === 'recover' ? 'recovered' : '{"error":{"code":"synthetic_failure"}}');
        assert.equal(calls, scenario === 'recover' ? 2 : scenario === 'bounded' ? 3 : 1);
        if (scenario === 'long-wait') assert.equal(res.headers.get('retry-after'), '120');
      }
      assert.equal(pool.accounts[0]!.usage, 0.29);
      assert(events.every(e => !e.includes('fable') && !e.includes('quota_exhausted')));
      assert(pool.accounts.every(a => a.inflight === 0));
    } finally { proxy.closeAllConnections(); upstream.closeAllConnections(); await Promise.all([new Promise<void>(r => proxy.close(() => r())), new Promise<void>(r => upstream.close(() => r()))]); }
  });
}

test('Codex distinguishes temporary rate limits, quota and missing measurements', () => {
  assert.equal(codexProvider.readQuota(new Headers()), null);
  for (const code of ['slow_down', 'rate_limit_exceeded']) {
    const d = codexProvider.classifyFailure(429, new Headers({ 'retry-after': '3' }), JSON.stringify({ error: { code } }));
    assert.equal(d.kind, 'transient'); assert.equal(d.retryAfterMs, 3000);
  }
  assert.equal(codexProvider.classifyFailure(429, new Headers(), '{"error":{"type":"usage_limit_reached"}}').kind, 'quota');
  assert.equal(codexProvider.classifyFailure(429, new Headers({ 'x-codex-primary-used-percent': '100' }), '{}').kind, 'quota');
  assert.equal(codexProvider.classifyFailure(503, new Headers({ 'retry-after': '120' }), '').retryAfterMs, 120_000);
});

// The retry rounds are per request, not per account: with N usable accounts
// all failing transiently, each round tries every one of them again, so the
// worst case is 3N upstream attempts (the first pass plus two retry rounds).
// The handoff doc states this bound; this pins it so a change to the loop
// that silently multiplies it is caught.
test('every usable account failing transiently is bounded at three passes over the pool', async () => {
  let calls = 0;
  const upstream = createServer((req, res) => { req.resume(); calls++; res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '1' }); res.end('{"error":{"code":"synthetic_failure"}}'); });
  await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));
  const address = upstream.address(); assert(address && typeof address !== 'string');
  const ids = ['a', 'b', 'c', 'd'];
  const pool = new AccountPool({ ...codexProvider, upstreamBase: `http://127.0.0.1:${address.port}`, refresh: async c => c },
    ids.map((id, priority) => ({ id, provider: 'codex', label: id, enabled: true, priority, credentialId: id, createdAt: '' })),
    Object.fromEntries(ids.map(id => [id, { accessToken: 'synthetic', refreshToken: null, expiresAt: null, accountId: id }])),
    { version: 1, accounts: {} });
  const proxy = createProxy(pool, 'synthetic', () => {});
  await new Promise<void>(r => proxy.listen(0, '127.0.0.1', r)); const pa = proxy.address(); assert(pa && typeof pa !== 'string');
  try {
    const res = await fetch(`http://127.0.0.1:${pa.port}/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer synthetic' }, body: '{"model":"gpt-6-astra"}' });
    assert.equal(res.status, 503); await res.text();
    assert.equal(calls, 3 * ids.length, 'first pass plus two retry rounds over every account');
    assert(pool.accounts.every(a => a.inflight === 0 && a.cooldownUntil === null), 'a transient failure never benches an account');
  } finally { proxy.closeAllConnections(); upstream.closeAllConnections(); await Promise.all([new Promise<void>(r => proxy.close(() => r())), new Promise<void>(r => upstream.close(() => r()))]); }
});

// Mixed failures: the usable account is transient, the next one is genuinely
// out of quota. The last failure decides what the client sees, but the
// transient account keeps its retry rounds — the quota rejection must not
// short-circuit them into a quota 429, and the quota account must not be
// re-tried once benched.
test('a quota rejection after a transient failure neither masks the transient nor is retried', async () => {
  const hits: string[] = [];
  const upstream = createServer((req, res) => {
    req.resume(); const account = String(req.headers['chatgpt-account-id']); hits.push(account);
    if (account === 'spent') { res.writeHead(429, { 'content-type': 'application/json' }); res.end('{"error":{"type":"usage_limit_reached"}}'); return; }
    if (hits.filter(h => h === 'flaky').length < 2) { res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '1' }); res.end('{"error":{"code":"synthetic_failure"}}'); return; }
    res.writeHead(200); res.end('recovered');
  });
  await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));
  const address = upstream.address(); assert(address && typeof address !== 'string');
  const ids = ['flaky', 'spent'];
  const pool = new AccountPool({ ...codexProvider, upstreamBase: `http://127.0.0.1:${address.port}`, refresh: async c => c },
    ids.map((id, priority) => ({ id, provider: 'codex', label: id, enabled: true, priority, credentialId: id, createdAt: '' })),
    Object.fromEntries(ids.map(id => [id, { accessToken: 'synthetic', refreshToken: null, expiresAt: null, accountId: id }])),
    { version: 1, accounts: {} });
  const events: string[] = [];
  const proxy = createProxy(pool, 'synthetic', e => { if (e) events.push(e); });
  await new Promise<void>(r => proxy.listen(0, '127.0.0.1', r)); const pa = proxy.address(); assert(pa && typeof pa !== 'string');
  try {
    const res = await fetch(`http://127.0.0.1:${pa.port}/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer synthetic' }, body: '{"model":"gpt-6-astra"}' });
    assert.equal(res.status, 200); assert.equal(await res.text(), 'recovered');
    assert.deepEqual(hits, ['flaky', 'spent', 'flaky'], 'the transient account is retried after the round, the spent one is not');
    const spent = pool.accounts.find(a => a.id === 'spent')!; assert(spent.cooldownUntil && spent.cooldownUntil > Date.now(), 'the quota account is benched');
    assert.equal(pool.accounts.find(a => a.id === 'flaky')!.cooldownUntil, null);
    assert(events.some(e => e.includes('transient retry')));
  } finally { proxy.closeAllConnections(); upstream.closeAllConnections(); await Promise.all([new Promise<void>(r => proxy.close(() => r())), new Promise<void>(r => upstream.close(() => r()))]); }
});
