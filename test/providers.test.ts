import assert from 'node:assert/strict';
import test from 'node:test';
import { claudeProvider, codexProvider } from '../src/providers.js';
import type { RuntimeAccount } from '../src/types.js';

const account = { id: 'acct', provider: 'codex', label: 'a', enabled: true, priority: null, credentialId: 'c', createdAt: '', credential: { accessToken: 'secret', refreshToken: null, expiresAt: null, accountId: 'account-1' }, usage: null, resetsAt: null, cooldownUntil: null, lastUsed: null, error: null, inflight: 0 } as RuntimeAccount;

test('Codex provider only permits expected paths and replaces client credentials', () => {
  assert.equal(codexProvider.normalizePath('/v1/responses'), '/codex/responses');
  assert.equal(codexProvider.normalizePath('/admin'), null);
  const incoming = new Headers({ authorization: 'Bearer client', cookie: 'private', 'x-api-key': 'client-key' });
  const headers = codexProvider.buildHeaders(incoming, account);
  assert.equal(headers.get('authorization'), 'Bearer secret'); assert.equal(headers.get('chatgpt-account-id'), 'account-1'); assert.equal(headers.has('cookie'), false); assert.equal(headers.has('x-api-key'), false);
});

test('Claude provider rewrites account UUID without changing unrelated fields', () => {
  const claudeAccount = { ...account, provider: 'claude', credential: { ...account.credential, accountId: '11111111-2222-3333-4444-555555555555' } } as RuntimeAccount;
  const result = JSON.parse(claudeProvider.rewriteBody(Buffer.from(JSON.stringify({ model: 'x', metadata: { user_id: JSON.stringify({ account_uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', extra: true }) } })), claudeAccount).toString()) as { metadata: { user_id: string }; model: string };
  assert.equal((JSON.parse(result.metadata.user_id) as { account_uuid: string }).account_uuid, claudeAccount.credential.accountId); assert.equal(result.model, 'x');
});

test('classifies provider failures', () => {
  assert.equal(codexProvider.classifyFailure(401, new Headers(), '').kind, 'auth');
  assert.equal(codexProvider.classifyFailure(429, new Headers(), '{"code":"usage_limit_reached"}').kind, 'quota');
  assert.equal(claudeProvider.classifyFailure(503, new Headers(), '').kind, 'transient');
});

test('parses Codex subscription quota headers', () => {
  const quota = codexProvider.readQuota(new Headers({ 'x-codex-primary-used-percent': '42', 'x-codex-primary-reset-after-seconds': '3600', 'x-codex-secondary-used-percent': '87', 'x-codex-secondary-reset-after-seconds': '7200' }));
  assert.equal(quota?.routingUsage, 0.87); assert(quota?.routingResetsAt && quota.routingResetsAt > Date.now() + 7_000_000);
  assert.equal(quota?.windows.primary?.usage, 0.42); assert.equal(quota?.windows.secondary?.usage, 0.87);
});

test('parses Claude session, weekly, and Fable windows with Unix reset seconds', () => {
  const reset = Math.floor((Date.now() + 86_400_000) / 1000);
  const quota = claudeProvider.readQuota(new Headers({
    'anthropic-ratelimit-unified-5h-utilization': '0.54',
    'anthropic-ratelimit-unified-5h-reset': String(reset),
    'anthropic-ratelimit-unified-7d-utilization': '0.86',
    'anthropic-ratelimit-unified-7d-reset': String(reset),
    'anthropic-ratelimit-unified-7d_oi-utilization': '0.94',
    'anthropic-ratelimit-unified-7d_oi-reset': String(reset),
  }));
  assert.equal(quota?.windows['5h']?.usage, 0.54);
  assert.equal(quota?.windows['7d']?.usage, 0.86);
  assert.equal(quota?.windows['7d_oi']?.usage, 0.94);
  assert.equal(quota?.windows['7d_oi']?.resetsAt, reset * 1000);
  assert.equal(quota?.routingUsage, 0.86, 'model-only Fable quota must not disable the whole account');
});
