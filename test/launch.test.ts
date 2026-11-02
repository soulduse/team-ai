import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { launchCommand } from '../src/launch.js';

function binDir(...files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'teamai-launch-'));
  for (const file of files) writeFileSync(join(dir, file), '');
  return dir;
}

test('macOS and Linux spawn the command by name', () => {
  assert.deepEqual(launchCommand('codex', ['-c', 'a="b"'], 'darwin'), { file: 'codex', args: ['-c', 'a="b"'] });
  assert.deepEqual(launchCommand('claude', [], 'linux'), { file: 'claude', args: [] });
});

test('Windows runs an .exe on PATH directly', (t) => {
  const dir = binDir('claude.exe'); t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(launchCommand('claude', ['--resume'], 'win32', { PATH: dir }), { file: join(dir, 'claude.exe'), args: ['--resume'] });
});

test('Windows runs an npm .cmd shim through cmd.exe with escaped arguments', (t) => {
  // The extensionless sh shim npm also writes is not runnable on Windows and is skipped.
  const dir = binDir('codex', 'codex.cmd'); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const launch = launchCommand('codex', ['-c', 'name="TeamAI Relay"', 'fix a & b'], 'win32', { PATH: dir, ComSpec: 'C:\\Windows\\cmd.exe' });
  assert.equal(launch.file, 'C:\\Windows\\cmd.exe');
  assert.equal(launch.windowsVerbatimArguments, true);
  assert.deepEqual(launch.args.slice(0, 3), ['/d', '/s', '/c']);
  const line = launch.args[3]!;
  assert.ok(line.includes('codex.cmd'));
  // Every cmd.exe metacharacter in an argument is caret-escaped (twice, for the shim's own %*).
  assert.ok(line.includes('^^^&'));
  assert.ok(!/[^^]&/.test(line));
  assert.ok(line.includes('name=\\^^^"TeamAI^^^ Relay\\^^^"'));
});

test('Windows falls back to the bare name when nothing is on PATH', () => {
  assert.deepEqual(launchCommand('codex', ['login'], 'win32', { PATH: '' }), { file: 'codex', args: ['login'] });
});
