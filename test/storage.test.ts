import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('stores credentials separately with restrictive permissions and deduplicates accounts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teamai-storage-')); process.env.TEAMAI_HOME = root;
  const storage = await import(`../src/storage.js?test=${Date.now()}`);
  const credential = { accessToken: 'secret', refreshToken: 'refresh', expiresAt: 123, accountId: 'same' };
  await storage.upsertAccount('codex', 'first', credential); await storage.upsertAccount('codex', 'renamed', { ...credential, accessToken: 'new-secret' });
  const config = await storage.loadConfig(); assert.equal(config.accounts.length, 1); assert.equal(config.accounts[0]?.label, 'renamed');
  assert.equal((await readFile(storage.paths().config, 'utf8')).includes('new-secret'), false);
  assert.equal((await stat(storage.paths().credentials)).mode & 0o777, 0o600);
  delete process.env.TEAMAI_HOME;
});
