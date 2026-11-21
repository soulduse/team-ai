import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFrame, claudeTier, refreshErrorKind, DISPLAY_ITEMS, displayOrder, resetTicketsNote, toggleShown, visibleProviders } from '../src/frame.js';
import { defaultConfig } from '../src/storage.js';
import type { PersistedState, StoredAccount, TeamAIConfig } from '../src/types.js';

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

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const plain = (line: string): string => line.replace(ANSI, '');

test('buildFrame draws both sections, the column titles and the footer within the width', () => {
  const config: TeamAIConfig = { version: 1, proxy: { host: '127.0.0.1', claudePort: 3456, codexPort: 3457, clientToken: 'tai-secret' }, switchThreshold: 0.98, maxConcurrentPerAccount: 3, accounts: [account('claude', 'c@example.com'), account('codex', 'x@example.com')] };
  const state = usage({ 'c@example.com': 0.3, 'x@example.com': 0.9 });
  const lines = buildFrame(config, state, { width: 120, selectedId: 'cred-c@example.com', mode: 'normal', message: 'hello', sortByHeadroom: true }).map(plain);
  assert.ok(lines.every((line) => [...line].length <= 120), 'no line wider than the frame');
  assert.ok(lines.some((line) => line.includes('Claude accounts (1)')));
  assert.ok(lines.some((line) => line.includes('Codex accounts (1)')));
  assert.ok(lines.some((line) => line.includes('7d overall') && line.includes('7d Fable')));
  // Claude folded the 5-hour limit into the weekly one: no live 5h window, no column.
  assert.ok(!lines.some((line) => line.includes('5h session')));
  state.accounts['cred-c@example.com']!.windows!['5h'] = { usage: 0.2, resetsAt: Date.now() + 3_600_000 };
  const withSession = buildFrame(config, state, { width: 120, selectedId: null, mode: 'normal', message: '', sortByHeadroom: true }).map(plain);
  assert.ok(withSession.some((line) => line.includes('5h session') && line.includes('7d overall')), 'a live 5h window brings the column back');
  assert.ok(lines.some((line) => line.startsWith('> c@example.com')), 'cursor on the selected row');
  const footer = lines.at(-1)!;
  // With a message the key hints give way to it; without one they all fit.
  assert.match(footer, /p\/P capture/); assert.match(footer, /hello$/);
  const hints = withSession.at(-1)!;
  assert.match(hints, /p\/P capture/); assert.match(hints, /c quota-sort/); assert.match(hints, /q quit/);
  assert.equal(lines.join('\n').includes('tai-secret'), false);
});

test('buildFrame pads to the terminal height when given one and not otherwise', () => {
  const config: TeamAIConfig = { version: 1, proxy: { host: '127.0.0.1', claudePort: 3456, codexPort: 3457, clientToken: 't' }, switchThreshold: 0.98, maxConcurrentPerAccount: 3, accounts: [account('claude', 'c@example.com')] };
  const view = { width: 100, selectedId: null, mode: 'normal' as const, message: '', sortByHeadroom: true };
  assert.equal(buildFrame(config, usage({}), { ...view, height: 40 }).length, 40);
  assert.ok(buildFrame(config, usage({}), view).length < 40);
});

test('claudeTier: Max multipliers, the Ultra rename, and unknown tiers shown as reported', () => {
  const p = (rateLimitTier: string | null, orgType: string | null = null, hasClaudeMax: boolean | null = null) => ({ status: 'active', createdAt: null, rateLimitTier, orgType, hasClaudeMax, hasClaudePro: null, fetchedAt: 0 });
  assert.equal(claudeTier(null), 'OAuth');
  assert.equal(claudeTier(p('default_claude_max_20x', 'claude_max')), 'Ultra');
  assert.equal(claudeTier(p('default_claude_max_5x', 'claude_max')), 'Max 5x');
  assert.equal(claudeTier(p('default_claude_ultra', 'claude_max', true)), 'Ultra');
  assert.equal(claudeTier(p(null, 'claude_ultra')), 'Ultra');
  assert.equal(claudeTier(p(null, 'claude_max', true)), 'Max');
  assert.equal(claudeTier(p('default_claude_premium', 'claude_premium')), 'premium');
  assert.equal(claudeTier(p(null, 'claude_premium')), 'premium');
  assert.equal(claudeTier(p(null, null)), 'OAuth');
});

test('resets column: only when an account holds tickets and the row fits; dimmed when stale', () => {
  const config = { ...defaultConfig(), accounts: [account('claude', 'c@example.com'), account('claude', 'd@example.com')] };
  const state = usage({ 'c@example.com': 0.3, 'd@example.com': 0.3 });
  const draw = (width: number) => buildFrame(config, state, { width, selectedId: null, mode: 'normal', message: '', sortByHeadroom: false });
  assert.ok(!draw(120).map(plain).some((line) => line.includes('resets')));
  state.accounts['cred-c@example.com']!.resetCredits = { general: 1, fable: 3, nextExpiry: null, readAt: Date.now() };
  const wide = draw(120);
  assert.ok(wide.map(plain).some((line) => line.includes('resets')));
  assert.ok(wide.some((line) => line.includes('\x1b[36mR1 F3')));
  assert.ok(!draw(100).map(plain).some((line) => line.includes('resets') || line.includes('R1 F3')));
  // a live 5h session adds a gauge: the column shows only where the row still fits, and never clips it
  state.accounts['cred-d@example.com']!.windows!['5h'] = { usage: 0.2, resetsAt: Date.now() + 3_600_000 };
  for (const width of [110, 115, 118, 119, 120, 137]) {
    const lines = draw(width).map(plain); const shown = lines.some((line) => line.includes('R1 F3'));
    assert.equal(shown, width === 119 || width === 137, `width ${width}`);
    if (shown) assert.ok(!lines.some((line) => line.includes('c@example.com') && line.endsWith('…')), `clipped at ${width}`);
  }
  delete state.accounts['cred-d@example.com']!.windows!['5h'];
  state.accounts['cred-c@example.com']!.resetCredits = { general: 1, fable: 3, nextExpiry: null, readAt: Date.now() - 2 * 86_400_000 };
  assert.ok(draw(120).some((line) => line.includes('\x1b[90mR1 F3')));
  assert.equal(resetTicketsNote({ general: 1, fable: 0, nextExpiry: Date.parse('2026-12-10T22:00:00Z'), readAt: Date.now() }), ' resets R1 (first expires 2026-12-10)');
  assert.equal(resetTicketsNote({ general: 0, fable: 2, nextExpiry: null }), ' resets F2, stale');
  assert.equal(resetTicketsNote({ general: 0, fable: 0, nextExpiry: null, readAt: Date.now() }), '');
});

test('display settings: hidden sections leave the frame and the cursor order', () => {
  const config = { ...defaultConfig(), accounts: [account('claude', 'c@example.com'), account('codex', 'x@example.com')] };
  const state = usage({ 'c@example.com': 0.3, 'x@example.com': 0.5 });
  assert.equal(toggleShown(config, 'section:claude'), false);
  assert.deepEqual(config.display?.hidden, ['section:claude']);
  assert.deepEqual(visibleProviders(config), ['codex', 'grok']);
  assert.deepEqual(displayOrder(config.accounts, state, true, visibleProviders(config)).map((a) => a.label), ['x@example.com']);
  const draw = () => buildFrame(config, state, { width: 120, selectedId: null, mode: 'normal', message: '', sortByHeadroom: true }).map(plain);
  assert.ok(!draw().some((line) => line.includes('Claude accounts') || line.includes('c@example.com')));
  assert.ok(draw().some((line) => line.includes('Codex accounts (1)')));
  toggleShown(config, 'section:codex'); toggleShown(config, 'section:grok');
  assert.ok(draw().some((line) => line.includes('press v to show one')));
  // Toggling again shows it, and the stored list keeps only what is hidden.
  assert.equal(toggleShown(config, 'section:claude'), true);
  assert.deepEqual(config.display?.hidden, ['section:codex', 'section:grok']);
});

test('display settings: hidden gauges and columns drop out of titles and rows', () => {
  const config = { ...defaultConfig(), accounts: [account('claude', 'c@example.com')] };
  const state = usage({ 'c@example.com': 0.3 });
  state.accounts['cred-c@example.com']!.windows!['7d'] = { usage: 0.4, resetsAt: null };
  const draw = () => buildFrame(config, state, { width: 120, selectedId: null, mode: 'normal', message: '', sortByHeadroom: true }).map(plain);
  const title = () => draw().find((line) => line.trimStart().startsWith('account '))!;
  const row = () => draw().find((line) => line.includes('c@example.com'))!;
  assert.match(title(), /plan.*state.*order.*7d overall.*7d Fable/);
  assert.match(row(), /40%.*30%/);
  for (const key of ['gauge:7d', 'col:plan', 'col:order', 'col:renewal', 'col:age'] as const) toggleShown(config, key);
  assert.ok(!title().includes('7d overall') && !title().includes('plan') && !title().includes('order'));
  assert.match(title(), /state.*7d Fable/);
  assert.ok(!row().includes('40%') && row().includes('30%'));
  assert.ok(!row().includes('~') && !row().includes('unmeasured'));
});

test('display settings: activity can be hidden and the v menu lists every item', () => {
  const config = { ...defaultConfig(), accounts: [account('claude', 'c@example.com')] };
  const state: PersistedState = { ...usage({ 'c@example.com': 0.1 }), events: [{ at: Date.now(), message: 'POST /v1/messages' }] };
  const draw = (mode: 'normal' | 'view', viewCursor = 0) => buildFrame(config, state, { width: 120, selectedId: null, mode, message: '', sortByHeadroom: true, viewCursor }).map(plain);
  assert.ok(draw('normal').some((line) => line.includes('POST /v1/messages')));
  assert.match(draw('normal').at(-1)!, /v view/);
  toggleShown(config, 'activity');
  assert.ok(!draw('normal').some((line) => line.includes('Activity') || line.includes('POST /v1/messages')));
  const menu = draw('view', DISPLAY_ITEMS.findIndex((item) => item.key === 'gauge:5h'));
  assert.equal(menu.filter((line) => /\[[x ]\]/.test(line)).length, DISPLAY_ITEMS.length);
  assert.ok(menu.some((line) => line.startsWith('> [x]') && line.includes('Claude 5h session')));
  assert.ok(menu.some((line) => line.includes('[ ]') && line.includes('Activity log')));
  assert.match(menu.at(-1)!, /VIEW:/);
});

test('display settings: on a short terminal the v menu keeps its cursor and footer in view', () => {
  const config = { ...defaultConfig(), accounts: Array.from({ length: 12 }, (_, i) => account('claude', `c${i}@example.com`)) };
  const state = usage({});
  for (const cursor of [0, 7, DISPLAY_ITEMS.length - 1]) {
    const lines = buildFrame(config, state, { width: 100, height: 24, selectedId: null, mode: 'view', message: '', sortByHeadroom: true, viewCursor: cursor }).map(plain);
    assert.equal(lines.length, 24);
    assert.match(lines.at(-1)!, /VIEW:/);
    assert.ok(lines.some((line) => line.startsWith('> ') && line.includes(DISPLAY_ITEMS[cursor]!.label)), `cursor ${cursor} visible`);
  }
});

test('Grok section: weekly gauge, header counts and ports, and its show/hide items', () => {
  const config = { ...defaultConfig(), accounts: [account('claude', 'c@example.com'), { ...account('codex', 'x@example.com'), provider: 'grok' as const, label: 'g@example.com', credentialId: 'cred-g@example.com' }] };
  const state = usage({ 'c@example.com': 0.3 });
  state.accounts['cred-g@example.com'] = { usage: 0.94, resetsAt: null, cooldownUntil: null, lastUsed: null, error: null, windows: { weekly: { usage: 0.94, resetsAt: Date.now() + 3 * 86_400_000, minutes: 10080 } } };
  const draw = (width = 120) => buildFrame(config, state, { width, selectedId: null, mode: 'normal', message: '', sortByHeadroom: true }).map(plain);
  const lines = draw();
  assert.match(lines[0]!, /Claude 1 {2}Codex 0 {2}Grok 1 {2}127\.0\.0\.1:3456\/3457\/3458/);
  assert.ok(lines.some((line) => line.includes('Grok accounts (1)')));
  assert.ok(lines.some((line) => line.trimStart().startsWith('account ') && line.includes('1w limit')));
  assert.match(lines.find((line) => line.includes('g@example.com'))!, /—.*active.*94% 3d/);
  toggleShown(config, 'gauge:grok');
  assert.ok(!draw().find((line) => line.includes('g@example.com'))!.includes('94%'));
  // Narrow terminals drop the least-needed key hints, never quit or the launch keys.
  const footer = draw(80).at(-1)!.trimEnd();
  assert.match(footer, /1 Claude {2}2 Codex {2}3 Grok/); assert.match(footer, /q quit$/); assert.ok(!footer.includes('…'));
  assert.match(draw(120).at(-1)!, /3 Grok.*p\/P capture.*v view.*q quit/);
});

test('a token server that did not answer reads as retrying; a refused token as error', () => {
  const config: TeamAIConfig = { ...defaultConfig(), accounts: [account('claude', 'net@x.com'), account('claude', 'dead@x.com'), account('claude', 'old@x.com')] };
  const state = usage({ 'net@x.com': 0.5, 'dead@x.com': 0.5, 'old@x.com': 0.5 });
  Object.assign(state.accounts['cred-net@x.com']!, { error: 'token refresh unreachable (ETIMEDOUT); retrying', errorKind: 'unreachable' });
  Object.assign(state.accounts['cred-dead@x.com']!, { error: 'token refresh failed: OAuth refresh failed (400)', errorKind: 'refused' });
  // Written before errorKind existed: read from the message.
  Object.assign(state.accounts['cred-old@x.com']!, { error: 'token refresh unreachable (ECONNRESET); retrying' });
  const lines = buildFrame(config, state, { width: 140, selectedId: null, mode: 'normal', message: '', sortByHeadroom: false });
  const row = (label: string): string => lines.find((line) => plain(line).includes(label))!;
  assert.match(plain(row('net@x.com')), /retrying/);
  assert.match(plain(row('dead@x.com')), / error /);
  assert.match(plain(row('old@x.com')), /retrying/);
  assert.equal(refreshErrorKind({ error: null }), null);
  assert.equal(refreshErrorKind({ error: 'Claude profile failed (401)' }), 'refused');
});
