// What happens to a capture after it is saved: reveal it in the file manager
// and put the image on the clipboard, using whatever the desktop provides.
// Both are best effort — a headless box has neither — and report whether they
// worked so the caller can say so rather than claim a copy that did not happen.
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { dirname } from 'node:path';

export interface Command { file: string; args: string[]; stdinFrom?: string }

// Open the file manager with the capture selected, or at least at its folder.
export function revealCommand(platform: NodeJS.Platform, file: string): Command | null {
  if (platform === 'darwin') return { file: 'open', args: ['-R', file] };
  if (platform === 'linux') return { file: 'xdg-open', args: [dirname(file)] };
  return null;
}

// Candidates in order of preference; the first one that runs wins. macOS reads
// the PNG straight into the pasteboard; Linux depends on which clipboard tool
// the session has (Wayland first, then X11).
export function clipboardCommands(platform: NodeJS.Platform, file: string): Command[] {
  if (platform === 'darwin') return [{ file: 'osascript', args: ['-e', `set the clipboard to (read (POSIX file ${JSON.stringify(file)}) as «class PNGf»)`] }];
  if (platform === 'linux') return [{ file: 'wl-copy', args: ['--type', 'image/png'], stdinFrom: file }, { file: 'xclip', args: ['-selection', 'clipboard', '-t', 'image/png', '-i', file] }];
  return [];
}

function run(command: Command, timeoutMs = 5_000): Promise<boolean> {
  return new Promise((resolve) => {
    const child = execFile(command.file, command.args, { timeout: timeoutMs }, (error) => resolve(!error));
    if (command.stdinFrom && child.stdin) {
      // A tool that is not installed still hands back a stdin; writing to it
      // then raises EPIPE, which must not escape as an uncaught error.
      child.stdin.on('error', () => resolve(false));
      createReadStream(command.stdinFrom).on('error', () => resolve(false)).pipe(child.stdin);
    }
  });
}

export async function revealInFolder(file: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  const command = revealCommand(platform, file);
  return command ? run(command) : false;
}

export async function copyImageToClipboard(file: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  for (const command of clipboardCommands(platform, file)) if (await run(command)) return true;
  return false;
}
