import assert from 'node:assert/strict';
import test from 'node:test';
import { AccountPool } from '../src/account-pool.js';
import type { OAuthCredential, PersistedState, Provider, StoredAccount } from '../src/types.js';

const provider: Provider = {
  id: 'codex', label: 'Codex', upstreamBase: 'https://example.test', normalizePath: (p) => p,
  buildHeaders: (h) => h, rewriteBody: (b) => b, readQuota: () => null,
  classifyFailure: () => ({ kind: 'fatal', retryAfterMs: 0 }), refresh: async (c) => c,
};
const credential = (id: string): OAuthCredential => ({ accessToken: `token-${id}`, refreshToken: 'refresh', expiresAt: Date.now() + 60_000, accountId: id });
const account = (id: string, priority: number | null = null): StoredAccount => ({ id, provider: 'codex', label: id, enabled: true, priority, credentialId: `codex:${id}`, createdAt: new Date().toISOString() });
const state: PersistedState = { version: 1, accounts: {} };

test('selects explicit priority and keeps session affinity', () => {
  const pool = new AccountPool(provider, [account('a', 2), account('b', 1)], { 'codex:a': credential('a'), 'codex:b': credential('b') }, state, 0.98, 3);
  const first = pool.acquire('session'); assert.equal(first?.id, 'b'); pool.release(first!);
  pool.accounts[0]!.priority = 0;
  const second = pool.acquire('session'); assert.equal(second?.id, 'b');
});

test('skips quota, disabled, cooldown, and capped accounts', () => {
  const pool = new AccountPool(provider, [account('a'), account('b')], { 'codex:a': credential('a'), 'codex:b': credential('b') }, state, 0.98, 1);
  pool.accounts[0]!.usage = 1;
  const chosen = pool.acquire('s'); assert.equal(chosen?.id, 'b');
  assert.equal(pool.acquire('other'), null);
  pool.release(chosen!); pool.cooldown(chosen!, 10_000);
  assert.equal(pool.acquire('third'), null);
});

test('exports credential-free runtime state', () => {
  const pool = new AccountPool(provider, [account('a')], { 'codex:a': credential('a') }, state);
  pool.accounts[0]!.usage = 0.7;
  const output: PersistedState = { version: 1, accounts: {} }; pool.exportState(output);
  assert.equal(output.accounts['codex:a']?.usage, 0.7);
  assert.equal(JSON.stringify(output).includes('token-a'), false);
});

test('selects the least-spent account, judged on the Fable window when present', () => {
  const ids = ['a', 'b', 'c'];
  const stored = ids.map((id) => account(id));
  const credentials = Object.fromEntries(ids.map((id) => [`codex:${id}`, credential(id)]));
  const win = (overall: number, fable: number) => ({ usage: overall, resetsAt: null, windows: { '7d': { usage: overall, resetsAt: null }, '7d_oi': { usage: fable, resetsAt: null } }, profile: null, cooldownUntil: null, lastUsed: null, error: null });
  const pool = new AccountPool(provider, stored, credentials, {
    version: 1, accounts: {
      // Lowest overall, but its Fable bucket is spent — it must not win.
      'codex:a': win(0.1, 1),
      // Highest overall, yet Fable is barely touched.
      'codex:b': win(0.9, 0.2),
      'codex:c': win(0.5, 0.6),
    },
  });
  assert.equal(pool.acquire('s1')?.id, 'b');
});

test('a fully spent fleet is ordered by which account frees up soonest', () => {
  const stored = ['later', 'sooner'].map((id) => account(id));
  const credentials = { 'codex:later': credential('later'), 'codex:sooner': credential('sooner') };
  const hour = 60 * 60_000;
  // Deliberately gives the LATER account the lower weekly usage: once both are
  // spent, time-to-reset is what matters, not who used less getting there.
  const spent = (resetsIn: number, weekly: number) => ({ usage: weekly, resetsAt: Date.now() + resetsIn, windows: { '7d_oi': { usage: 1, resetsAt: Date.now() + resetsIn } }, profile: null, cooldownUntil: null, lastUsed: null, error: null });
  const pool = new AccountPool(provider, stored, credentials, { version: 1, accounts: { 'codex:later': spent(100 * hour, 0.3), 'codex:sooner': spent(12 * hour, 0.9) } });
  assert.equal(pool.acquire('s1')?.id, 'sooner');
});

test('a near-spent Codex fleet ranks on its own main window reset', () => {
  const stored = ['a', 'b'].map((id) => account(id));
  const credentials = { 'codex:a': credential('a'), 'codex:b': credential('b') };
  const hour = 60 * 60_000;
  // Just under switchThreshold, so both remain selectable and the comparison
  // is the reset time rather than availability.
  const nearlySpent = (resetsIn: number) => ({ usage: 0.97, resetsAt: null, windows: { primary: { usage: 0.97, resetsAt: Date.now() + resetsIn } }, profile: null, cooldownUntil: null, lastUsed: null, error: null });
  const pool = new AccountPool(provider, stored, credentials, { version: 1, accounts: { 'codex:a': nearlySpent(120 * hour), 'codex:b': nearlySpent(48 * hour) } });
  assert.equal(pool.acquire('s1')?.id, 'b');
});

test('byHeadroom still orders accounts the pool would refuse to route to', () => {
  // The dashboard ranks every account, including ones past the threshold, so
  // the comparator itself must order a fully spent fleet by reset time.
  const hour = 60 * 60_000;
  const spent = (id: string, resetsIn: number) => ({
    ...account(id), credential: credential(id), usage: 1, resetsAt: Date.now() + resetsIn,
    windows: { primary: { usage: 1, resetsAt: Date.now() + resetsIn } },
    profile: null, cooldownUntil: null, lastUsed: null, error: null, inflight: 0,
  });
  const later = spent('later', 120 * hour); const sooner = spent('sooner', 48 * hour);
  assert.ok(AccountPool.byHeadroom(sooner, later) < 0);
  assert.ok(AccountPool.byHeadroom(later, sooner) > 0);
});

test('an unmeasured account sorts last, not first', () => {
  const stored = ['known', 'unknown'].map((id) => account(id));
  const credentials = { 'codex:known': credential('known'), 'codex:unknown': credential('unknown') };
  const pool = new AccountPool(provider, stored, credentials, {
    version: 1, accounts: { 'codex:known': { usage: 0.7, resetsAt: null, windows: {}, profile: null, cooldownUntil: null, lastUsed: null, error: null } },
  });
  assert.equal(pool.acquire('s1')?.id, 'known');
});
