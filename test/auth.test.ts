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

test('imports the xAI sign-in from a Grok auth.json without modifying it, and skips others', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamai-grok-')); const path = join(dir, 'auth.json');
  const fixture = JSON.stringify({
    'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828': { key: 'access-grok', refresh_token: 'refresh-grok', expires_at: '2026-11-20T07:04:11.917164Z', user_id: 'user-1', email: 'g@example.com', auth_mode: 'oidc' },
    'https://acme.okta.com::client': { key: 'sso-token', user_id: 'sso-user', email: 'corp@example.com' },
  });
  await writeFile(path, fixture);
  const [result, ...rest] = await importAuth('grok', path);
  assert.equal(rest.length, 0);
  assert.equal(result!.label, 'g@example.com');
  assert.deepEqual(result!.credential, { accessToken: 'access-grok', refreshToken: 'refresh-grok', expiresAt: Date.parse('2026-11-20T07:04:11.917Z'), accountId: 'user-1' });
  assert.equal(await readFile(path, 'utf8'), fixture);
  await writeFile(path, JSON.stringify({ 'https://acme.okta.com::client': { key: 'k', user_id: 'u' } }));
  await assert.rejects(importAuth('grok', path), /No Grok sign-in/);
});
