import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { cellWidth, stripAnsi, usageLayout } from '../src/columns.js';
import { buildFrame, displayOrder, frozenOrder, navigationOrder } from '../src/frame.js';
import { groupStatusLines } from '../src/groups.js';
import { groupSectionFixture, sectionFrame } from './group-sections-fixture.js';

for (const width of [140, 46]) {
  test(`no-group dashboard snapshot stays unchanged at ${width} columns`, () => {
    const expected = readFileSync(new URL(`./snapshots/group-sections-none-${width}.txt`, import.meta.url), 'utf8');
    assert.equal(sectionFrame(false, width).join('\n') + '\n', expected);
    const { config, state } = groupSectionFixture(false);
    config.groups = {};
    assert.equal(buildFrame(config, state, { width, selectedId: 'credential-b', mode: 'normal', message: '', sortByHeadroom: false }).map(stripAnsi).map((line) => line.trimEnd()).join('\n') + '\n', expected);
  });

  test(`grouped dashboard snapshot at ${width} columns`, () => {
    const expected = readFileSync(new URL(`./snapshots/group-sections-grouped-${width}.txt`, import.meta.url), 'utf8');
    assert.equal(sectionFrame(true, width).join('\n') + '\n', expected);
  });

  test(`Claude sections contain summaries and overlapping accounts at ${width} columns`, () => {
    const frame = sectionFrame(true, width);
    const master = frame.findIndex((line) => line.includes('master · 2/2 ready · headroom 1.25'));
    const worker = frame.findIndex((line) => line.includes('worker · 1/2 ready · headroom 0.50'));
    const ungrouped = frame.findIndex((line) => line.includes('그룹 없음'));
    const codex = frame.findIndex((line) => line.includes('Codex'));
    assert.ok(master >= 0 && master < worker && worker < ungrouped && ungrouped < codex);
    assert.equal(frame.filter((line) => line.includes('↔ bravo')).length, 2);
    assert.equal(frame.filter((line) => line.includes('↔ bravo') && line.startsWith('>')).length, 2);
    assert.match(frame.slice(master + 1, worker).join('\n'), /bravo[\s\S]*alpha/);
    assert.match(frame.slice(worker + 1, ungrouped).join('\n'), /charlie[\s\S]*bravo/);
    assert.equal(frame.filter((line) => line.includes('미지정')).length, 1);
    assert.doesNotMatch(frame.slice(codex).join('\n'), /headroom|Group master|Group worker/);
  });
}

test('group headings and wide account gauges share the existing column grid', () => {
  const lines = sectionFrame(true, 140);
  const rows = lines.filter((line) => /alpha|bravo|charlie|미지정/.test(line));
  const layout = usageLayout(140, 0, [10]);
  for (const row of rows) {
    for (const slot of layout.slots.slice(0, 2)) assert.match(fitCell(row, slot, layout.gauge), /^ +(?:10|25|50|100)% +$/);
  }
});

test('grouped rows fit narrow widths and long names with wide characters', () => {
  const { config, state } = groupSectionFixture();
  config.groups = { ['long-group-'.repeat(5)]: ['a', 'b'], worker: ['b', 'c'] };
  config.accounts.find((account) => account.id === 'b')!.label = '공유계정'.repeat(10);
  for (const width of [20, 32, 46, 60, 79, 80, 100, 140]) {
    const lines = buildFrame(config, state, { width, selectedId: 'credential-b', mode: 'normal', message: '', sortByHeadroom: false });
    assert.ok(lines.every((line) => cellWidth(line) === width), String(width));
    assert.equal(lines.filter((line) => stripAnsi(line).includes('↔')).length, 2, String(width));
    assert.doesNotMatch(lines.join('\n'), /Group long-group/);
  }
});

test('short grouped frames retain the selected account and its section', () => {
  for (const height of [4, 5, 6, 7, 8, 12, 20]) {
    const lines = sectionFrame(true, 46, { height });
    assert.equal(lines.length, height);
    assert.ok(lines.some((line) => line.startsWith('>') && line.includes('↔ bravo')));
    const headings = lines.map((line, index) => /master ·|worker ·|그룹 없음/.test(line) ? index : -1).filter((index) => index >= 0);
    for (const index of headings) assert.ok(lines[index + 1] && /alpha|bravo|charlie|미지정/.test(lines[index + 1]!), lines.join('\n'));
    assert.ok(headings.length > 0);
    assert.ok(lines.some((line) => line.includes('alpha')));
    assert.ok(lines.some((line) => line.includes('codex')));
  }
});

test('shared selection and frozen priorities stay attached to the same account in every section', () => {
  const { config, state } = groupSectionFixture();
  const frozen = displayOrder(config.accounts, state, false).map((account) => account.credentialId);
  config.accounts.find((account) => account.id === 'b')!.priority = 1;
  for (const width of [46, 140]) {
    const lines = buildFrame(config, state, { width, selectedId: 'credential-b', mode: 'order', message: '', sortByHeadroom: true, frozen }).map(stripAnsi);
    const shared = lines.filter((line) => line.includes('↔ bravo'));
    assert.equal(shared.length, 2);
    assert.ok(shared.every((line) => line.startsWith('>')));
    if (width === 140) assert.ok(shared.every((line) => line.includes('#1')));
    assert.ok(lines.findIndex((line) => line.includes('↔ bravo')) < lines.findIndex((line) => line.includes('alpha')));
  }
});

function fitCell(row: string, start: number, width: number): string {
  // The account label may contain wide characters, so measure terminal cells.
  let position = 0; let out = '';
  for (const char of row) {
    if (position >= start && position < start + width) out += char;
    position += cellWidth(char);
  }
  return out;
}

test('navigation walks first visible account occurrences and skips shared copies', () => {
  const { config, state } = groupSectionFixture();
  const ordered = displayOrder(config.accounts, state, false);
  assert.deepEqual(navigationOrder(config, ordered).map((account) => account.id), ['b', 'a', 'c', 'u', 'x']);
  assert.deepEqual(ordered.map((account) => account.id), ['c', 'b', 'a', 'u', 'x']);
  const frozen = ordered.map((account) => account.credentialId);
  config.accounts.find((account) => account.id === 'a')!.priority = 0;
  assert.deepEqual(navigationOrder(config, frozenOrder(config.accounts, frozen)).map((account) => account.id), ['b', 'a', 'c', 'u', 'x']);
  const live = displayOrder(config.accounts, state, true);
  assert.deepEqual(navigationOrder(config, live).slice(0, 2).map((account) => account.id), ['a', 'b']);
});

test('no-group navigation preserves the existing provider and sorting order', () => {
  const { config, state } = groupSectionFixture(false);
  for (const sorted of [false, true]) {
    const ordered = displayOrder(config.accounts, state, sorted);
    assert.deepEqual(navigationOrder(config, ordered), ordered);
  }
});

test('CLI group status stays unchanged and section summaries retain unknown readings', () => {
  const { config, state } = groupSectionFixture();
  delete state.accounts['credential-a'];
  assert.deepEqual(groupStatusLines(config, state), [
    'Group master: 2/2 ready, headroom 0.50 accounts + 1 unknown — alpha ?, bravo 50%',
    'Group worker: 1/2 ready, headroom 0.50 accounts — bravo 50%, charlie 0% unavailable',
  ]);
  const lines = buildFrame(config, state, { width: 140, selectedId: null, mode: 'normal', message: '', sortByHeadroom: false }).map(stripAnsi);
  assert.equal(lines.filter((line) => line.includes('master · 2/2 ready · headroom 0.50 + 1 unknown')).length, 1);
  assert.doesNotMatch(lines.join('\n'), /Group master:/);
});

test('no ungrouped section is drawn when every Claude account has a group', () => {
  const { config, state } = groupSectionFixture();
  config.groups!.worker!.push('u');
  for (const width of [46, 140]) {
    const lines = buildFrame(config, state, { width, selectedId: null, mode: 'normal', message: '', sortByHeadroom: false }).map(stripAnsi);
    assert.doesNotMatch(lines.join('\n'), /그룹 없음/);
    assert.equal(lines.filter((line) => line.includes('미지정')).length, 1);
  }
});
