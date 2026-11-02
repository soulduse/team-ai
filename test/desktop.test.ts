import assert from 'node:assert/strict';
import test from 'node:test';
import { browserCommand, clipboardCommands, copyImageToClipboard, openInBrowser, revealCommand, revealInFolder } from '../src/desktop.js';

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

test('the browser opener never puts the URL through a shell', () => {
  const url = 'https://claude.ai/oauth/authorize?code=true&state=x';
  assert.deepEqual(browserCommand('win32', url), { file: 'rundll32', args: ['url.dll,FileProtocolHandler', url] });
  assert.deepEqual(browserCommand('darwin', url), { file: 'open', args: [url] });
  assert.deepEqual(browserCommand('linux', url), { file: 'xdg-open', args: [url] });
});

test('a missing browser opener does not crash the process', async (t) => {
  // An empty PATH makes the opener missing on every OS, so no real browser opens.
  const path = process.env.PATH; t.after(() => { process.env.PATH = path; });
  process.env.PATH = '';
  openInBrowser('https://example.invalid/', 'linux');
  // An unhandled 'error' event would throw before this tick ends.
  await new Promise((resolve) => setTimeout(resolve, 200));
});
