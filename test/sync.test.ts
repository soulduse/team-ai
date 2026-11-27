import assert from 'node:assert/strict';
import test from 'node:test';
import { AccountPool } from '../src/account-pool.js';
import { followedProviders, pickFollowed, sshPuller, type Puller } from '../src/sync.js';
import type { OAuthCredential, PersistedState, Provider, StoredAccount } from '../src/types.js';

const state: PersistedState = { version: 1, accounts: {} };
const cred = (token: string, expiresInMs: number): OAuthCredential => ({ accessToken: token, refreshToken: `r-${token}`, expiresAt: Date.now() + expiresInMs, accountId: 'x' });
const account = (id: string): StoredAccount => ({ id, provider: 'claude', label: id, enabled: true, priority: null, credentialId: `claude:${id}`, createdAt: new Date().toISOString() });

function setup(local: Record<string, OAuthCredential>, leaderHolds: Record<string, OAuthCredential> | Error) {
  const refreshed: string[] = [];
  const provider: Provider = {
    id: 'claude', label: 'Claude', upstreamBase: 'https://example.test', normalizePath: (p) => p,
    buildHeaders: (h) => h, rewriteBody: (b) => b, readQuota: () => null,
    classifyFailure: () => ({ kind: 'fatal', retryAfterMs: 0 }),
    refresh: async (c) => { refreshed.push(c.accessToken); return { ...c, accessToken: `${c.accessToken}-local`, expiresAt: Date.now() + 8 * 3600_000 }; },
  };
  const pulls = { count: 0 };
  const leader: Puller = async () => { pulls.count++; if (leaderHolds instanceof Error) throw leaderHolds; return leaderHolds; };
  const pool = new AccountPool(provider, Object.keys(local).map((k) => account(k.slice('claude:'.length))), local, state);
  pool.followLeader(leader);
  return { pool, refreshed, pulls };
}
const unreachable = Object.assign(new Error('leader macbook unreachable (timeout)'), { name: 'TimeoutError' });

test('followedProviders: only a follower with a peer follows, claude by default', () => {
  assert.deepEqual(followedProviders(undefined), []);
  assert.deepEqual(followedProviders({ role: 'follower', peer: '' }), []);
  assert.deepEqual(followedProviders({ role: 'follower', peer: 'macbook' }), ['claude']);
  assert.deepEqual(followedProviders({ role: 'follower', peer: 'macbook', providers: ['codex'] }), ['codex']);
});

test('pickFollowed keeps only well-formed records of followed providers', () => {
  const raw = { 'claude:a': cred('a', 1000), 'codex:b': cred('b', 1000), 'claude:bad': { accessToken: 1 }, 'claude:noexp': { accessToken: 't', expiresAt: null } };
  assert.deepEqual(Object.keys(pickFollowed(raw, ['claude'])), ['claude:a']);
  assert.deepEqual(pickFollowed([1, 2], ['claude']), {});
  assert.deepEqual(pickFollowed(null, ['claude']), {});
});

test('follower adopts the leader token instead of refreshing', async () => {
  const { pool, refreshed } = setup({ 'claude:a': cred('old', 60_000) }, { 'claude:a': cred('leader-new', 8 * 3600_000) });
  await pool.refresh(pool.accounts[0]!);
  assert.equal(pool.accounts[0]!.credential.accessToken, 'leader-new');
  assert.deepEqual(refreshed, [], 'must not spend the shared refresh token');
});

test('follower refreshes locally an account the leader does not hold', async () => {
  const { pool, refreshed } = setup({ 'claude:solo': cred('mine', 60_000) }, {});
  await pool.refresh(pool.accounts[0]!);
  assert.deepEqual(refreshed, ['mine']);
  assert.equal(pool.accounts[0]!.credential.accessToken, 'mine-local');
});

test('follower keeps a live token on the keep-alive sweep when the leader has nothing newer', async () => {
  const { pool, refreshed } = setup({ 'claude:a': cred('same', 60_000) }, { 'claude:a': cred('same', 60_000) });
  await pool.refresh(pool.accounts[0]!);
  assert.equal(pool.accounts[0]!.credential.accessToken, 'same');
  assert.deepEqual(refreshed, []);
});

test('after a 401 the refused token is never handed back — not even by the quick retry (no loop)', async () => {
  const leaderHolds: Record<string, OAuthCredential> = { 'claude:a': cred('T1', 3600_000) };
  const { pool, refreshed } = setup({ 'claude:a': cred('T1', 3600_000) }, leaderHolds);
  const a = pool.accounts[0]!;
  const error = await pool.refresh(a, true, 'T1').catch((e: unknown) => e);
  assert.equal(pool.recordRefreshFailure(a, error), 'unreachable');
  // quick retry = forced sweep without a refused token: must stay benched
  await assert.rejects(pool.refresh(a, true), (e: Error) => e.name === 'TimeoutError');
  assert.equal(a.credential.accessToken, 'T1');
  // the leader rotates → adopted and healed
  leaderHolds['claude:a'] = cred('T2', 8 * 3600_000);
  await pool.refresh(a, true);
  assert.equal(a.credential.accessToken, 'T2');
  assert.equal(a.error, null);
  assert.deepEqual(refreshed, []);
});

test('a 401 for an old token does not bench a newer token adopted meanwhile', async () => {
  const { pool } = setup({ 'claude:a': cred('T2', 3600_000) }, { 'claude:a': cred('T2', 3600_000) });
  await pool.refresh(pool.accounts[0]!, true, 'T1');
  assert.equal(pool.accounts[0]!.error, null);
});

test('a forced sweep heals an account benched only because the leader was unreachable', async () => {
  const { pool } = setup({ 'claude:a': cred('same', 3600_000) }, { 'claude:a': cred('same', 3600_000) });
  const a = pool.accounts[0]!;
  pool.recordRefreshFailure(a, unreachable);
  await pool.refresh(a, true);
  assert.equal(a.error, null);
});

test('an expired token with nothing newer from the leader is benched, never refreshed locally', async () => {
  const { pool, refreshed } = setup({ 'claude:a': cred('dead', -1000) }, { 'claude:a': cred('dead', -1000) });
  await assert.rejects(pool.refresh(pool.accounts[0]!), (e: Error) => e.name === 'TimeoutError');
  assert.deepEqual(refreshed, []);
});

test('an unreachable leader with an expired token surfaces as unreachable, not as a refusal', async () => {
  const { pool, refreshed } = setup({ 'claude:a': cred('old', -1000) }, unreachable);
  const a = pool.accounts[0]!;
  const error = await pool.refresh(a).catch((e: unknown) => e);
  assert.equal(pool.recordRefreshFailure(a, error), 'unreachable');
  assert.deepEqual(refreshed, []);
});

test('sshPuller: one read is shared by callers within the reuse window, a failure is not cached', async () => {
  let clock = 0; const calls: string[][] = [];
  let fail = false;
  const run = async (args: string[]) => { calls.push(args); if (fail) throw new Error('ssh down'); return JSON.stringify({ 'claude:a': cred('t', 1000) }); };
  const pull = sshPuller({ role: 'follower', peer: 'macbook' }, run, () => clock);
  await Promise.all([pull(), pull()]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.slice(-2), ['macbook', 'cat ~/.config/teamai/credentials.json']);
  clock = 20_000; fail = true;
  await assert.rejects(pull(), (e: Error) => e.name === 'TimeoutError' && /macbook unreachable/.test(e.message));
  fail = false;
  const again = await pull();
  assert.equal(calls.length, 3);
  assert.ok(again['claude:a']);
});

test('leader asleep: an account the leader never held still refreshes locally', async () => {
  const holds: Record<string, OAuthCredential> | Error = { 'claude:shared': cred('s', 3600_000) };
  const { pool, refreshed } = setup({ 'claude:shared': cred('s', 3600_000), 'claude:solo': cred('mine', 60_000) }, holds);
  pool.adoptFromLeader(holds); // a successful pull: the leader holds only "shared"
  const asleep = pool as unknown as { leader: () => Promise<never> };
  asleep.leader = async () => { throw unreachable; };
  await pool.refresh(pool.accounts.find((a) => a.id === 'solo')!);
  assert.deepEqual(refreshed, ['mine']);
  // a shared account with a live token keeps serving while the leader is away
  await pool.refresh(pool.accounts.find((a) => a.id === 'shared')!, true);
  assert.deepEqual(refreshed, ['mine']);
});

test('a routine leader rotation does not lift an organization block', () => {
  const { pool } = setup({ 'claude:a': cred('T1', 3600_000) }, {});
  const a = pool.accounts[0]!;
  a.error = 'organization refuses OAuth'; a.errorKind = 'blocked';
  assert.equal(pool.adoptFromLeader({ 'claude:a': cred('T2', 8 * 3600_000) }), 1);
  assert.equal(a.credential.accessToken, 'T2');
  assert.equal(a.errorKind, 'blocked');
});

// ── failover (stage 2) ──────────────────────────────────────────────────────
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sshPusher, shellQuote, type InputRunner } from '../src/sync.js';

function downLeader(downForMs: number): Puller {
  const fn = (async () => { throw unreachable; }) as Puller;
  fn.downSince = () => Date.now() - downForMs;
  return fn;
}

test('failover: the leader away for less than the threshold — no local refresh', async () => {
  const { pool, refreshed } = setup({ 'claude:a': cred('T1', 60_000) }, {});
  pool.adoptFromLeader({ 'claude:a': cred('T1', 60_000) });
  pool.followLeader(downLeader(5 * 60_000), 10 * 60_000);
  await pool.refresh(pool.accounts[0]!); // lapsing but live: kept
  assert.deepEqual(refreshed, []);
  assert.equal(pool.takeFailovers(), 0);
});

test('failover: the leader away past the threshold and the token lapsing — refreshed here, then pushed back', async () => {
  const { pool, refreshed } = setup({ 'claude:a': cred('T1', 60_000) }, {});
  pool.adoptFromLeader({ 'claude:a': cred('T1', 60_000) });
  pool.followLeader(downLeader(11 * 60_000), 10 * 60_000);
  await pool.refresh(pool.accounts[0]!);
  assert.deepEqual(refreshed, ['T1']);
  assert.equal(pool.accounts[0]!.credential.accessToken, 'T1-local');
  assert.equal(pool.takeFailovers(), 1);
  assert.equal(pool.takeFailovers(), 0);
  // the leader returns still holding T1: ours is newer and must go back, and adopting must not undo it
  const latest = { 'claude:a': cred('T1', 60_000) };
  assert.deepEqual(Object.keys(pool.newerThanLeader(latest)), ['claude:a']);
  pool.adoptFromLeader(latest);
  assert.equal(pool.accounts[0]!.credential.accessToken, 'T1-local');
});

test('failover is off when failoverAfterMs is 0', async () => {
  const { pool, refreshed } = setup({ 'claude:a': cred('T1', -1000) }, {});
  pool.adoptFromLeader({ 'claude:a': cred('T1', -1000) });
  pool.followLeader(downLeader(60 * 60_000), 0);
  await assert.rejects(pool.refresh(pool.accounts[0]!), (e: Error) => e.name === 'TimeoutError');
  assert.deepEqual(refreshed, []);
});

test('newerThanLeader is empty in normal following', () => {
  const { pool } = setup({ 'claude:a': cred('T1', 3600_000) }, {});
  assert.deepEqual(pool.newerThanLeader({ 'claude:a': cred('T2', 7200_000) }), {});
  assert.deepEqual(pool.newerThanLeader({}), {});
});

// Runs the push exactly as ssh would: everything after the destination is one
// remote shell line, here executed by a local sh against a temp credentials file.
const viaShell: InputRunner = (args, input) => new Promise((resolve, reject) => {
  const line = args.slice(args.indexOf('--') + 2).join(' ');
  const child = execFile('sh', ['-c', line], (error, stdout) => (error ? reject(error) : resolve(stdout)));
  child.stdin!.end(input);
});

test('push merges only newer records into the leader file, keeping the rest and 0600', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamai-push-'));
  const file = join(dir, 'credentials.json');
  const keep = { accessToken: 'leader-codex', refreshToken: 'r', expiresAt: 5, accountId: 'c' };
  await writeFile(file, JSON.stringify({ 'claude:a': cred('old', 1000), 'claude:b': cred('leader-newer', 9e9), 'codex:x': keep }, null, 2));
  const push = sshPusher({ role: 'follower', peer: 'macbook', path: file, node: process.execPath }, viaShell);
  const taken = await push({ 'claude:a': cred("ours-it's", 3600_000), 'claude:b': cred('ours-older', 1000) });
  assert.equal(taken, 1);
  const after = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(after['claude:a'].accessToken, "ours-it's");
  assert.equal(after['claude:b'].accessToken, 'leader-newer');
  assert.deepEqual(after['codex:x'], keep);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(await push({}), 0);
});

test('shellQuote survives single quotes', async () => {
  const out = await new Promise<string>((resolve, reject) => execFile('sh', ['-c', `printf %s ${shellQuote("a'b \"c\" $x")}`], (e, o) => (e ? reject(e) : resolve(o))));
  assert.equal(out, "a'b \"c\" $x");
});

// ── review fixes: connection-only downtime, leader disk re-read, failover refusal ──
import { connectionFailed } from '../src/sync.js';

test('connectionFailed: only ssh connection failures and timeouts count as the leader being down', () => {
  assert.equal(connectionFailed(Object.assign(new Error('x'), { code: 255 })), true);
  assert.equal(connectionFailed(Object.assign(new Error('x'), { killed: true, signal: 'SIGTERM' })), true);
  assert.equal(connectionFailed(Object.assign(new Error('cat: no such file'), { code: 1 })), false);
  assert.equal(connectionFailed(new SyntaxError('Unexpected token')), false);
});

test('sshPuller: a parse failure on a reachable leader does not start the downtime clock', async () => {
  let reply: string | Error = '{not json';
  const run = async () => { if (reply instanceof Error) throw reply; return reply; };
  let clock = 0;
  const pull = sshPuller({ role: 'follower', peer: 'macbook' }, run, () => clock);
  await assert.rejects(pull());
  assert.equal(pull.downSince!(), null);
  clock = 20_000; reply = Object.assign(new Error('ssh: connect timed out'), { code: 255 });
  await assert.rejects(pull());
  assert.equal(pull.downSince!(), 20_000);
  clock = 30_000; reply = '{not json';
  await assert.rejects(pull());
  assert.equal(pull.downSince!(), null, 'it answered, so it is up');
  clock = 40_000; reply = '{}';
  await pull();
  assert.equal(pull.downSince!(), null);
});

function leaderPool(diskHolds: () => Record<string, OAuthCredential>, refresh: Provider['refresh']) {
  const provider: Provider = {
    id: 'claude', label: 'Claude', upstreamBase: 'https://example.test', normalizePath: (p) => p,
    buildHeaders: (h) => h, rewriteBody: (b) => b, readQuota: () => null,
    classifyFailure: () => ({ kind: 'fatal', retryAfterMs: 0 }), refresh,
  };
  const pool = new AccountPool(provider, [account('a')], { 'claude:a': cred('spent', 60_000) }, state);
  pool.readCredentialsFrom(async () => diskHolds());
  return pool;
}

test('leader: a newer token already on disk (pushed back by a follower) is used instead of spending ours', async () => {
  let calls = 0;
  const pool = leaderPool(() => ({ 'claude:a': cred('pushed', 8 * 3600_000) }), async (c) => { calls++; return c; });
  await pool.refresh(pool.accounts[0]!);
  assert.equal(pool.accounts[0]!.credential.accessToken, 'pushed');
  assert.equal(calls, 0);
});

test('leader: a refused refresh re-reads the disk before giving up', async () => {
  let disk: Record<string, OAuthCredential> = {};
  const pool = leaderPool(() => disk, async () => { disk = { 'claude:a': cred('pushed', 8 * 3600_000) }; throw Object.assign(new Error('OAuth refresh failed (400)'), { status: 400 }); });
  await pool.refresh(pool.accounts[0]!);
  assert.equal(pool.accounts[0]!.credential.accessToken, 'pushed');
});

test('leader: an older or lapsing disk token is ignored and the refresh goes ahead', async () => {
  let calls = 0;
  const pool = leaderPool(() => ({ 'claude:a': cred('lapsing', 60_000) }), async (c) => { calls++; return { ...c, accessToken: 'fresh', expiresAt: Date.now() + 3600_000 }; });
  await pool.refresh(pool.accounts[0]!);
  assert.equal(calls, 1);
  assert.equal(pool.accounts[0]!.credential.accessToken, 'fresh');
});

test('leader: an unreadable credentials file never blocks a refresh', async () => {
  let calls = 0;
  const pool = leaderPool(() => { throw new Error('EACCES'); }, async (c) => { calls++; return { ...c, expiresAt: Date.now() + 3600_000 }; });
  await pool.refresh(pool.accounts[0]!);
  assert.equal(calls, 1);
});

test('failover refused: keeps serving a still-live token and does not retry on the same refresh token for an hour', async () => {
  const provider: Provider = {
    id: 'claude', label: 'Claude', upstreamBase: 'https://example.test', normalizePath: (p) => p,
    buildHeaders: (h) => h, rewriteBody: (b) => b, readQuota: () => null,
    classifyFailure: () => ({ kind: 'fatal', retryAfterMs: 0 }),
    refresh: async () => { calls++; throw Object.assign(new Error('OAuth refresh failed (400)'), { status: 400 }); },
  };
  let calls = 0;
  const pool = new AccountPool(provider, [account('a')], { 'claude:a': cred('T1', 60_000) }, state);
  pool.adoptFromLeader({ 'claude:a': cred('T1', 60_000) });
  pool.followLeader(downLeader(40 * 60_000), 30 * 60_000);
  await pool.refresh(pool.accounts[0]!); // refused, but T1 still live → served
  assert.equal(calls, 1);
  assert.equal(pool.accounts[0]!.error, null);
  await pool.refresh(pool.accounts[0]!); // within the hour: no second attempt
  assert.equal(calls, 1);
  assert.equal(pool.takeFailovers(), 0);
});

// ── security: error text never carries credential fragments ──────────────────
import { leaderUnreachable, safeCause } from '../src/sync.js';

test('a malformed leader file never leaks its contents into the error', async () => {
  const run = async () => '{"claude:a":{"accessToken":"sk-ant-SECRET-123","refreshToken":"rt-SECRET"';
  const pull = sshPuller({ role: 'follower', peer: 'macbook' }, run, () => 0);
  const error = await pull().catch((e: Error) => e);
  assert.ok(error instanceof Error);
  assert.doesNotMatch(error.message, /SECRET|accessToken|sk-ant/);
  assert.match(error.message, /invalid JSON/);
});

test('safeCause keeps only fixed words and numeric fields', () => {
  assert.equal(safeCause(new SyntaxError('Unexpected token "sk-ant-SECRET" is not valid JSON')), 'invalid JSON');
  assert.equal(safeCause(Object.assign(new Error('Command failed: ssh ... sk-ant-SECRET'), { code: 255 })), 'ssh exit 255');
  assert.equal(safeCause(Object.assign(new Error('x'), { killed: true, signal: 'SIGTERM' })), 'timed out');
  assert.equal(safeCause(Object.assign(new Error('spawn ssh ENOENT'), { code: 'ENOENT' })), 'ENOENT');
  assert.equal(safeCause(Object.assign(new Error('sk-ant-SECRET'), { code: 'sk-ant-SECRET' })), 'error');
  assert.doesNotMatch(leaderUnreachable('macbook', new Error('sk-ant-SECRET')).message, /SECRET/);
});
