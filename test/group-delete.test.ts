import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGroups } from '../src/groups.js';
import { defaultConfig, issueClaudeSession, loadConfig, loadSessions, removeAccount, saveConfig, updateSessions } from '../src/storage.js';

const account = (id: string, label: string, provider: 'claude' | 'codex' = 'claude') => ({ id, provider, label, enabled: true, priority: null, credentialId: `${provider}:${id}`, createdAt: '' });

test('deleting a Claude account removes id and label references and empty groups', async () => {
  const config = defaultConfig();
  config.accounts = [account('a', 'alpha@example.test'), account('b', 'beta@example.test'), account('c', 'codex@example.test', 'codex')];
  config.groups = { byLabel: ['alpha@example.test', 'b'], last: ['a'], keep: ['b'] };
  await saveConfig(config);

  assert.equal(await removeAccount('claude:a'), true);
  const saved = await loadConfig();
  assert.deepEqual(saved.accounts.map(({ id }) => id), ['b', 'c']);
  assert.deepEqual(saved.groups, { byLabel: ['b'], keep: ['b'] });
  assert.deepEqual(Object.fromEntries(Object.entries(parseGroups(saved.groups, saved.accounts))), { byLabel: ['b'], keep: ['b'] });
});

test('deleting the last member unbinds stored sessions from the removed group', async () => {
  const config = defaultConfig();
  config.accounts = [account('a', 'alpha@example.test'), account('b', 'beta@example.test')];
  config.groups = { last: ['alpha@example.test'], keep: ['b'] };
  await saveConfig(config);
  const bound = await issueClaudeSession('last');
  const pending = await issueClaudeSession('last');
  await updateSessions((bindings) => {
    bindings[bound] = { sessionId: bound, provider: 'claude', accountId: 'a', credentialId: 'claude:a', actualAccountId: 'a', boundAt: Date.now(), group: 'last' };
  });

  assert.equal(await removeAccount('claude:a'), true);
  const saved = await loadConfig();
  assert.deepEqual(saved.groups, { keep: ['b'] });
  assert.equal((await loadSessions())[bound]!.group, undefined);

  // The pending registration was cleared too and can bind without the old
  // group scope on its first request.
  await updateSessions((bindings) => {
    bindings[pending] = { sessionId: pending, provider: 'claude', accountId: 'b', credentialId: 'claude:b', actualAccountId: 'b', boundAt: Date.now() };
  });
  assert.equal((await loadSessions())[pending]!.group, undefined);
});
