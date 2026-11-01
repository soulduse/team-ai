import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs, { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { paths, saveState } from '../src/storage.js';
import type { OAuthCredential, StoredAccount } from '../src/types.js';

// Saves that overlap. Two copies of the storage module stand in for two
// processes (the server and the dashboard): they share nothing in memory, so
// only what is on disk keeps them apart. Each test has a TEAMAI_HOME of its own.

type Storage = typeof import('../src/storage.js');
let copies = 0;
const another = async (): Promise<Storage> => import(`../src/storage.js?process=${++copies}`) as Promise<Storage>;
const credential = (id: string): OAuthCredential => ({ accessToken: `synthetic-${id}`, refreshToken: null, expiresAt: null, accountId: id });
const account = (id: string): StoredAccount => ({ id, provider: 'codex', label: `${id}@example.com`, enabled: true, priority: null, credentialId: `codex:${id}`, createdAt: '' });
const leftovers = async (root: string): Promise<string[]> => (await readdir(root)).filter((name) => /\.(?:tmp|lock)$/.test(name));
async function home(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'teamai-storage-race-')); const previous = process.env.TEAMAI_HOME; process.env.TEAMAI_HOME = root;
  t.after(async () => { if (previous === undefined) delete process.env.TEAMAI_HOME; else process.env.TEAMAI_HOME = previous; await rm(root, { recursive: true, force: true }); });
  return root;
}

// The first change holds the file until release(); the second starts while it does.
function holding() {
  let release: () => void = () => {}; let entered: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; }); const inside = new Promise<void>((resolve) => { entered = resolve; });
  return { release, inside, hold: async () => { entered(); await gate; } };
}

// The first save's rename is held until the second save has finished, so the
// second rename lands first. With one shared temporary name the second save
// either finds the first's temp file in its way or moves it into place, and
// one of the two saves fails.
for (const secondWritesFirst of [false, true]) {
  test(`concurrent atomic saves use independent temporary files even when the second rename completes first${secondWritesFirst ? ' and writes first' : ''}`, { timeout: 5_000 }, async (t) => {
    const root = await home(t);
    const rename = fs.rename; const sources: string[] = [];
    const secondAtRename = holding();
    let firstSource = '';
    const write = fs.writeFile;
    t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof write>) => {
      if (String(args[1]).includes('"message": "first"')) {
        firstSource = String(args[0]);
        if (secondWritesFirst) await secondAtRename.hold();
      }
      return write(...args);
    });
    let secondDone: Promise<unknown> = Promise.resolve();
    t.mock.method(fs, 'rename', async (...args: Parameters<typeof rename>) => {
      sources.push(String(args[0]));
      // Identify the save by its payload's temp path, not by arrival order.
      if (String(args[0]) === firstSource) await secondDone;
      else secondAtRename.release();
      await rename(...args);
    });
    syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    const first = saveState({ version: 1, accounts: {}, events: [{ at: 1, message: 'first' }] });
    const second = saveState({ version: 1, accounts: {}, events: [{ at: 2, message: 'second' }] }); secondDone = second.catch(() => {});
    const results = await Promise.allSettled([first, second]);
    assert.deepEqual(results.map((r) => r.status === 'rejected' ? `rejected: ${(r.reason as Error).message}` : r.status), ['fulfilled', 'fulfilled']);
    assert.equal(new Set(sources).size, 2);
    const state = JSON.parse(await readFile(paths().state, 'utf8')) as { events: Array<{ message: string }> };
    assert.equal(state.events[0]!.message, 'first', 'the save whose rename landed last is the one on disk');
    assert.deepEqual(await readdir(root), [basename(paths().state)]);
  });

}

test('a credential change from another process waits for the one in progress instead of overwriting it', async (t) => {
  const root = await home(t);
  const [server, dashboard] = [await another(), await another()];
  await server.saveCredentials({ 'codex:kept': credential('kept') });
  const { release, inside, hold } = holding();
  // The server's save: read, then (held here) write back with its own token.
  const save = server.updateCredentials(async (current) => { current['codex:server'] = credential('server'); await hold(); });
  await inside;
  // A login in the dashboard meanwhile.
  const login = dashboard.updateCredentials((current) => { current['codex:login'] = credential('login'); });
  await delay(50);
  assert.deepEqual(Object.keys(await dashboard.loadCredentials()), ['codex:kept'], 'the login has not written past the save in progress');
  release(); await Promise.all([save, login]);
  assert.deepEqual(Object.keys(await server.loadCredentials()).sort(), ['codex:kept', 'codex:login', 'codex:server']);
  assert.deepEqual(await leftovers(root), []);
});

test('a delete from another process is not undone by a save that read the file before it', async (t) => {
  await home(t);
  const [server, dashboard] = [await another(), await another()];
  await dashboard.saveConfig({ ...dashboard.defaultConfig(), accounts: [account('a'), account('b')] });
  await dashboard.saveCredentials({ 'codex:a': credential('a'), 'codex:b': credential('b') });
  const { release, inside, hold } = holding();
  // The server's save writes back every token it holds that is still on disk.
  const save = server.updateCredentials(async (current) => { await hold(); for (const id of ['a', 'b']) if (current[`codex:${id}`]) current[`codex:${id}`] = { ...credential(id), accessToken: `refreshed-${id}` }; });
  await inside;
  const removed = dashboard.removeAccount('codex:a');
  await delay(50); release();
  assert.equal(await removed, true); await save;
  const credentials = await server.loadCredentials();
  assert.deepEqual(Object.keys(credentials), ['codex:b'], 'the deleted account stays deleted');
  assert.equal(credentials['codex:b']!.accessToken, 'refreshed-b');
  assert.deepEqual((await server.loadConfig()).accounts.map((a) => a.id), ['b']);
});

test('two config changes from different processes both land', async (t) => {
  const root = await home(t);
  const [cli, dashboard] = [await another(), await another()];
  await cli.saveConfig({ ...cli.defaultConfig(), accounts: [account('a'), account('b')] });
  const { release, inside, hold } = holding();
  const disable = cli.updateConfig(async (config) => { config.accounts[0]!.enabled = false; await hold(); });
  await inside;
  const rank = dashboard.updateConfig((config) => { config.accounts[1]!.priority = 1; });
  await delay(50); release();
  assert.deepEqual(await Promise.all([disable, rank]), [true, true]);
  const config = await cli.loadConfig();
  assert.deepEqual(config.accounts.map((a) => [a.id, a.enabled, a.priority]), [['a', false, null], ['b', true, 1]]);
  assert.equal(await dashboard.updateConfig(() => false), false, 'a change that declines writes nothing');
  assert.deepEqual(await leftovers(root), []);
});

test('a lock left by a process that died does not stop saves', { timeout: 10_000 }, async (t) => {
  const root = await home(t);
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' }); await once(child, 'exit');
  await writeFile(`${paths().credentials}.lock`, String(child.pid));
  const storage = await another();
  await storage.updateCredentials((current) => { current['codex:after'] = credential('after'); });
  assert.deepEqual(Object.keys(await storage.loadCredentials()), ['codex:after']);
  assert.deepEqual(await leftovers(root), []);
});
