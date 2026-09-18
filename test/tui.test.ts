import assert from 'node:assert/strict';
import test from 'node:test';
import { displayOrder } from '../src/tui.js';
import type { PersistedState, StoredAccount } from '../src/types.js';

function account(provider: 'claude' | 'codex', label: string, priority: number | null = null): StoredAccount {
  return { id: label, provider, label, enabled: true, priority, credentialId: `cred-${label}`, createdAt: '2026-01-01T00:00:00Z' };
}

function usage(entries: Record<string, number | null>): PersistedState {
  const accounts: PersistedState['accounts'] = {};
  for (const [label, value] of Object.entries(entries)) accounts[`cred-${label}`] = { usage: value, resetsAt: null, cooldownUntil: null, lastUsed: null, error: null, windows: value === null ? {} : { '7d_oi': { usage: value, resetsAt: null } } };
  return { version: 1, accounts };
}

test('display order groups providers even when config interleaves them', () => {
  const config = [account('codex', 'x1@example.com'), account('claude', 'c1@example.com'), account('codex', 'x2@example.com'), account('claude', 'c2@example.com')];
  const ordered = displayOrder(config, usage({}), false);
  assert.deepEqual(ordered.map((a) => a.label), ['c1@example.com', 'c2@example.com', 'x1@example.com', 'x2@example.com']);
});

test('display order ranks least-spent first, unmeasured last, pinned priority ahead of all', () => {
  const config = [account('claude', 'spent@example.com'), account('claude', 'unknown@example.com'), account('claude', 'fresh@example.com'), account('claude', 'pinned@example.com', 1)];
  const state = usage({ 'spent@example.com': 1, 'unknown@example.com': null, 'fresh@example.com': 0.2, 'pinned@example.com': 0.9 });
  const ordered = displayOrder(config, state, true);
  assert.deepEqual(ordered.map((a) => a.label), ['pinned@example.com', 'fresh@example.com', 'spent@example.com', 'unknown@example.com']);
});

// The regression: ↑↓ used to step through config.json while the screen drew a
// sorted list, so the cursor hopped between non-adjacent rows. Stepping through
// displayOrder by index must visit rows in exactly the order they are drawn.
test('stepping by index through display order visits adjacent drawn rows', () => {
  const config = [account('claude', 'b@example.com'), account('codex', 'z@example.com'), account('claude', 'a@example.com')];
  const state = usage({ 'b@example.com': 0.8, 'a@example.com': 0.1, 'z@example.com': 0.5 });
  const ordered = displayOrder(config, state, true);
  const walk: string[] = []; let index = 0;
  while (index < ordered.length) { walk.push(ordered[index]!.label); index++; }
  assert.deepEqual(walk, ['a@example.com', 'b@example.com', 'z@example.com']);
  assert.notDeepEqual(walk, config.map((a) => a.label));
});

test('display order leaves the input array untouched', () => {
  const config = [account('claude', 'b@example.com'), account('claude', 'a@example.com')];
  const before = config.map((a) => a.label);
  displayOrder(config, usage({ 'b@example.com': 0.9, 'a@example.com': 0.1 }), true);
  assert.deepEqual(config.map((a) => a.label), before);
});
