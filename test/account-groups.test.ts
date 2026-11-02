import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { prepareClaudeArgs } from '../src/claude-session-control.js';
import { claudeProvider } from '../src/providers.js';
import { defaultConfig, loadSessions, saveConfig, saveCredentials } from '../src/storage.js';
import { startOnAnyPorts } from './server-ports.js';

async function rig(t: test.TestContext, groups?: Record<string, string[]>) {
  const hits: string[] = [];
  const upstream = createServer((req, res) => { hits.push(String(req.headers.authorization)); req.resume(); req.once('end', () => res.end('{}')); });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address(); assert(address && typeof address !== 'string');
  const previous = claudeProvider.upstreamBase; claudeProvider.upstreamBase = `http://127.0.0.1:${address.port}`;
  const config = Object.assign(defaultConfig(), groups === undefined ? {} : { groups });
  config.accounts = ['outside', 'a', 'b'].map((id, index) => ({ id, provider: 'claude', label: `${id}@example.test`, enabled: true, priority: index + 1, credentialId: id, createdAt: '' }));
  await saveConfig(config);
  const credentials = Object.fromEntries(config.accounts.map((a) => [a.id, { accountId: a.id, accessToken: `fake-${a.id}`, refreshToken: null, expiresAt: Date.now() + 86_400_000 }]));
  await saveCredentials(credentials);
  let server: Awaited<ReturnType<typeof startOnAnyPorts>> | undefined;
  t.after(async () => { await server?.stop(); claudeProvider.upstreamBase = previous; upstream.closeAllConnections(); upstream.close(); });
  const start = async () => { server = await startOnAnyPorts(config); };
  const send = async (id: string) => {
    const response = await fetch(`http://127.0.0.1:${config.proxy.claudePort}/v1/messages`, { method: 'POST', headers: { authorization: `Bearer ${config.proxy.clientToken}`, 'x-claude-code-session-id': id, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-sonnet', messages: [{ role: 'user', content: 'synthetic' }] }) });
    await response.text(); return response.status;
  };
  const cool = async (ids: string[]) => {
    const { saveState } = await import('../src/storage.js');
    await saveState({ version: 1, accounts: Object.fromEntries(ids.map((id) => [id, { usage: 1, resetsAt: Date.now() + 3600_000, cooldownUntil: Date.now() + 3600_000, cooldownReason: 'quota' as const, lastUsed: null, error: null }])) });
  };
  return { config, credentials, start, send, hits, cool, stop: async () => { await server?.stop(); server = undefined; } };
}

test('no groups preserves unrestricted initial selection', async (t) => {
  const r = await rig(t); await r.start();
  const args = await prepareClaudeArgs([], r.config);
  assert.equal(await r.send(args[1]!), 200); assert.deepEqual(r.hits, ['Bearer fake-outside']);
});

test('group flag is consumed and the relay selects only group members by existing priority', async (t) => {
  const r = await rig(t, { master: ['a@example.test', 'b'] }); await r.start();
  const args = await prepareClaudeArgs(['--group', 'master', '--print', 'synthetic'], r.config);
  assert.deepEqual(args.slice(2), ['--print', 'synthetic']);
  assert.equal(await r.send(args[1]!), 200); assert.deepEqual(r.hits, ['Bearer fake-a']);
  assert.equal((await loadSessions())[args[1]!]!.group, 'master');
});

test('new group session skips a cooling member and selects the next member', async (t) => {
  const r = await rig(t, { master: ['a', 'b'] }); await r.cool(['a']); await r.start();
  const args = await prepareClaudeArgs(['--group=master'], r.config);
  assert.equal(await r.send(args[1]!), 200); assert.deepEqual(r.hits, ['Bearer fake-b']);
});

test('fully exhausted group returns 429 without using outside accounts', async (t) => {
  const r = await rig(t, { master: ['a', 'b'] }); await r.cool(['a', 'b']); await r.start();
  const args = await prepareClaudeArgs(['--group', 'master'], r.config);
  assert.equal(await r.send(args[1]!), 429); assert.deepEqual(r.hits, []);
});

test('unknown group fails before session registration', async (t) => {
  const r = await rig(t, { master: ['a'] }); await r.start();
  await assert.rejects(prepareClaudeArgs(['--group', 'missing'], r.config), /Unknown.*group/i);
  assert.deepEqual(await loadSessions(), Object.create(null));
});

test('startup refuses unknown account references', async (t) => {
  const r = await rig(t, { master: ['missing@example.test'] });
  await assert.rejects(r.start(), /group.*unknown account/i);
});

test('one account may belong to multiple groups', async (t) => {
  const r = await rig(t, { master: ['b'], worker: ['b'] }); await r.start();
  for (const name of ['master', 'worker']) {
    const args = await prepareClaudeArgs(['--group', name], r.config);
    assert.equal(await r.send(args[1]!), 200);
    assert.equal((await loadSessions())[args[1]!]!.group, name);
  }
  assert.deepEqual(r.hits, ['Bearer fake-b', 'Bearer fake-b']);
});

test('resume after restart keeps stored group and permanent account binding', async (t) => {
  const r = await rig(t, { master: ['b'] }); await r.start();
  const args = await prepareClaudeArgs(['--group', 'master'], r.config); const id = args[1]!;
  assert.equal(await r.send(id), 200); await r.stop(); await r.start();
  assert.deepEqual(await prepareClaudeArgs(['--resume', id], r.config), ['--resume', id]);
  assert.equal(await r.send(id), 200); assert.equal((await loadSessions())[id]!.group, 'master');
  assert.deepEqual(r.hits, ['Bearer fake-b', 'Bearer fake-b']);
});

test('pending session group survives restart before the first request', async (t) => {
  const r = await rig(t, { master: ['b'] }); await r.start();
  const args = await prepareClaudeArgs(['--group', 'master'], r.config); await r.stop(); await r.start();
  assert.equal(await r.send(args[1]!), 200); assert.deepEqual(r.hits, ['Bearer fake-b']);
});

test('already bound group session stays on its account during cooldown', async (t) => {
  const r = await rig(t, { master: ['a', 'b'] }); await r.start();
  const args = await prepareClaudeArgs(['--group', 'master'], r.config); assert.equal(await r.send(args[1]!), 200);
  await r.stop(); await r.cool(['a']); await r.start();
  assert.equal(await r.send(args[1]!), 429); assert.deepEqual(r.hits, ['Bearer fake-a']);
});


test('TEAMAI_GROUP supplies a default and explicit group takes precedence', async (t) => {
  const r = await rig(t, { master: ['a'], worker: ['b'] }); await r.start();
  const old = process.env.TEAMAI_GROUP; process.env.TEAMAI_GROUP = 'master';
  t.after(() => { if (old === undefined) delete process.env.TEAMAI_GROUP; else process.env.TEAMAI_GROUP = old; });
  const fromEnv = await prepareClaudeArgs([], r.config); assert.equal(await r.send(fromEnv[1]!), 200);
  const explicit = await prepareClaudeArgs(['--group', 'worker'], r.config); assert.equal(await r.send(explicit[1]!), 200);
  assert.deepEqual(r.hits, ['Bearer fake-a', 'Bearer fake-b']);
});

test('invalid group syntax and ambiguous or non-Claude references are rejected', async (t) => {
  const { parseGroups, claudeGroupArgs } = await import('../src/groups.js');
  const r = await rig(t, { master: ['a'] });
  for (const raw of [null, [], { 'bad name': ['a'] }, { master: [] }, { master: [3] }, JSON.parse('{"__proto__":["a"]}')]) assert.throws(() => parseGroups(raw, r.config.accounts));
  const duplicated = r.config.accounts.map((a) => ({ ...a, label: 'duplicate' }));
  assert.throws(() => parseGroups({ master: ['duplicate'] }, duplicated), /ambiguous/);
  assert.throws(() => parseGroups({ master: ['a'] }, r.config.accounts.map((a) => ({ ...a, provider: 'codex' }))), /unknown account/);
  for (const args of [['--group'], ['--group='], ['--group', '--print'], ['--group', 'master', '--group', 'master']]) assert.throws(() => claudeGroupArgs(args, r.config, ''), /group/);
});

test('reload applies group membership atomically and rejects invalid changes without altering selection', async (t) => {
  const { reloadPools } = await import('../src/config-reload.js');
  const { AccountPool } = await import('../src/account-pool.js');
  const r = await rig(t, { master: ['a'] });
  const pool = new AccountPool(claudeProvider, r.config.accounts, r.credentials, { version: 1, accounts: {} });
  await reloadPools([pool], r.config);
  assert.equal(pool.pickClaudeInitial(false, null, 'master')?.id, 'a');
  r.config.groups = { master: ['b'] }; await saveConfig(r.config); await reloadPools([pool], r.config);
  assert.equal(pool.pickClaudeInitial(false, null, 'master')?.id, 'b');
  r.config.groups = { master: ['missing'] }; r.config.accounts[1]!.enabled = false; await saveConfig(r.config);
  await assert.rejects(reloadPools([pool], r.config), /unknown account/);
  assert.equal(pool.accounts.find((a) => a.id === 'a')!.enabled, true);
  assert.equal(pool.pickClaudeInitial(false, null, 'master')?.id, 'b');
});

test('deleted group or removed bound membership refuses resume without rebinding', async (t) => {
  const r = await rig(t, { master: ['a', 'b'] }); await r.start();
  const id = (await prepareClaudeArgs(['--group', 'master'], r.config))[1]!; assert.equal(await r.send(id), 200);
  await r.stop(); r.config.groups = { master: ['b'] }; await saveConfig(r.config); await r.start();
  assert.equal(await r.send(id), 503); await r.stop();
  r.config.groups = {}; await saveConfig(r.config); await r.start();
  assert.equal(await r.send(id), 503); assert.deepEqual(r.hits, ['Bearer fake-a']);
  assert.equal((await loadSessions())[id]!.accountId, 'a');
});

test('group scope intersects exclusive model routes and never falls outside it', async (t) => {
  const r = await rig(t, { master: ['a'] });
  r.config.routes = { claude: [{ name: 'sonnet', match: '*', accounts: ['outside'], mode: 'exclusive' }] };
  await saveConfig(r.config); await r.start();
  const id = (await prepareClaudeArgs(['--group', 'master'], r.config))[1]!;
  assert.equal(await r.send(id), 429); assert.deepEqual(r.hits, []);
});

test('corrupt or deleted stored group fails closed against the ledger', async (t) => {
  const { readFile, writeFile } = await import('node:fs/promises');
  const { paths } = await import('../src/storage.js');
  const r = await rig(t, { master: ['b'] }); await r.start();
  const id = (await prepareClaudeArgs(['--group', 'master'], r.config))[1]!; assert.equal(await r.send(id), 200);
  const bindings = JSON.parse(await readFile(paths().sessions, 'utf8'));
  delete bindings[id].group; await writeFile(paths().sessions, JSON.stringify(bindings));
  assert.equal(await r.send(id), 500); assert.deepEqual(r.hits, ['Bearer fake-b']);
});

test('request header can assert but cannot change a registered group', async (t) => {
  const r = await rig(t, { master: ['b'], worker: ['a'] }); await r.start();
  const id = (await prepareClaudeArgs(['--group', 'master'], r.config))[1]!;
  for (const group of ['worker', 'master']) {
    const response = await fetch(`http://127.0.0.1:${r.config.proxy.claudePort}/v1/messages`, { method: 'POST', headers: { authorization: `Bearer ${r.config.proxy.clientToken}`, 'x-claude-code-session-id': id, 'x-teamai-group': group }, body: '{}' });
    await response.text(); assert.equal(response.status, group === 'master' ? 200 : 409);
  }
  assert.deepEqual(r.hits, ['Bearer fake-b']);
});

test('status headroom and wide/narrow activity show groups with redacted account labels', async (t) => {
  const { groupStatusLines } = await import('../src/groups.js');
  const { buildFrame } = await import('../src/frame.js');
  const { redactSnapshot } = await import('../src/redact.js');
  const { ActivityLog } = await import('../src/activity.js');
  const r = await rig(t, { master: ['a@example.test', 'b'] });
  const state: import('../src/types.js').PersistedState = { version: 1, accounts: { a: { usage: 0.25, resetsAt: null, cooldownUntil: null, lastUsed: null, error: null } }, active: [{ id: 'request', provider: 'claude', providerLabel: 'Claude', method: 'POST', path: '/v1/messages', account: 'a@example.test', startedAt: Date.now(), sessionId: 'session', group: 'master' }] };
  assert.match(groupStatusLines(r.config, state)[0]!, /Group master: 2\/2 ready, headroom 0.75 accounts \+ 1 unknown/);
  for (const width of [72, 120]) {
    const masked = redactSnapshot(r.config, state, 'full');
    const frame = buildFrame(masked.config, masked.state, { width, selectedId: null, mode: 'normal', message: '', sortByHeadroom: false }).join('\n');
    assert.match(frame, /master ·/); assert.match(frame, /\[group:master\]/); assert.doesNotMatch(frame, /a@example.test/);
  }
  const events: import('../src/types.js').ActivityEvent[] = [];
  const log = new ActivityLog((event) => events.push(event)); log.start(state.active![0]!); log.update('request', { group: 'master' }); log.end('request', 200);
  assert.equal(events[0]!.request!.group, 'master'); assert.match(events[0]!.message, /\[group:master\]/);
});

test('CLI forwards group through Claude custom headers and rejects unsupported provider before launch', async (t) => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const r = await rig(t, { master: ['b'] }); await r.start();
  const bin = join(process.env.TEAMAI_HOME!, 'bin'); await mkdir(bin);
  await writeFile(join(bin, 'claude'), '#!/usr/bin/env node\nconsole.log(JSON.stringify({args:process.argv.slice(2),headers:process.env.ANTHROPIC_CUSTOM_HEADERS}));\n', { mode: 0o700 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEAMAI_GROUP: 'master', ANTHROPIC_CUSTOM_HEADERS: 'x-synthetic: preserved' };
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const run = promisify(execFile);
  const result = await run(process.execPath, ['--import', 'tsx', cli, 'claude', '--print', 'synthetic'], { env });
  const forwarded = JSON.parse(result.stdout) as { args: string[]; headers: string };
  assert.deepEqual(forwarded.args.slice(2), ['--print', 'synthetic']); assert.equal(forwarded.headers, 'x-synthetic: preserved\nx-teamai-group: master');
  assert.equal(await r.send(forwarded.args[1]!), 200); assert.deepEqual(r.hits, ['Bearer fake-b']);
  const status = await run(process.execPath, ['--import', 'tsx', cli, 'status'], { env });
  assert.match(status.stdout, /Group master:/); assert.match(status.stdout, new RegExp(`Session ${forwarded.args[1]} group master`));
  await assert.rejects(run(process.execPath, ['--import', 'tsx', cli, 'codex', '--group', 'master'], { env }), (error: unknown) => { assert.match((error as { stderr: string }).stderr, /supported only for Claude/); return true; });
  await assert.rejects(run(process.execPath, ['--import', 'tsx', cli, 'claude', '--group', 'missing'], { env }), (error: unknown) => { assert.match((error as { stderr: string }).stderr, /Unknown Claude group/); return true; });
});

test('control rejects unknown groups and re-measure refuses invalid membership without crashing', async (t) => {
  const r = await rig(t, { master: ['b'] }); await r.start();
  const request = async (path: string, body: unknown) => {
    const response = await fetch(`http://127.0.0.1:${r.config.proxy.controlPort}${path}`, { method: 'POST', headers: { authorization: `Bearer ${r.config.proxy.clientToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    await response.text(); return response.status;
  };
  assert.equal(await request('/claude/sessions', { group: 'missing' }), 400);
  const id = (await prepareClaudeArgs(['--group', 'master'], r.config))[1]!;
  r.config.groups = { master: ['missing'] }; await saveConfig(r.config);
  assert.equal(await request('/probe', {}), 400);
  assert.equal(await request('/reload', {}), 400);
  assert.equal(await r.send(id), 200); assert.deepEqual(r.hits, ['Bearer fake-b']);
});

test('grouped launches refuse an older relay that does not confirm the group', async (t) => {
  const r = await rig(t, { master: ['b'] });
  const legacy = createServer((req, res) => { req.resume(); res.end(JSON.stringify({ sessionId: '00000000-0000-4000-8000-000000000001' })); });
  await new Promise<void>((resolve) => legacy.listen(0, '127.0.0.1', resolve));
  t.after(() => { legacy.closeAllConnections(); legacy.close(); });
  const address = legacy.address(); assert(address && typeof address !== 'string'); r.config.proxy.controlPort = address.port;
  await assert.rejects(prepareClaudeArgs(['--group', 'master'], r.config), /did not confirm.*group/);
  assert.equal((await prepareClaudeArgs([], r.config))[0], '--session-id');
});
