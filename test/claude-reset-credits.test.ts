import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';
import { AccountPool } from '../src/account-pool.js';
import { claudeProvider, claudeUsageQuota } from '../src/providers.js';
import { handleResetCreditControl } from '../src/reset-credit-control.js';
import {
  classifyConsume,
  claudeResetCreditCount,
  eligibility,
  parseClaudeResetCreditList,
  resetCreditSettings,
} from '../src/reset-credits.js';
import type { Provider, RuntimeAccount, StoredAccount } from '../src/types.js';

test('claudeUsageQuota extracts reset credit count from cedar_ember grants', () => {
  const data = {
    limits: [{ kind: 'session', percent: 20, resets_at: '2026-11-11T20:00:00Z' }],
    cedar_ember: {
      eligible: true,
      grants: [
        { id: 'g1', label: 'Grant 1', resets_left: 2, paused: false },
        { id: 'g2', label: 'Grant 2', resets_left: 1, paused: false },
        { id: 'g3', label: 'Grant 3 (paused)', resets_left: 5, paused: true },
        { id: 'g4', label: 'Grant 4 (spent)', resets_left: 0, paused: false },
      ],
    },
  };
  const quota = claudeUsageQuota(data);
  assert.equal(quota?.resetCredits, 3);
  assert.equal(claudeResetCreditCount(data), 3);

  assert.equal(claudeResetCreditCount({ cedar_ember: { eligible: false, grants: [{ resets_left: 2 }] } }), null);
  assert.equal(claudeResetCreditCount({ limits: [] }), null);
});

test('parseClaudeResetCreditList parses grants and preserves fields', () => {
  const raw = {
    cedar_ember: {
      grants: [
        {
          id: 'grant-late',
          label: 'November Reset',
          starts_at: '2026-11-01T00:00:00Z',
          ends_at: '2026-12-10T22:00:00Z',
          clears: ['five_hour', 'seven_day'],
          paused: false,
          usable_now: true,
          gives_back_weekly: true,
          unavailable_reason: null,
          resets_left: 1,
        },
        {
          id: 'grant-soon',
          label: 'Fable Special',
          starts_at: null,
          ends_at: '2026-11-20T00:00:00Z',
          clears: ['five_hour'],
          paused: false,
          usable_now: false,
          gives_back_weekly: false,
          unavailable_reason: 'needs_limit',
          resets_left: 2,
        },
        {
          id: 'grant-paused',
          label: 'Paused',
          paused: true,
          resets_left: 1,
        },
        {
          id: 'grant-spent',
          label: 'Spent',
          paused: false,
          resets_left: 0,
        },
      ],
    },
  };

  const list = parseClaudeResetCreditList(raw);
  assert.equal(list.length, 2);
  // soonest to expire first
  assert.equal(list[0]!.id, 'grant-soon');
  assert.equal(list[0]!.title, 'Fable Special');
  assert.equal(list[0]!.usableNow, false);
  assert.equal(list[0]!.unavailableReason, 'needs_limit');
  assert.equal(list[0]!.resetsLeft, 2);
  assert.deepEqual(list[0]!.clears, ['five_hour']);

  assert.equal(list[1]!.id, 'grant-late');
  assert.equal(list[1]!.title, 'November Reset');
  assert.equal(list[1]!.usableNow, true);
  assert.equal(list[1]!.givesBackWeekly, true);
  assert.equal(list[1]!.unavailableReason, null);
  assert.deepEqual(list[1]!.clears, ['five_hour', 'seven_day']);
  assert.equal(list[1]!.grantedAt, Date.parse('2026-11-01T00:00:00Z'));
  assert.equal(list[1]!.expiresAt, Date.parse('2026-12-10T22:00:00Z'));
});

test('claude consume answers are correctly classified', () => {
  assert.equal(classifyConsume(200, JSON.stringify({ result: 'reset', cleared: ['five_hour', 'seven_day'] })).kind, 'reset');
  assert.equal(classifyConsume(200, JSON.stringify({ result: 'reset', cleared: ['five_hour'] })).windowsReset, 1);
  assert.equal(classifyConsume(200, JSON.stringify({ result: 'already_used', reason: 'already_used' })).kind, 'no-spend');
  assert.equal(classifyConsume(200, JSON.stringify({ result: 'not_limited', reason: 'not_limited' })).kind, 'no-spend');
  assert.equal(classifyConsume(200, JSON.stringify({ result: 'ineligible', reason: 'tier' })).kind, 'no-spend');
  assert.equal(classifyConsume(200, JSON.stringify({ result: 'unavailable', reason: 'expired' })).kind, 'no-spend');
  assert.equal(classifyConsume(429, '{"error":"rate_limit"}').kind, 'no-spend');
  assert.equal(classifyConsume(401, '{"error":"unauthorized"}').kind, 'no-spend');
  assert.equal(classifyConsume(500, '{"error":"server_error"}').kind, 'indeterminate');
});

test('claude automatic use is disabled by default and requires explicit opt-in', () => {
  const account: RuntimeAccount = {
    id: 'a',
    label: 'a@example.com',
    provider: 'claude',
    enabled: true,
    priority: 1,
    credentialId: 'a',
    createdAt: '',
    inflight: 0,
    retired: false,
    usage: 1,
    resetsAt: Date.now() + 3_600_000,
    cooldownUntil: null,
    cooldownReason: null,
    cooldownAt: null,
    lastUsed: null,
    error: null,
    windows: {
      '5h': { usage: 1, resetsAt: Date.now() + 3_600_000 },
      '7d': { usage: 1, resetsAt: Date.now() + 86_400_000 },
    },
    profile: null,
    measuredAt: null,
    resetCredits: 3,
    resetCreditsAt: Date.now(),
    credential: {
      accessToken: 'tok',
      refreshToken: null,
      expiresAt: Date.now() + 3_600_000,
      accountId: 'a',
    },
  };

  // Default settings
  const def = resetCreditSettings({});
  assert.equal(def.claudeEnabled, false);
  assert.equal(eligibility(account, def, 'claude'), 'not-codex-oauth');

  // Codex enabled alone does not enable Claude
  const codexOn = resetCreditSettings({ codexResetCredits: true });
  assert.equal(codexOn.claudeEnabled, false);
  assert.equal(eligibility(account, codexOn, 'claude'), 'not-codex-oauth');

  // Explicit Claude enabled
  const claudeOn = resetCreditSettings({ claudeResetCredits: true });
  assert.equal(claudeOn.claudeEnabled, true);
  assert.equal(eligibility(account, claudeOn, 'claude'), 'ok');
});

interface FakeClaudeServer {
  url: string;
  calls: Array<{ method: string; path: string; headers: Record<string, string>; body: Record<string, unknown> | null }>;
  close: () => void;
}

function startFakeClaude(handler?: (req: IncomingMessage, res: ServerResponse, bodyText: string) => boolean): Promise<FakeClaudeServer> {
  const calls: FakeClaudeServer['calls'] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    let parsedBody: Record<string, unknown> | null = null;
    try { parsedBody = JSON.parse(bodyText); } catch { /* non-json */ }
    const rawHeaders = req.headers;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawHeaders)) if (typeof v === 'string') headers[k] = v;

    calls.push({ method: req.method || 'GET', path: req.url || '/', headers, body: parsedBody });

    if (handler && handler(req, res, bodyText)) return;

    if (req.url === '/api/oauth/profile') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        account: { has_claude_pro: true },
        organization: { uuid: 'org-1234', subscription_status: 'active' },
      }));
      return;
    }
    if (req.url?.startsWith('/api/oauth/usage')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        limits: [{ kind: 'session', percent: 50, resets_at: '2026-11-11T20:00:00Z' }],
        cedar_ember: {
          eligible: true,
          grants: [{ id: 'grant-test', label: 'Test Ticket', resets_left: 1, paused: false }],
        },
      }));
      return;
    }
    if (req.url === '/api/organizations/org-1234/reset_rate_limits') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ result: 'reset', cleared: ['five_hour', 'seven_day'], resets_left: 0 }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      assert(addr && typeof addr !== 'string');
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        calls,
        close: () => { server.close(); server.closeAllConnections(); },
      });
    });
  });
}

test('claudeProvider fetchResetCredits sends expected GET request and headers', async () => {
  const fake = await startFakeClaude();
  try {
    const provider: Provider = { ...claudeProvider, upstreamBase: fake.url };
    const credits = await provider.fetchResetCredits!({
      accessToken: 'token-abc',
      refreshToken: null,
      expiresAt: Date.now() + 3_600_000,
      accountId: 'acc-1',
    });

    assert.equal(credits.length, 1);
    assert.equal(credits[0]!.id, 'grant-test');
    assert.equal(fake.calls.length, 1);
    const call = fake.calls[0]!;
    assert.equal(call.method, 'GET');
    assert.equal(call.path, '/api/oauth/usage?cedar_ember=1&skip_spend=1');
    assert.equal(call.headers['authorization'], 'Bearer token-abc');
    assert.equal(call.headers['x-app'], 'cli');
    assert.equal(call.headers['anthropic-beta'], 'oauth-2025-04-20');
    assert.match(call.headers['user-agent'] || '', /claude-cli\//);
  } finally {
    fake.close();
  }
});

test('claudeProvider consumeResetCredit sends expected POST request, headers and body', async () => {
  const fake = await startFakeClaude();
  try {
    const provider: Provider = { ...claudeProvider, upstreamBase: fake.url };
    const res = await provider.consumeResetCredit!(
      {
        accessToken: 'token-xyz',
        refreshToken: null,
        expiresAt: Date.now() + 3_600_000,
        accountId: 'acc-1',
        organizationUuid: 'org-1234',
      },
      {
        redeemRequestId: 'req-555',
        creditId: 'grant-test',
        timeoutMs: 5000,
      },
    );

    assert.equal(res.status, 200);
    assert.equal(fake.calls.length, 1);
    const call = fake.calls[0]!;
    assert.equal(call.method, 'POST');
    assert.equal(call.path, '/api/organizations/org-1234/reset_rate_limits');
    assert.equal(call.headers['authorization'], 'Bearer token-xyz');
    assert.equal(call.headers['content-type'], 'application/json');
    assert.equal(call.headers['anthropic-beta'], 'oauth-2025-04-20');
    assert.equal(call.headers['x-app'], 'cli');
    assert.match(call.headers['user-agent'] || '', /claude-cli\//);
    assert.deepEqual(call.body, {
      program: 'cedar_ember',
      grant_id: 'grant-test',
      request_id: 'req-555',
    });
  } finally {
    fake.close();
  }
});

test('claude control routes handle list and operator redeem with verification', async () => {
  const fake = await startFakeClaude();
  const provider: Provider = { ...claudeProvider, upstreamBase: fake.url };
  const stored: StoredAccount = { id: 'c1', provider: 'claude', label: 'claude1@example.com', enabled: true, priority: 1, credentialId: 'c1', createdAt: '' };
  const pool = new AccountPool(provider, [stored], {
    c1: { accessToken: 'tok-c1', refreshToken: null, expiresAt: Date.now() + 3_600_000, accountId: 'acc-c1', organizationUuid: 'org-1234' },
  }, { version: 1, accounts: {} });
  pool.saveNow = async () => {};

  const server = createServer((req, res) => {
    void handleResetCreditControl(req, res, [pool], 'secret-tok').then((handled) => {
      if (!handled) { res.writeHead(404); res.end(); }
    });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  assert(addr && typeof addr !== 'string');
  const base = `http://127.0.0.1:${addr.port}`;
  const auth = { authorization: 'Bearer secret-tok' };

  try {
    // 401 Unauthorized
    const unauth = await fetch(`${base}/claude/reset-credits?account=c1`, { headers: { authorization: 'Bearer bad' } });
    assert.equal(unauth.status, 401);

    // 405 Method Not Allowed
    const postList = await fetch(`${base}/claude/reset-credits?account=c1`, { method: 'POST', headers: auth });
    assert.equal(postList.status, 405);

    // 400 Bad Request if body on redeem
    const bodyRedeem = await fetch(`${base}/claude/reset-credit?account=c1`, { method: 'POST', headers: auth, body: 'bad' });
    assert.equal(bodyRedeem.status, 400);

    // List tickets
    const listRes = await fetch(`${base}/claude/reset-credits?account=c1`, { headers: auth });
    assert.equal(listRes.status, 200);
    const listJson = await listRes.json() as { credits: Array<{ id: string }> };
    assert.equal(listJson.credits.length, 1);
    assert.equal(listJson.credits[0]!.id, 'grant-test');

    // Operator Redeem
    const redeemRes = await fetch(`${base}/claude/reset-credit?account=c1&credit_id=grant-test`, { method: 'POST', headers: auth });
    assert.equal(redeemRes.status, 200);
    const redeemJson = await redeemRes.json() as { reset: boolean; outcome: string; account: string };
    assert.equal(redeemJson.reset, true);
    assert.equal(redeemJson.outcome, 'reset');
    assert.equal(redeemJson.account, 'claude1@example.com');
  } finally {
    server.close();
    fake.close();
  }
});

test('fleet exhausted does not spend Claude tickets unless claudeResetCredits is explicitly enabled', async () => {
  const fake = await startFakeClaude();
  const provider: Provider = { ...claudeProvider, upstreamBase: fake.url };
  const stored: StoredAccount = { id: 'c1', provider: 'claude', label: 'claude1@example.com', enabled: true, priority: 1, credentialId: 'c1', createdAt: '' };
  const pool = new AccountPool(provider, [stored], {
    c1: { accessToken: 'tok-c1', refreshToken: null, expiresAt: Date.now() + 3_600_000, accountId: 'acc-c1', organizationUuid: 'org-1234' },
  }, { version: 1, accounts: {} });

  const account = pool.accounts[0]!;
  account.usage = 1;
  account.resetCredits = 3;
  account.resetCreditsAt = Date.now();
  account.windows = {
    '5h': { usage: 1, resetsAt: Date.now() + 3_600_000 },
    '7d': { usage: 1, resetsAt: Date.now() + 86_400_000 },
  };

  // Case 1: codexResetCredits: true, but NO claude config -> 0 redemptions
  pool.resetCredits = resetCreditSettings({ codexResetCredits: true });
  const res1 = await pool.redeemForFleet(new Set());
  assert.equal(res1.attempted, false);
  assert.equal(res1.reset, null);
  assert.equal(fake.calls.filter((c) => c.method === 'POST').length, 0);

  // Case 2: claudeResetCredits: true -> redemption proceeds
  pool.resetCredits = resetCreditSettings({ claudeResetCredits: true });
  const res2 = await pool.redeemForFleet(new Set());
  assert.equal(res2.attempted, true);
  assert.equal(res2.reset, account);
  assert.equal(fake.calls.filter((c) => c.method === 'POST').length, 1);

  fake.close();
});
