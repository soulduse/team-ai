import assert from 'node:assert/strict';
import test from 'node:test';
import { cellWidth, stripAnsi } from '../src/columns.js';
import { buildFrame, isNarrow, type FrameView } from '../src/frame.js';
import { openRouteEditor } from '../src/route-editor.js';
import { config, state } from './narrow-fixture.js';

// The dashboard on a phone: the same terminal seen 40–60 columns wide. Every
// frame here is drawn from synthetic data (narrow-fixture.ts).
const WIDTHS = [40, 46, 60, 80, 120, 160];
const view = (width: number, extra: Partial<FrameView> = {}): FrameView => ({ width, selectedId: 'cred-alice.long.address@example.com', mode: 'normal', message: '', sortByHeadroom: true, ...extra });
const frame = (width: number, extra: Partial<FrameView> = {}): string[] => buildFrame(config, state, view(width, extra));
const plain = (lines: string[]): string[] => lines.map(stripAnsi);
const line = (lines: string[], needle: string): string => { const found = plain(lines).find((text) => text.includes(needle)); assert.ok(found, `no line with ${needle}:\n${plain(lines).join('\n')}`); return found; };

test('no line is wider than the terminal, in any mode, at any width or height', () => {
  const modes: Array<Partial<FrameView>> = [
    {}, { mode: 'help' }, { mode: 'order' }, { mode: 'delete' }, { mode: 'add' }, { message: 'Captured teamai-20261017-163400.png — copied to clipboard, opened folder' },
    { mode: 'credits', credits: { account: 'carol@example.com', phase: 'pick', index: 0, items: [{ title: '한 번 쓰는 리셋 크레딧 (보상)', grantedAt: Date.now(), expiresAt: Date.now() + 86_400_000 }] } },
    { mode: 'routes', routes: openRouteEditor(config, 'claude') },
  ];
  for (const width of WIDTHS) {
    for (const height of [undefined, 6, 12, 24, 40]) {
      for (const mode of modes) {
        const lines = frame(width, { height, ...mode });
        for (const text of lines) assert.ok(cellWidth(text) <= width, `width ${width} height ${height} ${mode.mode ?? 'normal'}: ${cellWidth(text)} columns: ${JSON.stringify(stripAnsi(text))}`);
        if (height !== undefined) assert.equal(lines.length, height, `width ${width}: exactly the terminal's ${height} rows`);
      }
    }
  }
});

test('the narrow layout starts below the width the wide grid needs', () => {
  assert.equal(isNarrow(79), true); assert.equal(isNarrow(80), false);
  // A route marker column makes the wide grid one column wider.
  assert.equal(isNarrow(80, 3), true); assert.equal(isNarrow(81, 3), false);
  assert.ok(plain(frame(80)).some((text) => text.includes('Claude accounts (3)')), 'wide boxes at 80');
  assert.ok(!plain(frame(79)).some((text) => text.includes('┌─ Claude accounts')), 'no wide boxes at 79');
});

test('the narrow layout gives every provider its current account and its 5h and 7d figures on one line', () => {
  for (const width of [40, 46, 60]) {
    const lines = frame(width, { height: 30 });
    // Claude: the window names are on the section rule; alice is where the
    // next request goes and is selected. The row itself only carries figures.
    assert.match(line(lines, '─ Claude'), /5h +7d +F +reset/, `width ${width}: Claude's column names once`);
    const alice = line(lines, 'alice');
    assert.match(alice, /^>►/, `width ${width}: cursor and ► on the current account`);
    assert.match(alice, /62% +84% +35%/);
    assert.match(alice, /3d/, `width ${width}: when the most-spent window resets`);
    // Codex: d1fp9a is current and has only a weekly window.
    assert.match(line(lines, '─ Codex'), /5h +7d +reset/, `width ${width}: Codex's column names once`);
    const current = line(lines, 'd1fp9a@');
    assert.match(current, /^ ►/); assert.match(current, /10%/);
    assert.match(line(lines, 'carol@'), /30% +75%/);
    // The other agents share one rule and the same aligned cells.
    assert.match(line(lines, '─ Other'), /5h +7d +30d +reset/, `width ${width}: other agents' column names once`);
    assert.match(line(lines, 'Gemini'), /20% +55%/);
    assert.match(line(lines, 'Grok'), /25%/);
    assert.match(line(lines, 'OpenCode'), /5% +33% +71%/);
    // No account or group row repeats a window name beside its figure.
    const rows = plain(lines).filter((text) => /alice|김철수|off@|carol@|d1fp9a|Gemini|OpenCode|Grok/.test(text) && !text.startsWith('─'));
    for (const row of rows) assert.doesNotMatch(row, /\b(?:5h|7d|30d|F)\b/, `width ${width}: no repeated window name: ${row}`);
  }
});

test('narrow rows put every provider\'s figures in the same columns', () => {
  for (const width of [40, 46, 60]) {
    const lines = frame(width, { height: 30 });
    const at = (needle: string, figure: string): number => { const text = line(lines, needle); return cellWidth(text.slice(0, text.indexOf(figure) + figure.length)); };
    const weekly = [at('alice', '84%'), at('carol@', '75%'), at('Gemini', '55%'), at('Grok', '25%')];
    assert.equal(new Set(weekly).size, 1, `width ${width}: weekly % signs in one column: ${weekly}`);
    // Third windows with names of different length: Claude's F, OpenCode's 30d.
    assert.equal(at('alice', '35%'), at('OpenCode', '71%'), `width ${width}: third-window % signs in one column`);
  }
});

test('each section names its windows once, and only there', () => {
  for (const width of [40, 48, 56, 64, 72]) {
    const lines = plain(frame(width, { height: 40 }));
    const named = lines.filter((text) => /\b(?:5h|7d|30d|F)\b/.test(text));
    assert.equal(named.length, 3, `width ${width}: one rule per section carries the names, no row does:\n${lines.join('\n')}`);
    for (const text of named) assert.match(text, /^─ /, `width ${width}: a window name outside a section rule: ${text}`);
    assert.match(lines.find((text) => text.startsWith('─ Claude'))!, /5h +7d +F/);
    assert.match(lines.find((text) => text.startsWith('─ Codex'))!, /5h +7d/);
    assert.match(lines.find((text) => text.startsWith('─ Other'))!, /5h +7d +30d/);
  }
});

test('an activity entry is one line: time, session, provider, status, account', () => {
  for (const width of [40, 46, 60]) {
    const lines = plain(frame(width, { height: 30 }));
    const start = lines.findIndex((text) => text.startsWith('─ Activity'));
    assert.ok(start > 0);
    const log = lines.slice(start + 1).filter((text) => text.trim() && !text.includes('? help'));
    assert.equal(log.length, 5, `width ${width}: one line per entry (1 in flight + 4 logged):\n${log.join('\n')}`);
    assert.match(log[0]!, /^.\d\d:\d\d ac88d9 C +\d+s alice/, 'in flight: spinner, time, session, provider, seconds so far, account');
    assert.match(log[1]!, /^ \d\d:\d\d ac88d9 C 200 alice/);
    assert.match(log[2]!, /^ \d\d:\d\d b71c02 X 200 d1fp/);
    assert.match(log[4]!, /^ \d\d:\d\d b71c02 X 429 carol/);
    assert.ok(log.every((text) => !text.includes('/v1/')), 'no request path');
  }
});

test('the activity log shortens an address that does not fit to its local part, and leaves a fitting one whole', () => {
  const event = (account: string) => ({ at: Date.now() - 60_000, message: '', request: {
    provider: 'claude' as const, providerLabel: 'Claude', method: 'POST', path: '/v1/messages',
    account, status: 200, durationMs: 4200, sessionId: 'ac88d9e1',
  } });
  // Time, session and status take 20 columns before the account at these
  // widths: 49 leaves room for the 18-column local part but not the 30-column
  // address, 50 fits the whole address exactly. The unfitted local part keeps
  // the account name instead of cutting the address at the terminal edge.
  const draw = (account: string, width: number): string => plain(buildFrame(config, { ...state, active: [], events: [event(account)] }, view(width))).find((text) => text.includes('ac88d9'))!;
  assert.match(draw('alice.long.address@example.com', 49), /ac88d9 C 200 alice\.long\.address\s*$/);
  assert.doesNotMatch(draw('alice.long.address@example.com', 49), /@/);
  assert.match(draw('alice.long.address@example.com', 50), /ac88d9 C 200 alice\.long\.address@example\.com\s*$/);
  // No address to shorten: the label is drawn as it is.
  assert.match(draw('plainaccount', 49), /ac88d9 C 200 plainaccount\s*$/);
});

test('the activity log takes the rows that are left', () => {
  const count = (lines: string[]): number => lines.filter((text) => /^.\d\d:\d\d /.test(text)).length;
  assert.equal(count(plain(frame(46, { height: 24 }))), 5, 'all five entries in 24 rows');
  const short = count(plain(frame(46, { height: 14 })));
  assert.ok(short < 5 && short >= 1, `a 14-row terminal keeps some activity: ${short}`);
});

test('a very short terminal still shows each provider\'s current account and its figures', () => {
  for (const width of [40, 46]) {
    for (const height of [4, 6, 8]) {
      const lines = frame(width, { height });
      // The section rule outlives the rows, so the figures keep their names.
      assert.match(line(lines, '─ Claude'), /5h +7d +F/, `${width}x${height}: Claude names`);
      assert.match(line(lines, '─ Codex'), /5h +7d/, `${width}x${height}: Codex names`);
      assert.match(line(lines, 'alice'), /62% +84%/, `${width}x${height}`);
      assert.match(line(lines, 'd1fp9a@'), /10%/, `${width}x${height}`);
    }
    for (let height = 4; height <= 30; height++) {
      const lines = plain(frame(width, { height })); const title = lines.findIndex((text) => text.startsWith('─ Activity'));
      if (title >= 0) assert.match(lines[title + 1]!, /^.\d\d:\d\d /, `${width}x${height}: the Activity rule has a line under it`);
    }
  }
});

test('the narrow footer is one line of the keys that fit, the rest behind ?', () => {
  for (const width of [40, 46, 60]) {
    const lines = plain(frame(width, { height: 30 })); const footer = lines.at(-1)!;
    assert.match(footer, /↑↓ sel/); assert.match(footer, /\? help/);
    if (width >= 46) assert.match(footer, /q quit/, `width ${width}: the compact hints leave room for quit`);
    assert.ok(cellWidth(footer) <= width);
    const help = plain(frame(width, { height: 30, mode: 'help' })).join('\n');
    for (const key of ['s switch', 'e enable', 'o order', 'd delete', 'a add', 'p capture', 'R Reload', 'c quota-sort', 'g routes', 'q quit']) assert.ok(help.includes(key), `width ${width}: ? lists ${key}`);
  }
  // 't' is offered only with a Codex row selected, in the list too.
  assert.ok(plain(frame(46, { mode: 'help', selectedId: 'cred-carol@example.com' })).join('\n').includes('t credits'));
});

test('a mode footer too long for the line keeps every hint on screen above it', () => {
  const lines = plain(frame(46, { height: 30, mode: 'routes', routes: openRouteEditor(config, 'claude') }));
  const all = lines.join('\n');
  for (const hint of ['a add', 'e/Enter edit', 'd delete', 'Tab Claude/Codex', 'Esc close']) assert.ok(all.includes(hint), `route editor hint ${hint}`);
});

test('overflow hints yield to the footer when the narrow terminal has no spare row', () => {
  const lines = plain(frame(40, { height: 12, mode: 'routes', routes: openRouteEditor(config, 'claude') }));
  assert.match(lines.at(-1)!, /^ ROUTES:/);
  assert.ok(!lines.slice(0, -1).some((line) => line.includes('Esc close') || line.includes('Tab Claude/Codex')));
});

test('the other-agents rule is omitted when height trimming removes every group', () => {
  const lines = plain(frame(60, { height: 13 }));
  assert.ok(!lines.some((line) => line.includes('Other agents')));
});

test('the narrow help box has side borders on every content row', () => {
  const lines = plain(frame(60, { height: 12, mode: 'help' }));
  const top = lines.findIndex((line) => line.startsWith('┌─ Keys '));
  assert.ok(top >= 0);
  const bottom = lines.findIndex((line, index) => index > top && line.startsWith('└'));
  assert.ok(bottom > top);
  for (const line of lines.slice(top + 1, bottom)) assert.match(line, /^│.*│$/);
});

test('a footer message gets its own line in the narrow layout', () => {
  const lines = plain(frame(46, { height: 20, message: 'Sorted by remaining quota' }));
  assert.equal(lines.at(-2)!.trim(), 'Sorted by remaining quota');
  assert.match(lines.at(-1)!, /↑↓ sel/);
});

test('the wide layout keeps its footer when the terminal is shorter than the frame', () => {
  const lines = frame(120, { height: 12 });
  assert.equal(lines.length, 12);
  assert.match(lines.at(-1)!, /q quit|g route/);
});
