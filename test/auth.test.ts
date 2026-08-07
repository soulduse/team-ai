import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { importAuth } from '../src/auth.js';

test('imports all OAuth accounts from TeamClaude config without modifying it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamai-import-')); const path = join(dir, 'teamclaude.json');
  const fixture = JSON.stringify({ accounts: [
    { name: 'one@example.com', type: 'oauth', accountUuid: '11111111-1111-1111-1111-111111111111', accessToken: 'access-one', refreshToken: 'refresh-one', expiresAt: 123 },
    { name: 'two@example.com', type: 'oauth', accountUuid: '22222222-2222-2222-2222-222222222222', accessToken: 'access-two', refreshToken: 'refresh-two', expiresAt: 456 },
    { name: 'api-key', type: 'api', apiKey: 'excluded' },
  ] }, null, 2);
  await writeFile(path, fixture);
  const imported = await importAuth('claude', path);
  assert.equal(imported.length, 2); assert.equal(imported[1]?.credential.accountId, '22222222-2222-2222-2222-222222222222');
  assert.equal(await readFile(path, 'utf8'), fixture);
});
