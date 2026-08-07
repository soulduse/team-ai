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
