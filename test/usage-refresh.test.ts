import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AccountPool } from '../src/account-pool.js';
import { claudeProvider, codexProvider, providers } from '../src/providers.js';
import type { RunningServer } from '../src/runtime.js';
import { anyPorts, startOnAnyPorts } from './server-ports.js';
import { defaultConfig, loadConfig, saveConfig } from '../src/storage.js';
import { UsageRefresher, defaultUsageJitter } from '../src/usage-refresh.js';
import type { OAuthCredential, PersistedState, Provider, StoredAccount, TeamAIConfig } from '../src/types.js';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

function fakeClock(start: number, settle: () => Promise<void> = flush) {
  type FakeTimer = { at: number; fn: () => void; unref(): void };
  let now = start;
  const timers = new Set<FakeTimer>();
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => {
      const timer: FakeTimer = { at: now + Math.max(0, ms), fn, unref() {} };
      timers.add(timer);
      return timer;
    },
    clearTimeout: (timer: { at?: number; fn?: () => void; unref?: () => void }) => {
      timers.delete(timer as FakeTimer);
    },
    async advance(ms: number) {
      const target = now + ms;
      while (true) {
        const due = [...timers].filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        now = due.at;
        timers.delete(due);
        due.fn();
        await settle();
      }
      now = target;
      await settle();
    },
    pending: () => timers.size,
  };
}


const storedAccount = (
  provider: 'claude' | 'codex',
  id: string,
  enabled = true,
  priority: number | null = null,
): StoredAccount => ({
  id,
  provider,
  label: `${id}@example.com`,
  enabled,
  priority,
  credentialId: `${provider}:${id}`,
  createdAt: '',
});

const makeCredential = (id: string, expiresAt: number | null): OAuthCredential => ({
  accessToken: `tok-${id}`,
  refreshToken: `ref-${id}`,
  expiresAt,
  accountId: id,
});

for (const delayed of [false, true]) {
  test(`idle Claude and Codex accounts refresh periodically with per-account jitter and renew expiring tokens first${delayed ? ' with delayed HTTP' : ''}`, async (t) => {
    const start = 1_700_000_000_000;
    const probes = new Set<Promise<boolean>>();
    // Keep virtual time at the current deadline until real HTTP and quota application finish.
    const clock = fakeClock(start, async () => {
      await Promise.all(probes);
      await flush();
    });
    const claudeReads: Array<{ token: string; at: number }> = [];
    const codexReads: Array<{ accountId: string; token: string; at: number }> = [];
    const refreshedTokens: string[] = [];

    let claudeStep = 0;
    let codexStep = 0;

    const waitForHttp = async () => {
      if (delayed) for (let i = 0; i < 32; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    };
    const fakeClaudeUpstream = createServer(async (req, res) => {
      req.resume();
      await waitForHttp();
      if (req.url === '/api/oauth/usage') {
        const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
        claudeReads.push({ token, at: clock.now() });
        claudeStep++;
        const reset5h = new Date(clock.now() + 5 * 3_600_000).toISOString();
        const reset7d = new Date(clock.now() + 7 * 86_400_000).toISOString();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          five_hour: { utilization: claudeStep * 15, resets_at: reset5h },
          seven_day: { utilization: claudeStep * 10, resets_at: reset7d },
        }));
        return;
      }
      res.writeHead(404).end();
    });

    const fakeCodexUpstream = createServer(async (req, res) => {
      req.resume();
      await waitForHttp();
      if (req.url === '/wham/usage') {
        const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
        const accountId = String(req.headers['chatgpt-account-id'] ?? '');
        codexReads.push({ accountId, token, at: clock.now() });
        codexStep++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          rate_limit: {
            primary_window: { used_percent: codexStep * 20, reset_at: Math.floor((clock.now() + 5 * 3_600_000) / 1000), limit_window_seconds: 18_000 },
            secondary_window: { used_percent: codexStep * 12, reset_at: Math.floor((clock.now() + 7 * 86_400_000) / 1000), limit_window_seconds: 604_800 },
          },
        }));
        return;
      }
      res.writeHead(404).end();
    });

    await new Promise<void>((r) => fakeClaudeUpstream.listen(0, '127.0.0.1', r));
    await new Promise<void>((r) => fakeCodexUpstream.listen(0, '127.0.0.1', r));
    const claudeAddr = fakeClaudeUpstream.address();
    const codexAddr = fakeCodexUpstream.address();
    assert(claudeAddr && typeof claudeAddr !== 'string');
    assert(codexAddr && typeof codexAddr !== 'string');

    const customClaude: Provider = {
      ...claudeProvider,
      upstreamBase: `http://127.0.0.1:${claudeAddr.port}`,
      refresh: async (cred) => {
        refreshedTokens.push(cred.accountId);
        return { ...cred, accessToken: `renewed-${cred.accountId}`, expiresAt: clock.now() + 3_600_000 };
      },
    };
    const customCodex: Provider = {
      ...codexProvider,
      upstreamBase: `http://127.0.0.1:${codexAddr.port}`,
      refresh: async (cred) => {
        refreshedTokens.push(cred.accountId);
        return { ...cred, accessToken: `renewed-${cred.accountId}`, expiresAt: clock.now() + 3_600_000 };
      },
    };

    try {
      const state: PersistedState = {
        version: 1,
        accounts: {
          'claude:idle-c': { usage: 0.05, resetsAt: start + 3_600_000, measuredAt: start, windows: { '5h': { usage: 0.05, resetsAt: start + 3_600_000 } }, profile: null, cooldownUntil: null, lastUsed: null, error: null },
          'codex:idle-x': { usage: 0.08, resetsAt: start + 3_600_000, measuredAt: start, windows: { primary: { usage: 0.08, resetsAt: start + 3_600_000, minutes: 300 } }, profile: null, cooldownUntil: null, lastUsed: null, error: null },
        },
      };
      // Claude token is expiring within 2 minutes (< 5m margin), Codex token is valid for an hour.
      const claudePool = new AccountPool(
        customClaude,
        [storedAccount('claude', 'idle-c', true, 2)],
        { 'claude:idle-c': makeCredential('idle-c', start + 2 * 60_000) },
        state,
      );
      const codexPool = new AccountPool(
        customCodex,
        [storedAccount('codex', 'idle-x', true, 2)],
        { 'codex:idle-x': makeCredential('idle-x', start + 60 * 60_000) },
        state,
      );

      for (const pool of [claudePool, codexPool]) {
        const refresh = pool.refreshUsageAccount.bind(pool);
        t.mock.method(pool, 'refreshUsageAccount', (...args: Parameters<typeof refresh>) => {
          const probe = refresh(...args);
          probes.add(probe);
          void probe.then(() => probes.delete(probe), () => probes.delete(probe));
          return probe;
        });
      }

      const intervalMs = 5 * 60_000;
      const jitterMaxMs = 20_000;
      const refresher = new UsageRefresher([claudePool, codexPool], {
        intervalMs,
        jitterMaxMs,
        nowFn: clock.now,
        setTimeoutFn: clock.setTimeout,
        clearTimeoutFn: clock.clearTimeout,
      });

      t.after(() => refresher.stop());
      refresher.start();
      await flush();
      // Readings were fresh at `start`, so neither fires before `intervalMs`.
      assert.equal(claudeReads.length, 0);
      assert.equal(codexReads.length, 0);

      await clock.advance(intervalMs - 1);
      assert.equal(claudeReads.length, 0);
      assert.equal(codexReads.length, 0);

      // Advance past interval + max jitter: both idle accounts are probed once, at jittered timestamps.
      await clock.advance(jitterMaxMs + 1);
      assert.equal(claudeReads.length, 1);
      assert.equal(codexReads.length, 1);
      assert.deepEqual(refreshedTokens, ['idle-c'], 'expiring Claude token was refreshed before calling /api/oauth/usage');
      assert.equal(claudeReads[0]!.token, 'renewed-idle-c');
      assert.equal(codexReads[0]!.token, 'tok-idle-x');

      const expectedClaudeJitter0 = defaultUsageJitter('claude:idle-c', 0, jitterMaxMs);
      const expectedCodexJitter0 = defaultUsageJitter('codex:idle-x', 0, jitterMaxMs);
      assert.equal(claudeReads[0]!.at, start + intervalMs + expectedClaudeJitter0);
      assert.equal(codexReads[0]!.at, start + intervalMs + expectedCodexJitter0);
      assert.notEqual(claudeReads[0]!.at, codexReads[0]!.at, 'per-account jitter separates probe times');

      assert.equal(claudePool.accounts[0]!.windows['5h']?.usage, 0.15);
      assert.equal(claudePool.accounts[0]!.windows['7d']?.usage, 0.10);
      assert.equal(codexPool.accounts[0]!.windows.primary?.usage, 0.20);
      assert.equal(codexPool.accounts[0]!.windows.secondary?.usage, 0.12);

      // Advance another full cycle: both idle accounts refresh a second time.
      await clock.advance(intervalMs + jitterMaxMs);
      assert.equal(claudeReads.length, 2);
      assert.equal(codexReads.length, 2);
      assert.equal(claudePool.accounts[0]!.windows['5h']?.usage, 0.30);
      assert.equal(codexPool.accounts[0]!.windows.primary?.usage, 0.40);

      refresher.stop();
    } finally {
      fakeClaudeUpstream.close();
      fakeCodexUpstream.close();
    }
  });

}

test('disabled and retired accounts are excluded from periodic usage probing and direct refreshUsage', async () => {
  const start = 1_700_000_000_000;
  const clock = fakeClock(start);
  const seen: string[] = [];

  const usageProvider: Provider = {
    ...codexProvider,
    fetchUsage: async (cred) => {
      seen.push(cred.accountId);
      return {
        routingUsage: 0.25,
        routingResetsAt: clock.now() + 3_600_000,
        windows: { primary: { usage: 0.25, resetsAt: clock.now() + 3_600_000, minutes: 300 } },
      };
    },
  };

  const accounts = [
    storedAccount('codex', 'enabled-a', true, 1),
    storedAccount('codex', 'disabled-b', false, 2),
    storedAccount('codex', 'retired-c', true, 3),
  ];
  const creds = {
    'codex:enabled-a': makeCredential('enabled-a', start + 3_600_000),
    'codex:disabled-b': makeCredential('disabled-b', start + 3_600_000),
    'codex:retired-c': makeCredential('retired-c', start + 3_600_000),
  };
  const pool = new AccountPool(usageProvider, accounts, creds, { version: 1, accounts: {} });
  pool.accounts.find((a) => a.id === 'retired-c')!.retired = true;

  const refresher = new UsageRefresher([pool], {
    intervalMs: 60_000,
    jitterMaxMs: 5_000,
    nowFn: clock.now,
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
  });

  refresher.start();
  await flush();
  assert.deepEqual(seen, ['enabled-a'], 'only enabled, non-retired account is probed initially');

  await clock.advance(180_000);
  assert.ok(seen.length >= 3);
  assert.ok(seen.every((id) => id === 'enabled-a'), `disabled/retired accounts must never be probed, got: ${seen.join(', ')}`);

  // Direct pool methods also skip disabled/retired accounts.
  seen.length = 0;
  await pool.refreshUsage(0);
  assert.deepEqual(seen, ['enabled-a']);
  assert.equal(await pool.refreshUsageAccount(pool.accounts.find((a) => a.id === 'disabled-b')!), false);
  assert.equal(await pool.refreshUsageAccount(pool.accounts.find((a) => a.id === 'retired-c')!), false);
  assert.deepEqual(seen, ['enabled-a']);

  refresher.stop();
});

test('failed usage probes back off exponentially and return to normal cadence after recovery', async () => {
  const start = 1_700_000_000_000;
  const clock = fakeClock(start);
  const attempts: number[] = [];
  let shouldFail = true;

  const flakyProvider: Provider = {
    ...claudeProvider,
    fetchUsage: async () => {
      attempts.push(clock.now() - start);
      if (shouldFail) throw new Error('Claude usage failed (503)');
      return {
        routingUsage: 0.42,
        routingResetsAt: clock.now() + 3_600_000,
        windows: { '5h': { usage: 0.42, resetsAt: clock.now() + 3_600_000 } },
      };
    },
  };

  const pool = new AccountPool(
    flakyProvider,
    [storedAccount('claude', 'flaky', true)],
    { 'claude:flaky': makeCredential('flaky', start + 3_600_000) },
    { version: 1, accounts: {} },
  );

  const refresher = new UsageRefresher([pool], {
    intervalMs: 300_000,
    jitterMaxMs: 0,
    backoffBaseMs: 30_000,
    backoffMaxMs: 120_000,
    nowFn: clock.now,
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
  });

  refresher.start();
  await flush();
  // Attempt 1 at t=0 fails -> next retry at +30s
  assert.deepEqual(attempts, [0]);

  await clock.advance(29_999);
  assert.deepEqual(attempts, [0], 'backed off before 30s');
  await clock.advance(1);
  // Attempt 2 at t=30s fails -> next retry at +60s (t=90s)
  assert.deepEqual(attempts, [0, 30_000]);

  await clock.advance(59_999);
  assert.deepEqual(attempts, [0, 30_000], 'backed off before +60s');
  await clock.advance(1);
  // Attempt 3 at t=90s fails -> next retry at +120s (t=210s)
  assert.deepEqual(attempts, [0, 30_000, 90_000]);

  // Recover before the 120s retry fires.
  shouldFail = false;
  await clock.advance(120_000);
  // Attempt 4 at t=210s succeeds -> usage updated, next refresh returns to normal 300s interval (t=510s).
  assert.deepEqual(attempts, [0, 30_000, 90_000, 210_000]);
  assert.equal(pool.accounts[0]!.usage, 0.42);

  await clock.advance(299_999);
  assert.equal(attempts.length, 4, 'no early retry after recovery');
  await clock.advance(1);
  assert.deepEqual(attempts, [0, 30_000, 90_000, 210_000, 510_000]);

  refresher.stop();
});

test('concurrency limit caps simultaneous in-flight usage probes across the fleet', async () => {
  const start = 1_700_000_000_000;
  const clock = fakeClock(start);
  let active = 0;
  let maxActive = 0;
  const startedOrder: string[] = [];
  const releases: Array<() => void> = [];

  const gatedProvider: Provider = {
    ...codexProvider,
    fetchUsage: (cred) =>
      new Promise((resolve) => {
        active++;
        maxActive = Math.max(maxActive, active);
        startedOrder.push(cred.accountId);
        releases.push(() => {
          active--;
          resolve({
            routingUsage: 0.1,
            routingResetsAt: clock.now() + 3_600_000,
            windows: { primary: { usage: 0.1, resetsAt: clock.now() + 3_600_000, minutes: 300 } },
          });
        });
      }),
  };

  const ids = ['a1', 'a2', 'a3', 'a4', 'a5'];
  const pool = new AccountPool(
    gatedProvider,
    ids.map((id) => storedAccount('codex', id, true)),
    Object.fromEntries(ids.map((id) => [`codex:${id}`, makeCredential(id, start + 3_600_000)])),
    { version: 1, accounts: {} },
  );

  const refresher = new UsageRefresher([pool], {
    concurrency: 2,
    intervalMs: 300_000,
    jitterMaxMs: 0,
    nowFn: clock.now,
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
  });

  refresher.start();
  await flush();

  assert.equal(active, 2, 'only 2 probes run concurrently despite 5 due accounts');
  assert.equal(startedOrder.length, 2);

  while (releases.length > 0) {
    const release = releases.shift()!;
    release();
    await flush();
    assert.ok(active <= 2, `active probes (${active}) exceeded concurrency cap 2`);
  }

  assert.equal(maxActive, 2);
  assert.deepEqual(startedOrder, ids);
  assert.ok(pool.accounts.every((a) => a.usage === 0.1));

  refresher.stop();
});

test('POST /reload updates usage refresh targets and persists refreshed state across restart', async () => {
  const start = 1_700_000_000_000;
  const clock = fakeClock(start);
  const probed: string[] = [];

  const up = createServer((req, res) => {
    req.resume();
    if (req.url === '/wham/usage') {
      const account = String(req.headers['chatgpt-account-id'] ?? '');
      probed.push(`codex:${account}`);
      const used = account === 'a' ? 25 : account === 'b' ? 55 : 75;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        rate_limit: {
          primary_window: { used_percent: used, reset_at: Math.floor((clock.now() + 5 * 3_600_000) / 1000), limit_window_seconds: 18_000 },
          secondary_window: { used_percent: used - 5, reset_at: Math.floor((clock.now() + 7 * 86_400_000) / 1000), limit_window_seconds: 604_800 },
        },
      }));
      return;
    }
    if (req.url === '/api/oauth/usage') {
      const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+tok-/i, '');
      probed.push(`claude:${token}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        five_hour: { utilization: 33, resets_at: new Date(clock.now() + 5 * 3_600_000).toISOString() },
        seven_day: { utilization: 44, resets_at: new Date(clock.now() + 7 * 86_400_000).toISOString() },
      }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => up.listen(0, '127.0.0.1', r));
  const upAddr = up.address();
  assert(upAddr && typeof upAddr !== 'string');
  const baseUrl = `http://127.0.0.1:${upAddr.port}`;

  const root = await mkdtemp(join(tmpdir(), 'teamai-usage-refresh-'));
  const prevHome = process.env.TEAMAI_HOME;
  process.env.TEAMAI_HOME = root;
  const origCodexBase = providers.codex.upstreamBase;
  const origClaudeBase = providers.claude.upstreamBase;
  providers.codex.upstreamBase = baseUrl;
  providers.claude.upstreamBase = baseUrl;

  const token = 'test-control-token';
  let server: RunningServer | undefined;
  try {
    const config = defaultConfig();
    config.proxy = {
      ...config.proxy,
      ...anyPorts,
      clientToken: token,
    };
    config.warmup = { enabled: false };
    // Start with codex:a enabled and codex:b disabled.
    config.accounts = [
      storedAccount('codex', 'a', true, 1),
      storedAccount('codex', 'b', false, 2),
    ];
    await saveConfig(config);
    await writeFile(
      join(root, 'credentials.json'),
      JSON.stringify({
        'codex:a': makeCredential('a', start + 86_400_000),
        'codex:b': makeCredential('b', start + 86_400_000),
        'claude:c': makeCredential('c', start + 86_400_000),
      }),
    );
    await writeFile(join(root, 'state.json'), JSON.stringify({ version: 1, accounts: {}, events: [] }));

    server = await startOnAnyPorts(config, {
      background: false,
      usageRefresh: {
        intervalMs: 60_000,
        jitterMaxMs: 0,
        nowFn: clock.now,
        setTimeoutFn: clock.setTimeout,
        clearTimeoutFn: clock.clearTimeout,
      },
    });
    await flush();

    // Initially only enabled codex:a is probed; disabled codex:b is untouched.
    assert.deepEqual(probed, ['codex:a']);

    await clock.advance(60_000);
    assert.deepEqual(probed, ['codex:a', 'codex:a']);

    // Now disable codex:a, enable codex:b, and add enabled claude:c, then POST /reload.
    const edited: TeamAIConfig = await loadConfig();
    edited.accounts.find((x) => x.id === 'a')!.enabled = false;
    edited.accounts.find((x) => x.id === 'b')!.enabled = true;
    edited.accounts.push(storedAccount('claude', 'c', true, 1));
    await saveConfig(edited);

    probed.length = 0;
    const reloadRes = await fetch(`http://127.0.0.1:${config.proxy.controlPort}/reload`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(reloadRes.status, 200);
    await flush();

    // Newly enabled codex:b and newly added claude:c are probed immediately; disabled codex:a is not.
    assert.deepEqual([...probed].sort(), ['claude:c', 'codex:b']);

    probed.length = 0;
    await clock.advance(60_000);
    assert.deepEqual([...probed].sort(), ['claude:c', 'codex:b'], 'periodic ticks only probe b and c after reload');
    assert.equal(probed.includes('codex:a'), false, 'disabled account a is no longer probed');

    const running = server;
    server = undefined;
    await running.stop();

    // Verify persisted state.json has the refreshed usage and survives reconstructing pools on restart.
    const savedState = JSON.parse(await readFile(join(root, 'state.json'), 'utf8')) as PersistedState;
    assert.equal(savedState.accounts['codex:b']?.usage, 0.55);
    assert.equal(savedState.accounts['codex:b']?.windows?.primary?.usage, 0.55);
    assert.equal(savedState.accounts['codex:b']?.windows?.secondary?.usage, 0.50);
    assert.equal(savedState.accounts['claude:c']?.usage, 0.44);
    assert.equal(savedState.accounts['claude:c']?.windows?.['5h']?.usage, 0.33);
    assert.equal(savedState.accounts['claude:c']?.windows?.['7d']?.usage, 0.44);

    const creds = JSON.parse(await readFile(join(root, 'credentials.json'), 'utf8')) as Record<string, OAuthCredential>;
    const restartedClaude = new AccountPool(providers.claude, edited.accounts, creds, savedState);
    const restartedCodex = new AccountPool(providers.codex, edited.accounts, creds, savedState);
    assert.equal(restartedClaude.accounts.find((x) => x.id === 'c')?.windows['7d']?.usage, 0.44);
    assert.equal(restartedCodex.accounts.find((x) => x.id === 'b')?.windows.primary?.usage, 0.55);
  } finally {
    await server?.stop();
    providers.codex.upstreamBase = origCodexBase;
    providers.claude.upstreamBase = origClaudeBase;
    up.close();
    if (prevHome === undefined) delete process.env.TEAMAI_HOME;
    else process.env.TEAMAI_HOME = prevHome;
    await rm(root, { recursive: true, force: true });
  }
});

test('startServer with background enabled automatically probes enabled idle accounts and skips disabled ones', async () => {
  const probed: string[] = [];
  const up = createServer((req, res) => {
    req.resume();
    if (req.url === '/api/oauth/usage') {
      const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+tok-/i, '');
      probed.push(`claude:${token}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        five_hour: { utilization: 18, resets_at: new Date(Date.now() + 5 * 3_600_000).toISOString() },
        seven_day: { utilization: 27, resets_at: new Date(Date.now() + 7 * 86_400_000).toISOString() },
      }));
      return;
    }
    if (req.url === '/api/oauth/profile') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ account: { has_claude_max: true }, organization: { subscription_status: 'active' } }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => up.listen(0, '127.0.0.1', r));
  const upAddr = up.address();
  assert(upAddr && typeof upAddr !== 'string');

  const root = await mkdtemp(join(tmpdir(), 'teamai-bg-usage-'));
  const prevHome = process.env.TEAMAI_HOME;
  process.env.TEAMAI_HOME = root;
  const origClaudeBase = providers.claude.upstreamBase;
  providers.claude.upstreamBase = `http://127.0.0.1:${upAddr.port}`;

  let server: RunningServer | undefined;
  try {
    const config = defaultConfig();
    config.proxy = {
      ...config.proxy,
      ...anyPorts,
      clientToken: 'bg-token',
    };
    config.warmup = { enabled: false };
    config.externalUsage = { enabled: false };
    config.accounts = [
      storedAccount('claude', 'idle-enabled', true, 2),
      storedAccount('claude', 'idle-disabled', false, 3),
    ];
    await saveConfig(config);
    await writeFile(
      join(root, 'credentials.json'),
      JSON.stringify({
        'claude:idle-enabled': makeCredential('idle-enabled', Date.now() + 86_400_000),
        'claude:idle-disabled': makeCredential('idle-disabled', Date.now() + 86_400_000),
      }),
    );
    await writeFile(join(root, 'state.json'), JSON.stringify({ version: 1, accounts: {}, events: [] }));

    server = await startOnAnyPorts(config, { background: true });
    for (let i = 0; i < 30 && probed.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.deepEqual(probed, ['claude:idle-enabled']);

    const running = server;
    server = undefined;
    await running.stop();

    const savedState = JSON.parse(await readFile(join(root, 'state.json'), 'utf8')) as PersistedState;
    assert.equal(savedState.accounts['claude:idle-enabled']?.windows?.['5h']?.usage, 0.18);
    assert.equal(savedState.accounts['claude:idle-enabled']?.windows?.['7d']?.usage, 0.27);
    assert.equal(savedState.accounts['claude:idle-disabled']?.usage, null);
  } finally {
    await server?.stop();
    providers.claude.upstreamBase = origClaudeBase;
    up.close();
    if (prevHome === undefined) delete process.env.TEAMAI_HOME;
    else process.env.TEAMAI_HOME = prevHome;
    await rm(root, { recursive: true, force: true });
  }
});
