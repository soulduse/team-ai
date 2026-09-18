import assert from 'node:assert/strict';
import test from 'node:test';
import { maskLabel, redactSnapshot, redactor } from '../src/redact.js';
import type { PersistedState, StoredAccount, TeamAIConfig } from '../src/types.js';

function account(label: string, provider: 'claude' | 'codex' = 'claude'): StoredAccount {
  return { id: label, provider, label, enabled: true, priority: null, credentialId: `cred-${label}`, createdAt: '2026-01-01T00:00:00Z' };
}

test('partial masking keeps the first two and last characters of each part', () => {
  assert.equal(maskLabel('developerkhw@gmail.com', 'partial', 0), 'de•••••••••w@gm•••.com');
  assert.equal(maskLabel('apps.dev.kim@example.co.uk', 'partial', 0), 'ap•••••••••m@ex••••••••.uk');
  assert.equal(maskLabel('ab@x.io', 'partial', 0), '••@x•.io');
});

test('labels that are not emails are still masked', () => {
  assert.equal(maskLabel('3f9a1c2e-uuid-like', 'partial', 0), '3f•••••••••••••••e');
  assert.equal(maskLabel('bob', 'partial', 0), '•••');
  assert.equal(maskLabel('', 'partial', 0), '•');
});

test('full masking replaces the label with its position in config', () => {
  assert.equal(maskLabel('developerkhw@gmail.com', 'full', 0), 'account #1');
  assert.equal(maskLabel('anything', 'full', 6), 'account #7');
});

test('none leaves the label alone', () => {
  assert.equal(maskLabel('developerkhw@gmail.com', 'none', 0), 'developerkhw@gmail.com');
});

test('redactor masks labels inside event sentences, longest label first', () => {
  const short = account('kim@example.com'); const long = account('kim@example.com.au');
  const mask = redactor([short, long], 'partial');
  const out = mask('Claude POST /v1/messages → kim@example.com.au 429 quota; failover to kim@example.com');
  assert.equal(out.includes('kim@example.com'), false);
  assert.equal(out.includes('example.com.au'), false);
  assert.match(out, /•••@ex•+\.au 429/);
  assert.match(out, /failover to •••@ex•+\.com$/);
});

test('redactor masks an address that is not in config at all', () => {
  const mask = redactor([account('known@example.com')], 'partial');
  assert.equal(mask('imported stray@example.org earlier').includes('stray@example.org'), false);
  assert.equal(redactor([account('known@example.com')], 'full')('imported stray@example.org earlier'), 'imported [redacted] earlier');
});

test('redactSnapshot masks config labels and event messages without touching the originals', () => {
  const config: TeamAIConfig = { version: 1, proxy: { host: '127.0.0.1', claudePort: 3456, codexPort: 3457, clientToken: 'tai-secret' }, switchThreshold: 0.98, maxConcurrentPerAccount: 3, accounts: [account('alice@example.com'), account('bob@example.com', 'codex')] };
  const state: PersistedState = { version: 1, accounts: {}, events: [{ at: 0, message: 'Codex POST /v1/responses → bob@example.com 200' }] };
  const { config: masked, state: maskedState } = redactSnapshot(config, state, 'partial');
  assert.deepEqual(masked.accounts.map((a) => a.label), ['al••e@ex•••••.com', '•••@ex•••••.com']);
  assert.equal(maskedState.events?.[0]?.message.includes('bob@example.com'), false);
  assert.equal(config.accounts[0]?.label, 'alice@example.com');
  assert.equal(state.events?.[0]?.message.includes('bob@example.com'), true);
});
