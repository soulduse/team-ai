import assert from 'node:assert/strict';
import test from 'node:test';
import { clipboardCommands, copyImageToClipboard, revealCommand, revealInFolder } from '../src/desktop.js';

test('macOS reveals the file itself and reads the PNG into the pasteboard', () => {
  assert.deepEqual(revealCommand('darwin', '/tmp/cap/shot.png'), { file: 'open', args: ['-R', '/tmp/cap/shot.png'] });
  const [copy] = clipboardCommands('darwin', '/tmp/cap/it\'s "here".png');
  assert.equal(copy?.file, 'osascript');
  // The path is quoted for AppleScript so quotes in a folder name cannot break out.
  assert.match(copy?.args[1] ?? '', /POSIX file "\/tmp\/cap\/it's \\"here\\"\.png"/);
});

test('Linux opens the folder and tries Wayland before X11', () => {
  assert.deepEqual(revealCommand('linux', '/home/u/cap/shot.png'), { file: 'xdg-open', args: ['/home/u/cap'] });
  const commands = clipboardCommands('linux', '/home/u/cap/shot.png');
  assert.deepEqual(commands.map((c) => c.file), ['wl-copy', 'xclip']);
  assert.equal(commands[0]?.stdinFrom, '/home/u/cap/shot.png');
});

test('an unsupported platform does nothing and says so', async () => {
  assert.equal(revealCommand('win32', 'x.png'), null);
  assert.deepEqual(clipboardCommands('win32', 'x.png'), []);
  assert.equal(await revealInFolder('x.png', 'win32'), false);
  assert.equal(await copyImageToClipboard('x.png', 'win32'), false);
});

test('a missing tool reports failure instead of throwing', async () => {
  assert.equal(await copyImageToClipboard('/nonexistent.png', 'linux'), false);
});
