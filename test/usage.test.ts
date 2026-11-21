import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { AccountPool } from '../src/account-pool.js';
import { codexProvider } from '../src/providers.js';
import { defaultConfig } from '../src/storage.js';
import type { OAuthCredential, PersistedState, StoredAccount, TeamAIConfig } from '../src/types.js';
import { buildUsageReport, formatUsageTable, requestUrl, serveUsage } from '../src/usage.js';

const NOW = Date.UTC(2026, 10, 17, 12, 0, 0);
const stored = (id: string, provider: 'claude' | 'codex', label: string, enabled = true): StoredAccount => ({ id, provider, label, enabled, priority: null, credentialId: `cred-${id}`, createdAt: '' });
function fixture(): { config: TeamAIConfig; state: PersistedState } {
  const config = { ...defaultConfig(), accounts: [stored('a', 'claude', 'alice@example.com'), stored('b', 'claude', 'bob@example.com'), stored('c', 'codex', 'carol@example.com', false)] };
  const state: PersistedState = {
    version: 1,
    accounts: {
      'cred-a': { usage: 0.42, resetsAt: NOW + 3_600_000, windows: { '5h': { usage: 0.42, resetsAt: NOW + 3_600_000 }, '7d': { usage: 0.1, resetsAt: NOW + 86_400_000 }, stale: { usage: 0.9, resetsAt: NOW - 1 } }, profile: { status: null, createdAt: null, rateLimitTier: 'default_claude_max_20x', orgType: null, hasClaudeMax: true, hasClaudePro: false, fetchedAt: NOW }, measuredAt: NOW - 60_000, cooldownUntil: null, lastUsed: null, error: null },
      'cred-b': { usage: 0.99, resetsAt: null, windows: {}, cooldownUntil: NOW + 60_000, lastUsed: null, error: 'refresh failed for bob@example.com' },
    },
  };
  return { config, state };
}

test('usage report masks labels by default and keeps credentials out', () => {
  const { config, state } = fixture();
  const report = buildUsageReport(config, state, { source: 'state', now: NOW });
  const text = JSON.stringify(report);
  assert.doesNotMatch(text, /alice@example\.com|bob@example\.com|carol@example\.com/);
  assert.doesNotMatch(text, /tai-|accessToken|refreshToken|clientToken/);
  assert.match(report.providers.claude.accounts[1]!.error!, /^refresh failed for •••@ex•+\.com$/);
  const raw = buildUsageReport(config, state, { source: 'state', level: 'none', now: NOW });
  assert.equal(raw.providers.claude.accounts[0]!.label, 'alice@example.com');
  assert.equal(buildUsageReport(config, state, { source: 'state', level: 'full', now: NOW }).providers.codex.accounts[0]!.label, 'account #3');
});

test('usage report computes windows, availability and the next reset', () => {
  const { config, state } = fixture();
  const report = buildUsageReport(config, state, { source: 'state', now: NOW });
  const [alice, bob] = report.providers.claude.accounts;
  assert.deepEqual(Object.keys(alice!.windows), ['5h', '7d'], 'a window past its reset is dropped');
  assert.deepEqual(alice!.windows['5h'], { usage: 0.42, resetsAt: new Date(NOW + 3_600_000).toISOString(), resetsInMs: 3_600_000 });
  assert.equal(alice!.plan, 'default_claude_max_20x');
  assert.equal(alice!.available, true);
  assert.equal(bob!.available, false); assert.equal(bob!.cooldownUntil, new Date(NOW + 60_000).toISOString());
  assert.equal(alice!.inflight, null, 'state.json has no in-flight count');
  assert.deepEqual(report.providers.claude.summary, { accounts: 2, enabled: 2, available: 1, nextResetAt: new Date(NOW + 3_600_000).toISOString() });
  const carol = report.providers.codex.accounts[0]!;
  assert.equal(carol.available, false); assert.equal(carol.usage, null); assert.deepEqual(carol.windows, {});
  assert.deepEqual(report.providers.codex.summary, { accounts: 1, enabled: 0, available: 0, nextResetAt: null });
  const table = formatUsageTable(report);
  assert.match(table, /claude: 1\/2 available, next reset 1h/);
  assert.match(table, /5h 42% \(1h\)/); assert.match(table, /\[cooldown, error\]/); assert.match(table, /\[off\]/);
});

test('live status from the pool adds in-flight counts and cooldown reasons', () => {
  const { config, state } = fixture();
  const credential: OAuthCredential = { accessToken: 'secret', refreshToken: null, expiresAt: null, accountId: 'x' };
  const pool = new AccountPool(codexProvider, [config.accounts[2]!], { 'cred-c': credential }, state);
  pool.accounts[0]!.inflight = 2; pool.accounts[0]!.cooldownUntil = NOW + 5_000; pool.accounts[0]!.cooldownReason = 'network';
  assert.deepEqual(pool.liveStatus(), [{ credentialId: 'cred-c', inflight: 2, cooldownUntil: NOW + 5_000, cooldownReason: 'network' }]);
  const report = buildUsageReport(config, state, { source: 'live', now: NOW, live: pool.liveStatus() });
  const carol = report.providers.codex.accounts[0]!;
  assert.equal(carol.inflight, 2); assert.equal(carol.cooldownReason, 'network');
  assert.doesNotMatch(JSON.stringify(report), /secret/);
});

test('GET /usage serves the report and rejects an unknown redact level', async () => {
  const { config, state } = fixture();
  const levels: string[] = [];
  const server = createServer((req, res) => void serveUsage(requestUrl(req)!, res, (level) => { levels.push(level); return buildUsageReport(config, state, { source: 'live', level, now: NOW }); }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert(address && typeof address !== 'string');
  try {
    const ok = await fetch(`http://127.0.0.1:${address.port}/usage`);
    assert.equal(ok.status, 200); assert.equal(ok.headers.get('cache-control'), 'no-store');
    const body = await ok.json() as { source: string; providers: { claude: { accounts: unknown[] } } };
    assert.equal(body.source, 'live'); assert.equal(body.providers.claude.accounts.length, 2);
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/usage?redact=full`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/usage?redact=bogus`)).status, 400);
    assert.deepEqual(levels, ['partial', 'full']);
  } finally { server.close(); }
});

test('an account past its reset reads as cleared, as the server would route it', () => {
  const { config, state } = fixture();
  state.accounts['cred-b'] = { usage: 0.99, resetsAt: NOW - 1_000, windows: {}, cooldownUntil: NOW + 60_000, lastUsed: null, error: null };
  const bob = buildUsageReport(config, state, { source: 'state', now: NOW }).providers.claude.accounts[1]!;
  assert.equal(bob.usage, null); assert.equal(bob.cooldownUntil, null); assert.equal(bob.available, true);
});

test('a request target that does not parse yields null instead of throwing', () => {
  assert.equal(requestUrl({ url: '//' } as never), null);
  assert.equal(requestUrl({ url: '/usage?redact=full' } as never)?.searchParams.get('redact'), 'full');
});

test('usage report carries Claude reset tickets with their age, and the table names them', () => {
  const { config, state } = fixture();
  state.accounts['cred-a']!.resetCredits = { general: 1, fable: 3, nextExpiry: NOW + 86_400_000, readAt: NOW - 60_000 };
  state.accounts['cred-b']!.resetCredits = { general: 0, fable: 2, nextExpiry: null, readAt: NOW - 3 * 86_400_000 };
  const report = buildUsageReport(config, state, { source: 'state', now: NOW });
  const [a, b] = report.providers.claude.accounts;
  assert.deepEqual(a?.resetTickets, { general: 1, fable: 3, nextExpiry: new Date(NOW + 86_400_000).toISOString(), readAt: new Date(NOW - 60_000).toISOString(), stale: false });
  assert.equal(b?.resetTickets?.stale, true);
  assert.equal(report.providers.codex.accounts[0]?.resetTickets, null);
  const table = formatUsageTable(report);
  assert.match(table, /resets R1 F3(?! \(stale\))/);
  assert.match(table, /resets F2 \(stale\)/);
});

test('usage report says whether an error heals on its own or needs a re-login', () => {
  const { config, state } = fixture();
  state.accounts['cred-a'] = { ...state.accounts['cred-a']!, error: 'token refresh unreachable (ETIMEDOUT); retrying', errorKind: 'unreachable' };
  const report = buildUsageReport(config, state, { source: 'state', now: NOW });
  const [alice, bob] = report.providers.claude.accounts;
  assert.equal(alice!.errorKind, 'unreachable'); assert.equal(bob!.errorKind, 'refused');
  const table = formatUsageTable(report);
  assert.match(table, /\[retrying\]/); assert.match(table, /error/);
});
