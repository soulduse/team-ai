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
  // Ranking only — a Fable request would exclude both fully-spent accounts (see
  // the skip test below), so this checks the comparator the dashboard uses.
  const hour = 60 * 60_000;
  const spent = (id: string, resetsIn: number, weekly: number) => ({
    ...account(id), credential: credential(id), usage: weekly, resetsAt: Date.now() + resetsIn,
    windows: { '7d_oi': { usage: 1, resetsAt: Date.now() + resetsIn } },
    profile: null, cooldownUntil: null, cooldownReason: null, lastUsed: null, error: null, inflight: 0,
  });
  // The LATER account has the lower weekly usage on purpose: once both are
  // spent, time-to-reset decides, not who used less getting there.
  const later = spent('later', 100 * hour, 0.3); const sooner = spent('sooner', 12 * hour, 0.9);
  assert.ok(AccountPool.byHeadroom(sooner, later) < 0);
  assert.ok(AccountPool.byHeadroom(later, sooner) > 0);
});

test('a Fable request skips accounts whose Fable window is fully spent', () => {
  const stored = ['spent', 'has-fable'].map((id) => account(id));
  const credentials = { 'codex:spent': credential('spent'), 'codex:has-fable': credential('has-fable') };
  const win = (fable: number, weekly: number) => ({ usage: weekly, resetsAt: null, windows: { '7d': { usage: weekly, resetsAt: null }, '7d_oi': { usage: fable, resetsAt: null } }, profile: null, cooldownUntil: null, lastUsed: null, error: null });
  const pool = new AccountPool(provider, stored, credentials, { version: 1, accounts: { 'codex:spent': win(1, 0.2), 'codex:has-fable': win(0.4, 0.9) } });
  // Fable request: the 100%-Fable account is skipped even though its weekly is
  // lower — it could only 429. The one with Fable left wins despite higher weekly.
  assert.equal(pool.acquire('s1', new Set(), true)?.id, 'has-fable');
  // Every account's Fable spent → a Fable request gets nothing rather than
  // burning a real 429 on each.
  const allSpent = new AccountPool(provider, stored, credentials, { version: 1, accounts: { 'codex:spent': win(1, 0.2), 'codex:has-fable': win(1, 0.4) } });
  assert.equal(allSpent.acquire('s2', new Set(), true), null);
  // A non-Fable request still uses them — that spent-Fable budget is irrelevant.
  assert.equal(allSpent.acquire('s3', new Set(), false)?.id, 'spent');
});

test('a per-account cap of 0 means unlimited concurrency', () => {
  const pool = new AccountPool(provider, [account('a')], { 'codex:a': credential('a') }, state, 0.98, 0);
  pool.accounts[0]!.inflight = 99;
  assert.equal(pool.acquire('s')?.id, 'a', 'no cap should gate the account');
  assert.equal(pool.totalCapacity(), Number.MAX_SAFE_INTEGER);
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
    profile: null, cooldownUntil: null, cooldownReason: null, lastUsed: null, error: null, inflight: 0,
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
  assert.deepEqual(count, { healed: 2, failed: 0 });
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

test('new sessions spread across accounts whose load is within the same 10% step', () => {
  // Weekly figures a point apart (51%..57%) used to herd every new session onto
  // the lowest one until its figure crept past the next — a tenth of a percent
  // per request. Inside a 10% step the account with fewer requests in flight
  // wins, so four sessions land on four accounts.
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const pool = new AccountPool(provider, ids.map((id) => account(id)), Object.fromEntries(ids.map((id) => [`codex:${id}`, credential(id)])), { version: 1, accounts: {} }, 0.98, 16);
  const now = Date.now();
  pool.accounts.forEach((a, i) => { a.windows = { '7d': { usage: 0.51 + i * 0.01, resetsAt: now + 86_400_000 }, '7d_oi': { usage: 1, resetsAt: now + 86_400_000 }, '5h': { usage: 0, resetsAt: now + 3_600_000 } }; a.usage = 0.51 + i * 0.01; });
  const picked = ['s1', 's2', 's3', 's4'].map((s) => pool.acquire(s, new Set(), false)!.id);
  assert.equal(new Set(picked).size, 4, `four sessions should not share an account: ${picked.join(',')}`);
  // The pinned session keeps its account across turns (prompt-cache locality).
  pool.release(pool.accounts.find((a) => a.id === picked[0])!);
  assert.equal(pool.acquire('s1', new Set(), false)!.id, picked[0]);
});

test('the 5-hour session window counts toward load, not just the weekly budget', () => {
  // x is lighter on the week but its session window is nearly full; y is the
  // one that can actually take more requests right now — for Opus and for Fable.
  const pool = new AccountPool(provider, [account('x'), account('y')], { 'codex:x': credential('x'), 'codex:y': credential('y') }, { version: 1, accounts: {} }, 0.98, 16);
  const now = Date.now();
  pool.accounts[0]!.windows = { '7d': { usage: 0.4, resetsAt: now + 86_400_000 }, '7d_oi': { usage: 0.6, resetsAt: now + 86_400_000 }, '5h': { usage: 0.95, resetsAt: now + 3_600_000 } }; pool.accounts[0]!.usage = 0.95;
  pool.accounts[1]!.windows = { '7d': { usage: 0.5, resetsAt: now + 86_400_000 }, '7d_oi': { usage: 0.7, resetsAt: now + 86_400_000 }, '5h': { usage: 0.1, resetsAt: now + 3_600_000 } }; pool.accounts[1]!.usage = 0.5;
  assert.equal(pool.acquire('opus', new Set(), false)!.id, 'y');
  assert.equal(pool.acquire('fable', new Set(), true)!.id, 'y');
});

test('a clearly lighter account still wins over a busier one with fewer requests in flight', () => {
  const pool = new AccountPool(provider, [account('light'), account('heavy')], { 'codex:light': credential('light'), 'codex:heavy': credential('heavy') }, { version: 1, accounts: {} }, 0.98, 16);
  const now = Date.now();
  pool.accounts[0]!.windows = { '7d': { usage: 0.3, resetsAt: now + 86_400_000 } }; pool.accounts[0]!.usage = 0.3; pool.accounts[0]!.inflight = 3;
  pool.accounts[1]!.windows = { '7d': { usage: 0.6, resetsAt: now + 86_400_000 } }; pool.accounts[1]!.usage = 0.6; pool.accounts[1]!.inflight = 0;
  assert.equal(pool.acquire('s', new Set(), false)!.id, 'light');
});

test('a pin survives a failover that excludes the home for one request only', () => {
  const pool = new AccountPool(provider, [account('a', 1), account('b', 2)], { 'codex:a': credential('a'), 'codex:b': credential('b') }, state);
  const first = pool.acquire('s'); assert.equal(first?.id, 'a'); pool.release(first!);
  // This request has already failed on a (a transient 429): it spills to b.
  const spill = pool.acquire('s', new Set(['a'])); assert.equal(spill?.id, 'b'); pool.release(spill!);
  assert.equal(pool.acquire('s')?.id, 'a', 'the next request returns to the warm home');
});

test('a pin survives the home being at its concurrency cap', () => {
  const pool = new AccountPool(provider, [account('a', 1), account('b', 2)], { 'codex:a': credential('a'), 'codex:b': credential('b') }, state, 0.98, 1);
  const first = pool.acquire('s'); assert.equal(first?.id, 'a');
  const spill = pool.acquire('s'); assert.equal(spill?.id, 'b', 'a is full, so this one spills');
  pool.release(first!); pool.release(spill!);
  assert.equal(pool.acquire('s')?.id, 'a', 'once a slot frees up the session is back home');
});

test('a home that is genuinely spent is replaced, and the session settles there', () => {
  const pool = new AccountPool(provider, [account('a', 1), account('b', 2)], { 'codex:a': credential('a'), 'codex:b': credential('b') }, state);
  const first = pool.acquire('s'); assert.equal(first?.id, 'a'); pool.release(first!);
  const a = pool.accounts.find((x) => x.id === 'a')!; a.cooldownUntil = Date.now() + 60_000;
  const moved = pool.acquire('s'); assert.equal(moved?.id, 'b'); pool.release(moved!);
  a.cooldownUntil = null;
  assert.equal(pool.acquire('s')?.id, 'b', 'the new home is kept even once the old one recovers');
});

test('the affinity map is bounded, dropping the least recently used session', () => {
  const pool = new AccountPool(provider, [account('a')], { 'codex:a': credential('a') }, state, 0.98, 16, 0.8, 2);
  for (const session of ['s1', 's2', 's3']) { const got = pool.acquire(session); assert.ok(got); pool.release(got); }
  assert.equal(pool.pinnedSessions, 2);
});

test('a session that mixes Fable and other models keeps a home for each', () => {
  // Claude Code sends Haiku classifier calls between Fable turns. With one pin
  // per session, the Haiku call moved the pin to the spare and the next Fable
  // turn was ranked afresh — possibly onto a third, cold account.
  const pool = fableFleet();
  const fable = pool.acquire('s', new Set(), true); assert.equal(fable?.id, 'reserved'); pool.release(fable!);
  const other = pool.acquire('s', new Set(), false); assert.equal(other?.id, 'spare'); pool.release(other!);
  const again = pool.acquire('s', new Set(), true); assert.equal(again?.id, 'reserved', 'the Fable turn returns to its own home'); pool.release(again!);
  assert.equal(pool.acquire('s', new Set(), false)?.id, 'spare', 'and the other-model turn to its own');
});

test('non-Fable sessions stay pinned while every account still reserves Fable', () => {
  // Early in the week no account has spent its Fable budget, so there is no
  // spare to divert to. Refusing the pin then just scatters the session.
  const ids = ['x', 'y', 'z'];
  const win = (general: number, fable: number) => ({ usage: general, resetsAt: null, windows: { '7d': { usage: general, resetsAt: null }, '7d_oi': { usage: fable, resetsAt: null } }, profile: null, cooldownUntil: null, lastUsed: null, error: null });
  const pool = new AccountPool(provider, ids.map((id) => account(id)), Object.fromEntries(ids.map((id) => [`codex:${id}`, credential(id)])), { version: 1, accounts: Object.fromEntries(ids.map((id) => [`codex:${id}`, win(0.5, 0.3)])) }, 0.98, 3, 0.8);
  const first = pool.acquire('s', new Set(), false); assert.ok(first); pool.release(first);
  // Make every other account look lighter, so a fresh ranking would leave.
  for (const a of pool.accounts) if (a.id !== first.id) { a.usage = 0.1; a.windows = { ...a.windows, '7d': { usage: 0.1, resetsAt: null } }; }
  const second = pool.acquire('s', new Set(), false); assert.equal(second?.id, first.id, 'no spare exists, so the pin holds'); pool.release(second!);
  // A spare appears: the non-Fable session moves there once and settles.
  const spare = pool.accounts.find((a) => a.id !== first.id)!; spare.windows = { ...spare.windows, '7d_oi': { usage: 1, resetsAt: null } };
  const moved = pool.acquire('s', new Set(), false); assert.equal(moved?.id, spare.id); pool.release(moved!);
  assert.equal(pool.acquire('s', new Set(), false)?.id, spare.id);
});

test('a re-login written to disk is adopted over the stale token held in memory', () => {
  const pool = new AccountPool(provider, [account('a'), account('b')], { 'codex:a': credential('a'), 'codex:b': credential('b') }, state);
  const a = pool.accounts.find((x) => x.id === 'a')!; a.error = 'token refresh failed: 400'; const stale = a.credential;
  // Same token as memory, and an older one: neither is a re-login.
  assert.equal(pool.adoptCredentials({ 'codex:a': { ...stale }, 'codex:b': { ...credential('b'), accessToken: 'old', expiresAt: stale.expiresAt! - 1 } }), 0);
  assert.equal(a.error, 'token refresh failed: 400');
  const fresh = { ...credential('a'), accessToken: 'minted-now', expiresAt: stale.expiresAt! + 3_600_000 };
  assert.equal(pool.adoptCredentials({ 'codex:a': fresh }), 1);
  assert.equal(a.credential.accessToken, 'minted-now', 'the newer token wins');
  assert.equal(a.error, null, 'the re-login replaces the token that could not be renewed');
  // A token the server refreshed itself is newer than disk and must not be reverted.
  a.credential = { ...a.credential, accessToken: 'server-refreshed', expiresAt: fresh.expiresAt + 3_600_000 };
  assert.equal(pool.adoptCredentials({ 'codex:a': fresh }), 0);
  assert.equal(a.credential.accessToken, 'server-refreshed');
});

test('the lapsed-token sweep reports only real renewals and benches a token that cannot be renewed', async () => {
  const flaky: Provider = { ...provider, refresh: async (c) => { if (c.accountId === 'b') throw new Error('invalid_grant'); return { ...c, accessToken: 'renewed', expiresAt: Date.now() + 3_600_000 }; } };
  const expired = (id: string) => ({ ...credential(id), expiresAt: Date.now() - 1 });
  const pool = new AccountPool(flaky, [account('a'), account('b')], { 'codex:a': expired('a'), 'codex:b': expired('b') }, state);
  assert.deepEqual(await pool.refreshLapsed(), { healed: 1, failed: 1 });
  const a = pool.accounts.find((x) => x.id === 'a')!; const b = pool.accounts.find((x) => x.id === 'b')!;
  assert.equal(a.credential.accessToken, 'renewed'); assert.equal(a.error, null);
  assert.match(b.error!, /token refresh failed: invalid_grant/);
  assert.equal(pool.acquire('s')?.id, 'a', 'the account with a dead token is not routed to');
});

test('a network cooldown benches the account for this request but does not evict the session', () => {
  // One connection attempt failed and the account is benched for two seconds.
  // That used to read as "the home is gone", so a blip landing between two
  // turns more than two seconds apart moved the session to a cold account.
  const pool = new AccountPool(provider, [account('a', 1), account('b', 2)], { 'codex:a': credential('a'), 'codex:b': credential('b') }, state);
  const first = pool.acquire('s'); assert.equal(first?.id, 'a'); pool.release(first!);
  const a = pool.accounts.find((x) => x.id === 'a')!;
  pool.cooldown(a, 2_000, 'network');
  const spill = pool.acquire('s'); assert.equal(spill?.id, 'b', 'this request still goes elsewhere'); pool.release(spill!);
  a.cooldownUntil = null; a.cooldownReason = null;
  assert.equal(pool.acquire('s')?.id, 'a', 'the pin survived the blip');
  // A quota cooldown is a real eviction: the session settles on the spare.
  const again = pool.acquire('s'); pool.release(again!);
  pool.cooldown(a, 60_000, 'quota');
  const moved = pool.acquire('s'); assert.equal(moved?.id, 'b'); pool.release(moved!);
  a.cooldownUntil = null; a.cooldownReason = null;
  assert.equal(pool.acquire('s')?.id, 'b', 'a quota cooldown re-homes the session for good');
});

test('an explicit priority orders accounts within a reservation tier, not across it', () => {
  // 'reserved' still holds Fable budget and is priority #1; 'spare' has spent
  // its Fable. A non-Fable turn must go to the spare regardless of priority,
  // or the #1 account's Fable budget is burned on turns that cannot use it.
  const ids = ['spare', 'reserved'];
  const stored = [account('spare', 2), account('reserved', 1)];
  const credentials = Object.fromEntries(ids.map((id) => [`codex:${id}`, credential(id)]));
  const win = (general: number, fable: number) => ({ usage: general, resetsAt: null, windows: { '7d': { usage: general, resetsAt: null }, '7d_oi': { usage: fable, resetsAt: null } }, profile: null, cooldownUntil: null, lastUsed: null, error: null });
  const pool = new AccountPool(provider, stored, credentials, { version: 1, accounts: { 'codex:spare': win(0.5, 1), 'codex:reserved': win(0.05, 0.04) } }, 0.98, 3, 0.8);
  assert.equal(pool.acquire('s1', new Set(), false)?.id, 'spare', 'non-Fable turn skips the reserving #1 account');
  assert.equal(pool.acquire('s2', new Set(), true)?.id, 'reserved', 'Fable turn still honours priority');
});
