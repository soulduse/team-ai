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

test('Claude probe template is captured from an accepted request and floats an old client version', () => {
  const headers = new Headers({
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'oauth-2025-04-20',
    'user-agent': 'claude-cli/2.1.0 (external, cli)',
  });
  const body = Buffer.from(JSON.stringify({ model: 'claude-sonnet-5', system: [{ type: 'text', text: 'You are Claude Code' }] }));
  const template = claudeProvider.captureProbe!('/v1/messages?beta=true', headers, body, false);
  assert.ok(template);
  assert.equal(template.model, 'claude-sonnet-5');
  assert.equal(template.query, '?beta=true');
  assert.equal(template.beta, 'oauth-2025-04-20');

  const shape = claudeProvider.probeRequest!(template, { accessToken: 'tok', refreshToken: null, expiresAt: null, accountId: 'acc' });
  assert.match(shape.url, /\/v1\/messages\?beta=true$/);
  assert.equal(shape.headers.authorization, 'Bearer tok');
  // The captured 2.1.0 is below the floor newer models require, so it floats up.
  assert.match(shape.headers['user-agent']!, /claude-cli\/2\.1\.260/);
  assert.equal(JSON.parse(shape.body).max_tokens, 1);
});

test('Claude probe keeps a client version that already meets the floor', () => {
  const headers = new Headers({ 'anthropic-version': '2023-06-01', 'user-agent': 'claude-cli/2.9.9 (external, cli)' });
  const template = claudeProvider.captureProbe!('/v1/messages', headers, Buffer.from(JSON.stringify({ model: 'claude-sonnet-5' })), true);
  assert.ok(template);
  assert.equal(template.elicitsModelWeekly, true);
  const shape = claudeProvider.probeRequest!(template, { accessToken: 't', refreshToken: null, expiresAt: null, accountId: 'a' });
  assert.match(shape.headers['user-agent']!, /claude-cli\/2\.9\.9/);
});

test('probe capture ignores unrelated paths and unparsable bodies', () => {
  assert.equal(claudeProvider.captureProbe!('/v1/models', new Headers(), Buffer.from('{}'), false), null);
  assert.equal(claudeProvider.captureProbe!('/v1/messages', new Headers(), Buffer.from('not json'), false), null);
  assert.equal(codexProvider.captureProbe!('/models', new Headers(), Buffer.from('{}'), false), null);
});

test('claude routes only Fable models to the Fable budget', () => {
  const body = (model: unknown) => Buffer.from(JSON.stringify({ model, messages: [] }));
  const uses = (model: unknown) => claudeProvider.usesFableBudget!('/v1/messages', body(model));
  assert.equal(uses('claude-fable-5-1'), true);
  assert.equal(uses('claude-opus-5'), false);
  assert.equal(uses('claude-sonnet-5'), false);
  assert.equal(uses('claude-haiku-4-5-20251001'), false);
  // Unknown shapes stay on the conservative path rather than spending a
  // reserved account by accident.
  assert.equal(uses(undefined), true);
  assert.equal(claudeProvider.usesFableBudget!('/v1/messages', Buffer.from('not json')), true);
  assert.equal(claudeProvider.usesFableBudget!('/v1/messages', Buffer.alloc(0)), true);
  assert.equal(claudeProvider.usesFableBudget!('/v1/models', body('claude-opus-5')), true);
  // The path arrives as Claude Code sends it, query string included.
  assert.equal(claudeProvider.usesFableBudget!('/v1/messages?beta=true', body('claude-opus-5')), false);
  assert.equal(claudeProvider.usesFableBudget!('/v1/messages?beta=true', body('claude-fable-5-1')), true);
});

test('a Fable-only 429 benches the model, not the account', () => {
  const h = (extra: Record<string, string>) => new Headers({ 'retry-after': '480000', ...extra });
  const kind = (extra: Record<string, string>) => claudeProvider.classifyFailure(429, h(extra), '').kind;

  // The real shape of a Fable cap: upstream sets the TOP-LEVEL unified-status to
  // rejected AND the 7d_oi window to rejected, while the shared 5h/7d windows
  // stay allowed. The top-level bit must not be mistaken for the account being
  // spent — the shared windows vouch that it still serves other models.
  assert.equal(kind({
    'anthropic-ratelimit-unified-status': 'rejected',
    'anthropic-ratelimit-unified-7d_oi-status': 'rejected',
    'anthropic-ratelimit-unified-5h-status': 'allowed',
    'anthropic-ratelimit-unified-7d-status': 'allowed',
  }), 'model-quota');

  // A genuinely spent account: a shared window itself is rejected.
  assert.equal(kind({
    'anthropic-ratelimit-unified-status': 'rejected',
    'anthropic-ratelimit-unified-5h-status': 'rejected',
    'anthropic-ratelimit-unified-7d-status': 'allowed',
  }), 'quota');
  assert.equal(kind({
    'anthropic-ratelimit-unified-status': 'rejected',
    'anthropic-ratelimit-unified-7d-status': 'rejected',
  }), 'quota');

  // Fable rejected but the shared 5h is ALSO rejected → whole account is spent.
  assert.equal(kind({
    'anthropic-ratelimit-unified-7d_oi-status': 'rejected',
    'anthropic-ratelimit-unified-5h-status': 'rejected',
    'anthropic-ratelimit-unified-7d-status': 'allowed',
  }), 'quota');

  // Only the top-level bit, no shared window to vouch for the account → the safe
  // reading is to bench the whole account.
  assert.equal(kind({ 'anthropic-ratelimit-unified-status': 'rejected' }), 'quota');

  // No rejected status at all: a plain rate limit, retried rather than benched.
  assert.equal(kind({}), 'transient');
});

test('a spent Codex window is benched until its real reset, not the 60s fallback', () => {
  // Captured from a live prolite account at 100%: Codex sends NO retry-after on
  // a usage-limit 429, so the generic fallback used to bench it for 60s and let
  // it be retried ~2.9 days early, once a minute, until the window rolled over.
  const headers = new Headers({
    'x-codex-primary-used-percent': '100',
    'x-codex-primary-reset-after-seconds': '254862',
    'x-codex-primary-window-minutes': '10080',
    'x-codex-secondary-used-percent': '0',
    'x-codex-secondary-reset-after-seconds': '0',
  });
  const body = JSON.stringify({ error: { type: 'usage_limit_reached', resets_at: 1790157088, resets_in_seconds: 254861 } });
  const spent = codexProvider.classifyFailure(429, headers, body);
  assert.equal(spent.kind, 'quota');
  assert.equal(spent.retryAfterMs, 254862 * 1000);

  // The body carries the reset too, so a header-less rejection still benches
  // for the real window instead of a minute.
  const fromBody = codexProvider.classifyFailure(429, new Headers(), body);
  assert.equal(fromBody.kind, 'quota');
  assert.equal(fromBody.retryAfterMs, 254861 * 1000);

  // The window that is actually spent decides, not merely the first one listed.
  const secondary = codexProvider.classifyFailure(429, new Headers({
    'x-codex-primary-used-percent': '40', 'x-codex-primary-reset-after-seconds': '999',
    'x-codex-secondary-used-percent': '100', 'x-codex-secondary-reset-after-seconds': '7200',
  }), 'usage_limit_reached');
  assert.equal(secondary.retryAfterMs, 7200 * 1000);

  // Nothing named a reset: keep the old conservative minute.
  assert.equal(codexProvider.classifyFailure(429, new Headers(), 'usage_limit_reached').retryAfterMs, 60_000);

  // A transient 429 is untouched: it still honours retry-after and is not benched.
  const transient = codexProvider.classifyFailure(429, new Headers({ 'retry-after': '3' }), '{"error":{"message":"slow down"}}');
  assert.equal(transient.kind, 'transient');
  assert.equal(transient.retryAfterMs, 3_000);
});

test('a Codex client that chains on the body keys sticks by prompt_cache_key, not the per-turn response id', () => {
  // prompt_cache_key is fixed for a session by design; previous_response_id is
  // a different id on every turn. Reading the latter first gave such a client
  // a new affinity key per turn — no stickiness at all.
  const body = (turn: number) => Buffer.from(JSON.stringify({ prompt_cache_key: 'thread-9', previous_response_id: `resp_${turn}` }));
  assert.equal(codexProvider.sessionKey!(new Headers(), body(1)), 'thread-9');
  assert.equal(codexProvider.sessionKey!(new Headers(), body(2)), 'thread-9');
  // Headers still win over the body, and the window id folds onto the session id.
  assert.equal(codexProvider.sessionKey!(new Headers({ 'session-id': 's', 'x-codex-window-id': 's:0' }), body(3)), 's');
  assert.equal(codexProvider.sessionKey!(new Headers({ 'x-codex-window-id': 's:2' }), Buffer.alloc(0)), 's');
  assert.equal(codexProvider.sessionKey!(new Headers(), Buffer.alloc(0)), null);
});

test('Claude Code names its session in a header, or inside metadata.user_id when the header is absent', () => {
  const identity = JSON.stringify({ device_id: 'd', account_uuid: '', session_id: 'sess-7' });
  const body = Buffer.from(JSON.stringify({ model: 'claude-sonnet-5', metadata: { user_id: identity } }));
  assert.equal(claudeProvider.sessionKey!(new Headers({ 'x-claude-code-session-id': 'hdr-1' }), body), 'hdr-1');
  assert.equal(claudeProvider.sessionKey!(new Headers(), body), 'sess-7');
  assert.equal(claudeProvider.sessionKey!(new Headers(), Buffer.from('{"model":"x"}')), null);
  assert.equal(claudeProvider.sessionKey!(new Headers({ 'x-claude-code-session-id': 'x'.repeat(500) }), Buffer.alloc(0))?.length, 200);
});
