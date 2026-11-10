import assert from 'node:assert/strict';
import test from 'node:test';
import { cellWidth, stripAnsi } from '../src/columns.js';
import { buildFrame, type FrameMode } from '../src/frame.js';
import type { PersistedState } from '../src/types.js';
import { config, now, state } from './narrow-fixture.js';

// A week is written "7d" everywhere on the dashboard: column titles, the
// other agents' gauges, the narrow summary and the help overlay. No other
// spelling of it may reach the screen.
const WIDTHS = [40, 60, 80, 120];
const OTHER_SPELLINGS = /wk|1w|week|overall/i;

// The stored external labels stay as they were ('wk'); a reading saved
// without a length ('wk', or Orca's 'weekly') is still drawn as "7d".
const legacy = {
  ...state,
  external: {
    ...state.external,
    grok: { provider: 'grok', status: 'ok', identity: null, measuredAt: now, lastOkAt: now, note: null, groups: [{ name: 'Grok', windows: [{ label: 'wk', minutes: null, usedPercent: 25, resetsAt: null }] }] },
    opencodeGo: { provider: 'opencodeGo', status: 'ok', identity: null, measuredAt: now, lastOkAt: now, note: null, groups: [{ name: 'OpenCode Go', windows: [{ label: 'weekly', minutes: null, usedPercent: 33, resetsAt: null }] }] },
  },
} as unknown as PersistedState;

const frame = (data: PersistedState, width: number, mode: FrameMode = 'normal', selectedId = 'cred-alice.long.address@example.com'): string[] =>
  buildFrame(config, data, { width, height: 40, selectedId, mode, message: '', sortByHeadroom: false }).map(stripAnsi);

test('no other spelling of a week is left in the frame at 40, 60, 80 and 120 columns', () => {
  for (const width of WIDTHS) {
    for (const data of [state, legacy]) {
      for (const [mode, selected] of [['normal', undefined], ['help', undefined], ['normal', 'cred-carol@example.com']] as const) {
        const lines = frame(data, width, mode, selected);
        for (const line of lines) assert.doesNotMatch(line, OTHER_SPELLINGS, `width ${width} ${mode}: ${JSON.stringify(line)}`);
        assert.ok(lines.every((line) => cellWidth(line) <= width), `width ${width} ${mode}: no line wider than the terminal`);
        assert.ok(lines.some((line) => /\b7d\b/.test(line)), `width ${width} ${mode}: the week is shown as 7d`);
      }
    }
  }
});

test('a week stored without a length is titled 7d in the wide boxes and the narrow section rules', () => {
  const wide = frame(legacy, 120);
  const header = (title: string): string => wide[wide.findIndex((line) => line.includes(`─ ${title}`)) + 1]!;
  assert.match(header('Grok'), /\b7d\b/); assert.match(header('OpenCode Go'), /\b7d\b/);
  const narrow = frame(legacy, 60);
  const rule = narrow.find((line) => line.startsWith('─ Other agents'))!;
  assert.match(rule, /\b7d\b/);
  assert.match(narrow.find((line) => line.includes('Grok'))!, /25%/);
  assert.match(narrow.find((line) => line.includes('OpenCode'))!, /33%/);
});

test('the shorter titles keep the wide columns and the narrow figures aligned', () => {
  for (const width of [80, 120]) {
    const lines = frame(state, width);
    // Claude's and Codex's 7d titles start in the same column, as do their 5h ones.
    const titles = ['Claude accounts', 'Codex accounts'].map((box) => lines[lines.findIndex((line) => line.includes(box)) + 1]!);
    assert.equal(titles.length, 2, `width ${width}: one title row per account box`);
    const at = (line: string, needle: string): number => cellWidth(line.slice(0, line.indexOf(needle)));
    assert.equal(at(titles[0]!, ' 7d'), at(titles[1]!, ' 7d'), `width ${width}: 7d titles line up`);
    assert.equal(at(titles[0]!, '5h'), at(titles[1]!, '5h'), `width ${width}: 5h titles line up`);
  }
  for (const width of [40, 60]) {
    const lines = frame(state, width);
    const column = (needle: string, figure: string): number => {
      const text = lines.find((line) => line.includes(needle))!; const at = text.indexOf(figure);
      assert.ok(at >= 0, `width ${width}: ${needle} shows ${figure}`);
      return cellWidth(text.slice(0, at + figure.length));
    };
    // alice (Claude 7d), carol (Codex 7d) and Gemini (Antigravity 7d) share the second cell.
    assert.equal(column('alice', '84%'), column('carol@', '75%'), `width ${width}`);
    assert.equal(column('alice', '84%'), column('Gemini', '55%'), `width ${width}`);
  }
});
