// Save the dashboard as it stands to a pair of files: the frame as text with
// its colors intact, and the same frame as a PNG. Works without a terminal —
// it reads config and state the way the TUI does and draws through the same
// frame builder — so a script can take a capture as easily as a keypress can.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildFrame, displayOrder, type FrameMode } from './frame.js';
import { renderFrame } from './png.js';
import { redactSnapshot, redactor, type RedactLevel } from './redact.js';
import { dataDir, loadConfig, loadState } from './storage.js';

export interface CaptureOptions {
  level: RedactLevel;
  width?: number;
  outDir?: string;
  // The live view's state, when the capture is taken from inside the TUI, so
  // the image shows the same cursor, mode and footer message as the screen.
  selectedId?: string | null;
  mode?: FrameMode;
  message?: string;
  sortByHeadroom?: boolean;
}

export interface CaptureResult { text: string; png: string }

function stamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export async function captureDashboard(options: CaptureOptions): Promise<CaptureResult> {
  const rawConfig = await loadConfig(); const rawState = await loadState();
  const { config, state } = redactSnapshot(rawConfig, rawState, options.level);
  const sortByHeadroom = options.sortByHeadroom ?? true;
  const width = Math.max(80, options.width ?? 120);
  const selectedId = options.selectedId ?? displayOrder(config.accounts, state, sortByHeadroom)[0]?.credentialId ?? null;
  // The footer message may name an account ("Added …"), so it goes through
  // the same mask as everything else.
  const message = redactor(rawConfig.accounts, options.level)(options.message ?? '');
  const lines = buildFrame(config, state, { width, selectedId, mode: options.mode ?? 'normal', message, sortByHeadroom });
  const dir = options.outDir ?? join(dataDir(), 'captures');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const name = `teamai-${stamp(new Date())}`; const body = `${lines.join('\n')}\n`; const image = renderFrame(lines);
  // Two captures inside one second must not overwrite each other, so the text
  // file is created exclusively and the name gets a suffix on collision.
  for (let n = 0; ; n++) {
    const base = join(dir, n ? `${name}-${n}` : name); const text = `${base}.txt`; const png = `${base}.png`;
    try { await writeFile(text, body, { mode: 0o600, flag: 'wx' }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue; throw error; }
    await writeFile(png, image, { mode: 0o600 });
    return { text, png };
  }
}
