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

// The pool ranks Fable requests on the Fable window and everything else on the
// general one. Without the split, an Opus turn lands on whichever account has
// the most Fable left — the one account that still needs protecting.
const fableFleet = () => {
  const ids = ['spare', 'reserved'];
  const stored = ids.map((id) => account(id));
  const credentials = Object.fromEntries(ids.map((id) => [`codex:${id}`, credential(id)]));
  const win = (general: number, fable: number) => ({
    usage: general, resetsAt: null,
    windows: { '7d': { usage: general, resetsAt: null }, '7d_oi': { usage: fable, resetsAt: null } },
    profile: null, cooldownUntil: null, lastUsed: null, error: null,
  });
  // 'reserved' looks best on the Fable window and worst on the general one.
  return new AccountPool(provider, stored, credentials, {
    version: 1, accounts: { 'codex:spare': win(0.55, 1), 'codex:reserved': win(0.05, 0.04) },
  }, 0.98, 3, 0.8);
};

test('non-Fable traffic prefers an account whose Fable budget is spent', () => {
  assert.equal(fableFleet().acquire('s', new Set(), false)?.id, 'spare');
});

test('Fable traffic still goes to the account with Fable left', () => {
  assert.equal(fableFleet().acquire('s', new Set(), true)?.id, 'reserved');
});

test('session affinity does not drag non-Fable turns onto a reserved account', () => {
  const pool = fableFleet();
  const first = pool.acquire('shared', new Set(), true); assert.equal(first?.id, 'reserved'); pool.release(first!);
  // Same session, different model: the pin must not win here.
  assert.equal(pool.acquire('shared', new Set(), false)?.id, 'spare');
});

test('non-Fable falls back to a reserved account when spent ones are unavailable', () => {
  const pool = fableFleet();
  pool.accounts.find((a) => a.id === 'spare')!.cooldownUntil = Date.now() + 60_000;
  assert.equal(pool.acquire('s', new Set(), false)?.id, 'reserved');
});

test('a threshold of 1 disables the split', () => {
  const ids = ['spare', 'reserved'];
  const stored = ids.map((id) => account(id));
  const credentials = Object.fromEntries(ids.map((id) => [`codex:${id}`, credential(id)]));
  const win = (general: number, fable: number) => ({
    usage: general, resetsAt: null,
    windows: { '7d': { usage: general, resetsAt: null }, '7d_oi': { usage: fable, resetsAt: null } },
    profile: null, cooldownUntil: null, lastUsed: null, error: null,
  });
  const pool = new AccountPool(provider, stored, credentials, {
    version: 1, accounts: { 'codex:spare': win(0.55, 1), 'codex:reserved': win(0.05, 0.04) },
  }, 0.98, 3, 1);
  // With the reserve off, a spent Fable window is no longer a tier, so ranking
  // falls back to least-spent on the general window.
  assert.equal(pool.acquire('s', new Set(), false)?.id, 'reserved');
});

test('an unmeasured Fable window is not assumed spent', () => {
  const ids = ['unmeasured', 'spent'];
  const stored = ids.map((id) => account(id));
  const credentials = Object.fromEntries(ids.map((id) => [`codex:${id}`, credential(id)]));
  const pool = new AccountPool(provider, stored, credentials, {
    version: 1, accounts: {
      'codex:unmeasured': { usage: 0.1, resetsAt: null, windows: { '7d': { usage: 0.1, resetsAt: null } }, profile: null, cooldownUntil: null, lastUsed: null, error: null },
      'codex:spent': { usage: 0.6, resetsAt: null, windows: { '7d': { usage: 0.6, resetsAt: null }, '7d_oi': { usage: 1, resetsAt: null } }, profile: null, cooldownUntil: null, lastUsed: null, error: null },
    },
  }, 0.98, 3, 0.8);
  // 'unmeasured' is cheaper on the general window, but its Fable budget is
  // unknown — a known-spent account is the safer home for non-Fable traffic.
  assert.equal(pool.acquire('s', new Set(), false)?.id, 'spent');
});

test('markFableSpent records the window without benching the account', () => {
  const pool = new AccountPool(provider, [account('a')], { 'codex:a': credential('a') }, {
    version: 1, accounts: { 'codex:a': { usage: 0.2, resetsAt: null, windows: { '7d': { usage: 0.2, resetsAt: null }, '7d_oi': { usage: 0.5, resetsAt: 123 } }, profile: null, cooldownUntil: null, lastUsed: null, error: null } },
  }, 0.98, 3, 0.8);
  const acct = pool.accounts[0]!;
  pool.markFableSpent(acct, 60_000);
  assert.equal(AccountPool.fableWindow(acct)?.usage, 1);
  assert.equal(AccountPool.fableWindow(acct)?.resetsAt, 123, 'keeps the real reset when upstream reported one');
  assert.equal(acct.cooldownUntil, null, 'the account stays available for other models');
  // Still selectable for non-Fable work — the whole point of not benching it.
  assert.equal(pool.acquire('s', new Set(), false)?.id, 'a');
});

test('refreshLapsed refreshes errored and expiring accounts, skips healthy ones', async () => {
  const refreshed: string[] = [];
  const p: Provider = { ...provider, refresh: async (c) => { refreshed.push(c.accountId!); return c; } };
  const now = Date.now();
  const cred = (id: string, expiresAt: number | null): OAuthCredential => ({ accessToken: 't', refreshToken: 'r', expiresAt, accountId: id });
  const pool = new AccountPool(p, [account('err'), account('soon'), account('healthy'), account('notoken')],
    { 'codex:err': cred('err', now + 60 * 60_000), 'codex:soon': cred('soon', now + 60_000), 'codex:healthy': cred('healthy', now + 60 * 60_000), 'codex:notoken': { accessToken: 't', refreshToken: null, expiresAt: now + 60_000, accountId: 'notoken' } }, state);
  pool.accounts.find((a) => a.id === 'err')!.error = 'boom';
  const count = await pool.refreshLapsed();
  assert.equal(count, 2);
  assert.deepEqual(refreshed.sort(), ['err', 'soon']); // healthy skipped; notoken has no refresh token
});

test('refreshLapsed runs sequentially — never two token refreshes at once', async () => {
  let active = 0; let peak = 0;
  const p: Provider = { ...provider, refresh: async (c) => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 40)); active--; return c; } };
  const cred = (id: string): OAuthCredential => ({ accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 60_000, accountId: id });
  const ids = ['a', 'b', 'c', 'd'];
  const pool = new AccountPool(p, ids.map((id) => account(id)), Object.fromEntries(ids.map((id) => [`codex:${id}`, cred(id)])), state);
  await pool.refreshLapsed();
  assert.equal(peak, 1, 'a burst of concurrent refreshes would rate-limit the token endpoint');
});

test('refreshLapsed forces refresh when the expiry is unknown', async () => {
  let forced: boolean | undefined;
  const p: Provider = { ...provider, refresh: async (c) => c };
  const pool = new AccountPool(p, [account('x')], { 'codex:x': { accessToken: 't', refreshToken: 'r', expiresAt: null, accountId: 'x' } }, state);
  // No error set: isolate the null-expiry path so this proves the expiry gate,
  // not the error gate.
  const orig = pool.refresh.bind(pool);
  pool.refresh = (a, force) => { forced = force; return orig(a, force); };
  await pool.refreshLapsed();
  assert.equal(forced, true, 'a null expiry never trips refresh()\'s own gate, so it must be forced');
});

test('probe template survives a restart via exported state', async () => {
  const { claudeProvider } = await import('../src/providers.js');
  const cred: OAuthCredential = { accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 60_000, accountId: 'u1' };
  const stored: StoredAccount = { id: 'claude:u1', provider: 'claude', label: 'u1', enabled: true, priority: null, credentialId: 'claude:u1', createdAt: '' };
  const pool = new AccountPool(claudeProvider, [stored], { 'claude:u1': cred }, { version: 1, accounts: {} });
  assert.equal(pool.hasProbe(), false, 'no template before any traffic');
  // Feed a genuine accepted /v1/messages so captureProbe commits a template.
  const reqHeaders = new Headers({ 'anthropic-version': '2023-06-01', 'user-agent': 'claude-cli/2.1.276 (external, cli)' });
  const body = Buffer.from(JSON.stringify({ model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'x' }] }));
  pool.commitProbe('/v1/messages', reqHeaders, body, new Headers());
  assert.equal(pool.hasProbe(), true, 'template captured from live traffic');

  const exported: PersistedState = { version: 1, accounts: {} };
  pool.exportState(exported);
  assert.ok(exported.probes?.claude, 'template is written into the snapshot');

  // A fresh pool built from that snapshot must not fall back to defaultProbe.
  const revived = new AccountPool(claudeProvider, [stored], { 'claude:u1': cred }, exported);
  assert.equal(revived.hasProbe(), true, 'restarted proxy keeps the learned template');
});

test('exportState omits probes when none was learned', () => {
  const pool = new AccountPool(provider, [account('a')], { 'codex:a': credential('a') }, state);
  const exported: PersistedState = { version: 1, accounts: {} };
  pool.exportState(exported);
  assert.equal(exported.probes, undefined, 'nothing to persist means no probes key');
});

test('a restart does not restore cooldown or error, but keeps quota', () => {
  // A saved snapshot where the account is cooled down and errored, yet its
  // long-lived quota shows plenty of room.
  const saved: PersistedState = { version: 1, accounts: { 'codex:a': {
    usage: 0.3, resetsAt: null, windows: { '7d': { usage: 0.3, resetsAt: null } },
    profile: null, cooldownUntil: Date.now() + 7 * 24 * 60 * 60_000, lastUsed: 123, error: 'old failure',
  } } };
  const pool = new AccountPool(provider, [account('a')], { 'codex:a': credential('a') }, saved);
  const acct = pool.accounts[0]!;
  // Cooldown and error are per-response signals — a restart must not re-bench.
  assert.equal(acct.cooldownUntil, null, 'a stale cooldown must not survive a restart');
  assert.equal(acct.error, null, 'a stale error must not survive a restart');
  // Quota is long-lived — it must survive so the dashboard/ranking need no re-measure.
  assert.equal(acct.usage, 0.3);
  assert.equal(acct.windows['7d']?.usage, 0.3);
  // And the account is therefore immediately selectable, not parked.
  assert.equal(pool.acquire('s')?.id, 'a');
});
