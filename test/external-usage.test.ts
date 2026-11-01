import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import test from 'node:test';
import { collectAntigravity, collectCommandCode, collectGrok, collectOpencodeGo, ExternalUsageMonitor, externalUsageSettings, parseAgyUsage, parseCommandCodeUsage, parseGrokBilling, parseOpencodeUsage, type ExternalUsage } from '../src/external-usage.js';
import { buildFrame } from '../src/frame.js';
import { redactSnapshot } from '../src/redact.js';
import type { PersistedState, TeamAIConfig } from '../src/types.js';

const KEY = 'sk-opencode-SECRET-123'; const GROK_KEY = 'xai-SECRET-token-456';
const CMD_KEY = 'cmd-secret-token-XYZ-987';

test('agy /usage rows are grouped by name and turned from remaining into used', () => {
  const tsv = [
    'Gemini 4 Argon\tWeekly Limit Remaining\t40%\t2026-10-20T00:00:00Z',
    'Gemini Models\tFive Hour Limit Remaining\t100%\t2026-10-17T09:17:52Z',
    'Claude and GPT models\tFive Hour Limit Remaining\t75%\t2026-10-17T10:00:00Z',
    'Gemini Models\tWeekly Limit Remaining\t62.4%\t2026-10-21T00:00:00Z',
    'Gemini 4 Argon\tFive Hour Limit Remaining\t90%\t2026-10-17T11:00:00Z',
    'broken line without tabs', 'Gemini Models\tWeekly\tninety\tx', 'a\tb\tc',
  ].join('\n');
  const groups = parseAgyUsage(tsv);
  assert.deepEqual(groups.map((g) => g.name), ['Gemini 4 Argon', 'Gemini Models', 'Claude and GPT models']);
  assert.deepEqual(groups[0]!.windows.map((w) => [w.label, w.usedPercent]), [['5h', 10], ['wk', 60]], '5h before weekly');
  assert.deepEqual(groups[1]!.windows.map((w) => w.usedPercent), [0, 38]);
  assert.equal(groups[1]!.windows[0]!.resetsAt, Date.parse('2026-10-17T09:17:52Z'));
  assert.deepEqual(parseAgyUsage(''), []);
});

test('OpenCode Go and Grok answers are read; an unknown shape is an error', () => {
  const open = parseOpencodeUsage({ usage: { rolling: { status: 'ok', percent: 1, resetsAt: '2026-10-17T12:00:00Z' }, weekly: { status: 'ok', percent: 29 }, monthly: { status: 'warn', percent: 20 } } });
  assert.deepEqual(open[0]!.windows.map((w) => [w.label, w.minutes, w.usedPercent]), [['5h', 300, 1], ['wk', 10_080, 29], ['30d', 43_200, 20]]);
  assert.throws(() => parseOpencodeUsage({ nope: 1 }), /unexpected/);
  const credits = parseGrokBilling({ config: { creditUsagePercent: 42, subscriptionTier: 'SuperGrok', currentPeriod: { end: '2026-10-20T00:00:00Z' }, used: { val: 30 }, monthlyLimit: { val: 120 }, billingPeriodEnd: '2026-11-01T00:00:00Z' } });
  assert.equal(credits.tier, 'SuperGrok');
  assert.deepEqual(credits.groups[0]!.windows.map((w) => [w.label, w.usedPercent]), [['wk', 42], ['30d', 25]]);
  const legacy = parseGrokBilling({ creditUsagePercent: 10, billingPeriodEnd: '2026-11-01T00:00:00Z', used: { val: 5 }, monthlyLimit: { val: 0 } });
  assert.deepEqual(legacy.groups[0]!.windows.map((w) => w.label), ['wk'], 'a zero monthly limit is not a window');
  assert.equal(legacy.groups[0]!.windows[0]!.resetsAt, Date.parse('2026-11-01T00:00:00Z'), 'falls back to the billing period end');
  assert.throws(() => parseGrokBilling({}), /unexpected/);
});

test('agy: not installed hides the box; a hang or failure is an error row', async () => {
  const fail = (error: object) => async () => { throw Object.assign(new Error('x'), error); };
  assert.equal(await collectAntigravity({ execFile: fail({ code: 'ENOENT' }) }), null);
  assert.equal((await collectAntigravity({ execFile: fail({ killed: true }) }))?.note, 'agy /usage timed out');
  assert.equal((await collectAntigravity({ execFile: fail({ code: 1 }) }))?.status, 'error');
  let seen: unknown[] = [];
  const ok = await collectAntigravity({ execFile: async (cmd, args, options) => { seen = [cmd, args, options.timeout]; return 'G\tWeekly Limit Remaining\t50%\t2026-10-20T00:00:00Z\n'; } });
  assert.deepEqual(seen, ['agy', ['-p', '/usage'], 20_000]);
  assert.equal(ok?.status, 'ok'); assert.equal(ok?.groups[0]?.windows[0]?.usedPercent, 50);
});

async function fakeHttp(handler: (req: IncomingMessage) => { status: number; body: string; type?: string }) {
  const seen: Array<{ url: string; headers: IncomingMessage['headers'] }> = [];
  const server = createServer((req, res) => { seen.push({ url: req.url ?? '', headers: req.headers }); const answer = handler(req); res.writeHead(answer.status, { 'content-type': answer.type ?? 'application/json' }); res.end(answer.body); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r)); const address = server.address(); assert(address && typeof address !== 'string');
  return { seen, base: `http://127.0.0.1:${address.port}`, close: () => server.close() };
}
const files = (map: Record<string, string>) => async (path: string) => { if (path in map) return map[path]!; throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };

test('OpenCode Go: key from auth.json, then the environment; every answer mapped; the key never comes back', async () => {
  let status = 200; let body = JSON.stringify({ usage: { weekly: { percent: 29 } } }); let type = 'application/json';
  const http = await fakeHttp(() => ({ status, body, type }));
  const auth = { '/h/.local/share/opencode/auth.json': JSON.stringify({ 'opencode-go': { type: 'api', key: KEY } }) };
  const deps = { readFile: files(auth), env: {}, home: '/h', opencodeUrl: `${http.base}/zen/go/v1/usage` };
  try {
    assert.equal(await collectOpencodeGo({ ...deps, readFile: files({}) }), null, 'no key anywhere: no box');
    const ok = await collectOpencodeGo(deps);
    assert.equal(ok?.status, 'ok'); assert.equal(ok?.identity, 'auth.json');
    assert.equal(http.seen[0]!.headers.authorization, `Bearer ${KEY}`); assert.equal(http.seen[0]!.headers.accept, 'application/json');
    assert.equal((await collectOpencodeGo({ ...deps, readFile: files({}), env: { OPENCODE_API_KEY: KEY } }))?.identity, 'env');
    const outcomes: ExternalUsage[] = [];
    for (const [s, b, t] of [[401, '{}', 'application/json'], [403, '{}', 'application/json'], [502, '<html>bad gateway</html>', 'text/html'], [200, '<html>challenge</html>', 'text/html']] as const) { status = s; body = b; type = t; outcomes.push((await collectOpencodeGo(deps))!); }
    assert.deepEqual(outcomes.map((o) => [o.status, o.note]), [['signed-out', 'API key rejected'], ['unavailable', 'no OpenCode Go subscription'], ['error', 'HTTP 502'], ['error', 'unexpected response']]);
    assert.equal(JSON.stringify([ok, outcomes]).includes(KEY), false);
  } finally { http.close(); }
});

test('Grok: no auth file hides the box; expired never calls out; billing read with the CLI headers', async () => {
  let first = 200;
  const http = await fakeHttp((req) => req.url === '/v1/billing?format=credits' && first !== 200 ? { status: first, body: '{}' } : { status: 200, body: JSON.stringify({ config: { creditUsagePercent: 12, subscriptionTier: 'SuperGrok' } }) });
  const signIn = (expires: string) => ({ '/h/.grok/auth.json': JSON.stringify({ 'https://auth.x.ai::0b1c': { key: GROK_KEY, user_id: 'u-1', email: 'jane.doe@gmail.com', team_id: 't', expires_at: expires } }) });
  const deps = { home: '/h', env: { GROK_CLI_CHAT_PROXY_BASE_URL: `${http.base}/` } };
  try {
    assert.equal(await collectGrok({ ...deps, readFile: files({}) }), null);
    assert.equal((await collectGrok({ ...deps, readFile: files({ '/h/.grok/auth.json': '{}' }) }))?.status, 'signed-out');
    const soon = new Date(Date.now() + 2 * 60_000).toISOString();
    const expired = await collectGrok({ ...deps, readFile: files(signIn(soon)) });
    assert.equal(expired?.status, 'expired'); assert.equal(http.seen.length, 0, 'nothing sent with an expiring sign-in');
    const later = new Date(Date.now() + 3_600_000).toISOString();
    const ok = await collectGrok({ ...deps, readFile: files(signIn(later)) });
    assert.equal(ok?.status, 'ok'); assert.equal(ok?.identity, 'SuperGrok ja•••••e@gm•••.com');
    assert.equal(http.seen[0]!.url, '/v1/billing?format=credits');
    assert.equal(http.seen[0]!.headers.authorization, `Bearer ${GROK_KEY}`); assert.equal(http.seen[0]!.headers['x-xai-token-auth'], 'xai-grok-cli'); assert.equal(http.seen[0]!.headers['x-userid'], 'u-1');
    first = 404; const fallback = await collectGrok({ ...deps, readFile: files(signIn(later)) });
    assert.equal(fallback?.status, 'ok'); assert.equal(http.seen.at(-1)!.url, '/v1/billing');
    first = 401; assert.equal((await collectGrok({ ...deps, readFile: files(signIn(later)) }))?.note, 'unauthorized (HTTP 401)');
    assert.equal(JSON.stringify([ok, fallback]).includes(GROK_KEY), false); assert.equal(JSON.stringify(ok).includes('jane.doe'), false);
  } finally { http.close(); }
});

test('the monitor keeps the last good figures for 30 minutes after a failure, backs off, and drops an uninstalled tool', async () => {
  let now = 1_000_000; let next: ExternalUsage | null = null; let calls = 0;
  const reading = (status: ExternalUsage['status']): ExternalUsage => ({ provider: 'grok', status, identity: 'SuperGrok', groups: status === 'ok' ? [{ name: 'Grok', windows: [{ label: 'wk', minutes: 10_080, usedPercent: 10, resetsAt: null }] }] : [], note: status === 'ok' ? null : 'HTTP 500', measuredAt: now, lastOkAt: status === 'ok' ? now : null });
  const none = async () => null;
  const monitor = new ExternalUsageMonitor({ ...externalUsageSettings({}), providers: { antigravity: false, opencodeGo: false, grok: true } }, { now: () => now }, { antigravity: none, opencodeGo: none, grok: async () => { calls++; return next; } });
  next = reading('ok'); await monitor.tick(); assert.equal(monitor.usage.grok?.status, 'ok');
  now += 60_000; next = reading('error'); await monitor.tick(true);
  assert.equal(monitor.usage.grok?.status, 'error'); assert.equal(monitor.usage.grok?.groups.length, 1, 'cached figures kept');
  now += 10_000; await monitor.tick(); assert.equal(calls, 2, 'backing off: 30s not yet passed');
  now += 25_000; await monitor.tick(); assert.equal(calls, 3);
  now += 31 * 60_000; await monitor.tick(true); assert.equal(monitor.usage.grok?.groups.length, 0, 'too old to show');
  next = null; await monitor.tick(true); assert.equal(monitor.usage.grok, undefined);
  const off = new ExternalUsageMonitor({ ...externalUsageSettings({ externalUsage: { enabled: false } }) }, {}, { antigravity: none, opencodeGo: none, grok: async () => { calls++; return null; } });
  const before = calls; await off.tick(true); assert.equal(calls, before);
});

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const plain = (line: string): string => line.replace(ANSI, '');
const config: TeamAIConfig = { version: 1, proxy: { host: '127.0.0.1', claudePort: 3456, codexPort: 3457, clientToken: 't' }, switchThreshold: 0.98, maxConcurrentPerAccount: 3, accounts: [{ id: 'c', provider: 'claude', label: 'c@example.com', enabled: true, priority: null, credentialId: 'c', createdAt: '' }] };
const view = { width: 110, selectedId: null, mode: 'normal' as const, message: '', sortByHeadroom: true };

test('the dashboard draws a box per detected agent and nothing when none is', () => {
  const base: PersistedState = { version: 1, accounts: {} };
  assert.deepEqual(buildFrame(config, { ...base, external: {} }, view), buildFrame(config, base, view), 'no external usage: identical frame');
  const now = Date.now();
  const state: PersistedState = { ...base, external: {
    antigravity: { provider: 'antigravity', status: 'ok', identity: 'agy', groups: [{ name: 'Gemini Models', windows: [{ label: '5h', minutes: 300, usedPercent: 0, resetsAt: now + 3_600_000 }, { label: 'wk', minutes: 10_080, usedPercent: 38, resetsAt: null }] }], note: null, measuredAt: now, lastOkAt: now },
    opencodeGo: { provider: 'opencodeGo', status: 'error', identity: 'auth.json', groups: [{ name: 'OpenCode Go', windows: [{ label: 'wk', minutes: 10_080, usedPercent: 29, resetsAt: null }] }], note: 'HTTP 502', measuredAt: now, lastOkAt: now - 12 * 60_000 },
    grok: { provider: 'grok', status: 'expired', identity: null, groups: [], note: 'sign-in expired — run grok to refresh', measuredAt: now, lastOkAt: null },
  } };
  const lines = buildFrame(config, state, view).map(plain);
  assert.ok(lines.some((l) => l.startsWith('┌─ Antigravity (agy) ')));
  assert.ok(lines.some((l) => /^ {2}Gemini Models +0% 1h +38% +now/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /^ {2}OpenCode Go \(auth\.json\) +29% +12m ago/.test(l)));
  assert.ok(lines.some((l) => l.includes('refresh failed — showing cached data (HTTP 502)')));
  assert.ok(lines.some((l) => l.trim() === 'sign-in expired — run grok to refresh'));
  assert.ok(lines.indexOf(lines.find((l) => l.startsWith('┌─ Grok'))!) < lines.findIndex((l) => l.startsWith(' Activity')));
  assert.ok(lines.every((l) => [...l].length <= 110));
  const short = buildFrame(config, state, { ...view, height: 24 }).map(plain);
  assert.equal(short.length, 24); assert.ok(short.some((l) => l.startsWith(' Activity')), 'the activity pane keeps its room');
});

test('capture redaction masks or drops the other agents\' identities', () => {
  const state: PersistedState = { version: 1, accounts: {}, external: { grok: { provider: 'grok', status: 'ok', identity: 'SuperGrok jane.doe@gmail.com', groups: [], note: null, measuredAt: 1, lastOkAt: 1 } } };
  assert.equal(JSON.stringify(redactSnapshot(config, state, 'partial').state).includes('jane.doe@gmail.com'), false);
  assert.equal(redactSnapshot(config, state, 'full').state.external?.grok?.identity, null);
});

const CMD_CREDITS_FIXTURE = {
  credits: {
    belowThreshold: false,
    creditThreshold: 0,
    monthlyCredits: 69.995,
    purchasedCredits: 0,
    freeCredits: 0,
  },
  windowLimits: {
    limited: true,
    exceeded: null,
    fiveHour: {
      used: 0.005,
      cap: 14,
      exceeded: false,
      resetAt: 1793542930268,
    },
    weekly: {
      used: 0.005,
      cap: 35,
      exceeded: false,
      resetAt: 1794129730268,
    },
  },
};
const CMD_SUB_FIXTURE = {
  success: true,
  data: {
    id: 'sub-fake-123',
    status: 'active',
    planId: 'individual-goat',
    currentPeriodEnd: '2026-12-01T09:15:36.000Z',
  },
};
const CMD_WHOAMI_FIXTURE = {
  success: true,
  user: {
    id: 'u-cmd-1',
    name: 'Jane Doe',
    email: 'jane.doe@example.com',
    userName: 'janedoe',
  },
  org: null,
};

test('parseCommandCodeUsage parses rolling, weekly and monthly limits; unexpected shape throws', () => {
  const parsed = parseCommandCodeUsage(CMD_CREDITS_FIXTURE, CMD_SUB_FIXTURE);
  assert.equal(parsed.plan, 'GOAT');
  assert.deepEqual(parsed.groups[0]!.name, 'Command Code');
  assert.deepEqual(parsed.groups[0]!.windows.map((w) => [w.label, w.minutes, w.usedPercent]), [
    ['5h', 300, 0],
    ['wk', 10_080, 0],
    ['30d', 43_200, 0],
  ]);
  assert.equal(parsed.groups[0]!.windows[0]!.resetsAt, 1793542930268);
  assert.equal(parsed.groups[0]!.windows[2]!.resetsAt, Date.parse('2026-12-01T09:15:36.000Z'));
  assert.throws(() => parseCommandCodeUsage({}), /unexpected/);
  assert.throws(() => parseCommandCodeUsage({ windowLimits: { limited: false } }), /unexpected/);
});

test('Command Code: normal response, signed out, CLI missing, malformed shape, token leak prevention', async () => {
  let status = 200;
  let creditsBody = JSON.stringify(CMD_CREDITS_FIXTURE);
  const http = await fakeHttp((req) => {
    if (status !== 200) return { status, body: status === 502 ? '<html>gateway</html>' : '{}', type: status === 502 ? 'text/html' : 'application/json' };
    if (req.url === '/alpha/billing/credits') return { status: 200, body: creditsBody };
    if (req.url === '/alpha/billing/subscriptions') return { status: 200, body: JSON.stringify(CMD_SUB_FIXTURE) };
    if (req.url === '/alpha/whoami?limits=1') return { status: 200, body: JSON.stringify(CMD_WHOAMI_FIXTURE) };
    return { status: 404, body: '{}' };
  });

  const authFile = { '/h/.commandcode/auth.json': JSON.stringify({ apiKey: CMD_KEY, userName: 'janedoe' }) };
  const deps = { home: '/h', readFile: files(authFile), commandCodeUrl: http.base, env: {} };

  try {
    // 1. CLI 없음: auth.json 없고 execFile 이 ENOENT -> null
    const noCli = await collectCommandCode({ home: '/h', readFile: files({}), commandCodeUrl: http.base, env: {}, execFile: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } });
    assert.equal(noCli, null, 'CLI not installed: returns null (no box)');

    // 2. 로그인 안 됨: auth.json 은 없으나 CLI 는 설치되어 있는 경우
    const cliInstalledNoAuth = await collectCommandCode({ home: '/h', readFile: files({}), commandCodeUrl: http.base, env: {}, execFile: async () => 'command-code v1.88.2\n' });
    assert.equal(cliInstalledNoAuth?.status, 'signed-out');
    assert.equal(cliInstalledNoAuth?.note, 'not signed in — run command-code login');

    // 2-1. 로그인 안 됨: auth.json 이 빈 객체
    const emptyAuth = await collectCommandCode({ home: '/h', readFile: files({ '/h/.commandcode/auth.json': '{}' }), commandCodeUrl: http.base, env: {} });
    assert.equal(emptyAuth?.status, 'signed-out');

    // 3. 정상 응답
    const ok = await collectCommandCode(deps);
    assert.equal(ok?.status, 'ok');
    assert.equal(ok?.identity, 'GOAT ja•••••e@ex•••••.com');
    assert.equal(ok?.groups[0]?.windows.length, 3);
    assert.equal(http.seen[0]!.headers.authorization, `Bearer ${CMD_KEY}`);

    // 3-1. 환경 변수로 키 제공
    const envOk = await collectCommandCode({ home: '/h', readFile: files({}), commandCodeUrl: http.base, env: { COMMAND_CODE_API_KEY: CMD_KEY } });
    assert.equal(envOk?.status, 'ok');

    // 4. 상태 코드 및 이상한 모양 매핑
    const outcomes: ExternalUsage[] = [];
    for (const s of [401, 403, 502]) {
      status = s;
      outcomes.push((await collectCommandCode(deps))!);
    }
    status = 200;
    creditsBody = JSON.stringify({ invalid: 'shape' });
    outcomes.push((await collectCommandCode(deps))!);

    assert.deepEqual(outcomes.map((o) => [o.status, o.note]), [
      ['signed-out', 'API key rejected — run command-code login'],
      ['unavailable', 'no Command Code subscription'],
      ['error', 'HTTP 502'],
      ['error', 'unexpected response'],
    ]);

    // 5. 토큰 비노출: 어떤 출력이나 오류 객체에도 시크릿 토큰 및 원본 이메일 미포함
    const all = [ok, envOk, ...outcomes];
    assert.equal(JSON.stringify(all).includes(CMD_KEY), false);
    assert.equal(JSON.stringify(all).includes('jane.doe@example.com'), false);
  } finally {
    http.close();
  }
});

test('dashboard renders commandCode box with identity and gauges', () => {
  const now = Date.now();
  const state: PersistedState = {
    version: 1,
    accounts: {},
    external: {
      commandCode: {
        provider: 'commandCode',
        status: 'ok',
        identity: 'GOAT ja•••••e@ex•••••.com',
        groups: [{
          name: 'Command Code',
          windows: [
            { label: '5h', minutes: 300, usedPercent: 0, resetsAt: now + 3_600_000 },
            { label: 'wk', minutes: 10_080, usedPercent: 0, resetsAt: now + 7 * 86_400_000 },
            { label: '30d', minutes: 43_200, usedPercent: 0, resetsAt: now + 30 * 86_400_000 },
          ],
        }],
        note: null,
        measuredAt: now,
        lastOkAt: now,
      },
    },
  };
  const lines = buildFrame(config, state, view).map(plain);
  assert.ok(lines.some((l) => l.startsWith('┌─ Command Code ')));
  assert.ok(lines.some((l) => l.includes('Command Code GOAT ja•••••e@ex•••••.com')));
});

test('ExternalUsageMonitor default wiring reads commandCode via collectCommandCode', async () => {
  const http = await fakeHttp((req) => {
    if (req.url === '/alpha/billing/credits') return { status: 200, body: JSON.stringify(CMD_CREDITS_FIXTURE) };
    if (req.url === '/alpha/billing/subscriptions') return { status: 200, body: JSON.stringify(CMD_SUB_FIXTURE) };
    if (req.url === '/alpha/whoami?limits=1') return { status: 200, body: JSON.stringify(CMD_WHOAMI_FIXTURE) };
    return { status: 404, body: '{}' };
  });

  const authFile = { '/h/.commandcode/auth.json': JSON.stringify({ apiKey: CMD_KEY, userName: 'janedoe' }) };
  const deps = { home: '/h', readFile: files(authFile), commandCodeUrl: http.base, env: {} };
  const settings = {
    ...externalUsageSettings({}),
    providers: { antigravity: false, opencodeGo: false, grok: false, commandCode: true },
  };

  try {
    const monitor = new ExternalUsageMonitor(settings, deps);
    await monitor.tick(true);
    assert.equal(monitor.usage.commandCode?.status, 'ok');
    assert.equal(monitor.usage.commandCode?.identity, 'GOAT ja•••••e@ex•••••.com');
    assert.equal(monitor.usage.commandCode?.groups[0]?.windows.length, 3);
  } finally {
    http.close();
  }
});
