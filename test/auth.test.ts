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

test('imports the Codex user alongside the workspace so workspace members stay distinct', async () => {
  const jwt = (claims: Record<string, unknown>): string => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
  const dir = await mkdtemp(join(tmpdir(), 'teamai-import-')); const path = join(dir, 'auth.json');
  await writeFile(path, JSON.stringify({ tokens: {
    access_token: jwt({ exp: 100, 'https://api.openai.com/auth': { chatgpt_account_id: 'workspace', chatgpt_user_id: 'user-b' } }),
    id_token: jwt({ email: 'b@corp.com', sub: 'auth0|b', 'https://api.openai.com/auth': { chatgpt_account_id: 'workspace' } }),
    refresh_token: 'refresh', account_id: 'workspace',
  } }));
  const [imported] = await importAuth('codex', path);
  assert.equal(imported?.label, 'b@corp.com');
  assert.equal(imported?.credential.accountId, 'workspace'); assert.equal(imported?.credential.userId, 'user-b');
});

test('a Claude credential carries its organization, and a Team seat says so in its label', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'teamai-claude-import-'));
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  let type = 'claude_team';
  globalThis.fetch = (async () => new Response(JSON.stringify({ account: { uuid: 'person', email: 'me@corp.com' }, organization: { uuid: `org-${type}`, organization_type: type } }))) as typeof fetch;
  const file = join(dir, 'credentials.json');
  await writeFile(file, JSON.stringify({ claudeAiOauth: { accessToken: 'token', refreshToken: 'refresh', expiresAt: 1 } }));
  const [team] = await importAuth('claude', file);
  assert.equal(team?.label, 'me@corp.com (Team)'); assert.equal(team?.credential.organizationId, 'org-claude_team'); assert.equal(team?.credential.accountId, 'person');
  type = 'claude_max';
  const [personal] = await importAuth('claude', file);
  assert.equal(personal?.label, 'me@corp.com'); assert.equal(personal?.credential.organizationId, 'org-claude_max');
});
