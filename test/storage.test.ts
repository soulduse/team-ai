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

const jwt = (claims: Record<string, unknown>): string => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const member = (userId: string): string => jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'workspace', chatgpt_user_id: userId } });

test('keeps two members of one Codex workspace as separate accounts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teamai-storage-')); process.env.TEAMAI_HOME = root;
  const storage = await import(`../src/storage.js?test=${Date.now()}-members`);
  await storage.upsertAccount('codex', 'a@corp.com', { accessToken: member('user-a'), refreshToken: 'ra', expiresAt: 1, accountId: 'workspace', userId: 'user-a' });
  await storage.upsertAccount('codex', 'b@corp.com', { accessToken: member('user-b'), refreshToken: 'rb', expiresAt: 1, accountId: 'workspace', userId: 'user-b' });
  await storage.upsertAccount('codex', 'a@corp.com', { accessToken: member('user-a'), refreshToken: 'ra2', expiresAt: 2, accountId: 'workspace', userId: 'user-a' });
  const config = await storage.loadConfig(); const credentials = await storage.loadCredentials();
  assert.deepEqual(config.accounts.map((a: { label: string }) => a.label), ['a@corp.com', 'b@corp.com']);
  assert.equal(new Set(config.accounts.map((a: { credentialId: string }) => a.credentialId)).size, 2);
  for (const account of config.accounts) assert.equal(credentials[account.credentialId].accountId, 'workspace');
  delete process.env.TEAMAI_HOME;
});

test('upgrades a workspace-keyed Codex record for the same user and leaves it for another member', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teamai-storage-')); process.env.TEAMAI_HOME = root;
  const storage = await import(`../src/storage.js?test=${Date.now()}-legacy`);
  // A record written before the user joined the key: id is the bare workspace id.
  await storage.upsertAccount('codex', 'a@corp.com', { accessToken: member('user-a'), refreshToken: 'ra', expiresAt: 1, accountId: 'workspace' });
  const legacyId = (await storage.loadConfig()).accounts[0].credentialId;
  await storage.upsertAccount('codex', 'renamed@corp.com', { accessToken: member('user-a'), refreshToken: 'ra2', expiresAt: 2, accountId: 'workspace', userId: 'user-a' });
  let config = await storage.loadConfig();
  assert.equal(config.accounts.length, 1); assert.equal(config.accounts[0].id, 'workspace:user-a'); assert.equal(config.accounts[0].credentialId, legacyId);
  await storage.upsertAccount('codex', 'b@corp.com', { accessToken: member('user-b'), refreshToken: 'rb', expiresAt: 1, accountId: 'workspace', userId: 'user-b' });
  config = await storage.loadConfig();
  assert.equal(config.accounts.length, 2); assert.equal((await storage.loadCredentials())[legacyId].refreshToken, 'ra2');
  delete process.env.TEAMAI_HOME;
});

test('does not merge workspace members that share a label because their tokens carry no email', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teamai-storage-')); process.env.TEAMAI_HOME = root;
  const storage = await import(`../src/storage.js?test=${Date.now()}-nolabel`);
  await storage.upsertAccount('codex', 'workspace', { accessToken: member('user-a'), refreshToken: 'ra', expiresAt: 1, accountId: 'workspace' });
  await storage.upsertAccount('codex', 'workspace', { accessToken: member('user-b'), refreshToken: 'rb', expiresAt: 1, accountId: 'workspace', userId: 'user-b' });
  assert.equal((await storage.loadConfig()).accounts.length, 2);
  delete process.env.TEAMAI_HOME;
});
