// A dashboard frame as a PNG, with nothing but Node's zlib behind it. The
// glyphs come from the bitmap in font.ts; the colors follow the SGR codes the
// frame already carries, so the image is the terminal rendering, not a
// re-drawing of the data.
import { deflateSync, inflateSync } from 'node:zlib';
import { charWidth } from './columns.js';
import { NARROW_BITMAP, NARROW_GLYPHS, UNIFONT_HEIGHT, WIDE_BITMAP, WIDE_GLYPHS } from './font-cjk.js';
import { BITMAP, CELL_HEIGHT, CELL_WIDTH, GLYPHS } from './font.js';

// CRC-32 as PNG specifies it (reflected, polynomial 0xEDB88320). zlib.crc32
// would do the same, but it only exists from Node 22.2 and the engine floor
// is 20, so the table is built here.
let table: Uint32Array | null = null;
export function crc32(data: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = table[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

// 8-bit RGB, no interlace, filter type 0 on every scanline.
export function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
  if (rgb.length !== width * height * 3) throw new Error('pixel buffer does not match dimensions');
  const stride = width * 3; const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) { raw[y * (stride + 1)] = 0; raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1); }
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2; header[10] = 0; header[11] = 0; header[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

type Rgb = readonly [number, number, number];

// The palette of a dark terminal, kept close to what the dashboard is usually
// looked at in so a capture reads the same as the live screen.
export const BACKGROUND: Rgb = [30, 32, 38];
const FOREGROUND: Rgb = [208, 212, 220];
const PALETTE: Record<number, Rgb> = {
  30: [60, 64, 72], 31: [206, 106, 106], 32: [176, 185, 96], 33: [214, 184, 106], 34: [108, 150, 200], 35: [190, 120, 190], 36: [108, 190, 185], 37: [208, 212, 220],
  90: [128, 134, 146], 91: [230, 130, 130], 92: [196, 206, 120], 93: [232, 204, 130], 94: [140, 180, 230], 95: [210, 150, 210], 96: [140, 215, 210], 97: [236, 238, 242],
};

interface Cell { glyph: string; fg: Rgb; bg: Rgb | null }

const SGR = new RegExp(`${String.fromCharCode(27)}\\[([0-9;]*)m`, 'g');

// Walk one line's SGR runs into per-column cells. Only the codes the frame
// actually emits are interpreted; anything else is ignored rather than
// guessed at.
function parseLine(line: string): Cell[] {
  const cells: Cell[] = []; let fg: Rgb = FOREGROUND; let bg: Rgb | null = null; let bold = false; let last = 0;
  // A wide character takes two cells, as on the terminal: its glyph in the
  // first and an empty continuation (painted with the same background) in the
  // second, so columns after it line up with the text frame. Zero-width ones
  // take none.
  const emit = (text: string): void => {
    for (const glyph of text) {
      const width = charWidth(glyph); if (!width) continue;
      const cell = { fg: bold && fg === FOREGROUND ? PALETTE[97]! : fg, bg };
      cells.push({ glyph, ...cell }); if (width === 2) cells.push({ glyph: '', ...cell });
    }
  };
  for (const match of line.matchAll(SGR)) {
    emit(line.slice(last, match.index)); last = match.index + match[0].length;
    for (const code of (match[1] || '0').split(';').map(Number)) {
      if (code === 0) { fg = FOREGROUND; bg = null; bold = false; }
      else if (code === 1) bold = true;
      else if (code === 39) fg = FOREGROUND;
      else if (code === 49) bg = null;
      else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) fg = PALETTE[code] ?? FOREGROUND;
      else if (code >= 40 && code <= 47) bg = PALETTE[code - 10] ?? null;
      else if (code >= 100 && code <= 107) bg = code === 100 ? [90, 94, 102] : PALETTE[code - 60] ?? null;
    }
  }
  emit(line.slice(last));
  return cells;
}

const bitmap = Buffer.from(BITMAP, 'base64');
const glyphIndex = new Map<string, number>(); for (const [index, glyph] of [...GLYPHS].entries()) glyphIndex.set(glyph, index);

// The Menlo set covers ASCII and the frame's own symbols. Everything else —
// Hangul, kana, kanji, fullwidth forms, the wider symbol blocks — comes from
// the Unifont set in src/font-cjk.ts, inflated once on first need: 8x16 for a
// one-cell character, 16x16 for a two-cell one, centred in its cells.
interface Unifont { rows: Buffer; index: Map<string, number> }
let unifont: { narrow: Unifont; wide: Unifont } | undefined;
const load = (glyphs: string, data: string): Unifont => {
  const index = new Map<string, number>(); for (const [i, glyph] of [...glyphs].entries()) index.set(glyph, i);
  return { rows: inflateSync(Buffer.from(data, 'base64')), index };
};
const unifontSet = (): { narrow: Unifont; wide: Unifont } => (unifont ??= { narrow: load(NARROW_GLYPHS, NARROW_BITMAP), wide: load(WIDE_GLYPHS, WIDE_BITMAP) });

// Where a character's pixels come from, or null when only the fallback box
// can be drawn. A two-cell character takes a wide glyph (or a narrow one
// centred); a one-cell character never takes a wide glyph that would spill
// into its neighbour.
export function glyphSource(glyph: string): 'menlo' | 'unifont' | null {
  if (glyphIndex.has(glyph)) return 'menlo';
  const set = unifontSet();
  if (set.narrow.index.has(glyph) || (charWidth(glyph) === 2 && set.wide.index.has(glyph))) return 'unifont';
  return null;
}

export function renderFrame(lines: string[], padding = 12): Buffer {
  const rows = lines.map(parseLine); const cols = Math.max(1, ...rows.map((row) => row.length));
  const width = cols * CELL_WIDTH + padding * 2; const height = rows.length * CELL_HEIGHT + padding * 2;
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) rgb.set(BACKGROUND, i * 3);
  const put = (x: number, y: number, c: Rgb): void => { rgb.set(c, (y * width + x) * 3); };
  rows.forEach((row, r) => row.forEach((cell, c) => {
    const x0 = padding + c * CELL_WIDTH; const y0 = padding + r * CELL_HEIGHT;
    if (cell.bg) for (let y = 0; y < CELL_HEIGHT; y++) for (let x = 0; x < CELL_WIDTH; x++) put(x0 + x, y0 + y, cell.bg);
    const index = glyphIndex.get(cell.glyph);
    if (index === undefined && glyphSource(cell.glyph) === 'unifont') {
      const set = unifontSet(); const span = charWidth(cell.glyph) * CELL_WIDTH;
      const wide = span > CELL_WIDTH && set.wide.index.has(cell.glyph); const font = wide ? set.wide : set.narrow;
      const at = font.index.get(cell.glyph)!; const dx = Math.floor((span - (wide ? 16 : 8)) / 2); const dy = Math.floor((CELL_HEIGHT - UNIFONT_HEIGHT) / 2);
      for (let y = 0; y < UNIFONT_HEIGHT; y++) {
        const bits = font.rows.readUInt16BE((at * UNIFONT_HEIGHT + y) * 2);
        for (let x = 0; x < 16; x++) if (bits & (1 << (15 - x))) put(x0 + dx + x, y0 + dy + y, cell.fg);
      }
      return;
    }
    if (index === undefined) {
      // A glyph the bitmap does not carry: draw a hollow box so the gap is
      // visible in the image rather than silently blank.
      if (cell.glyph.trim()) for (let y = 3; y < CELL_HEIGHT - 3; y++) for (let x = 1; x < CELL_WIDTH - 1; x++) if (y === 3 || y === CELL_HEIGHT - 4 || x === 1 || x === CELL_WIDTH - 2) put(x0 + x, y0 + y, cell.fg);
      return;
    }
    for (let y = 0; y < CELL_HEIGHT; y++) {
      const bits = bitmap.readUInt16BE((index * CELL_HEIGHT + y) * 2);
      for (let x = 0; x < CELL_WIDTH; x++) if (bits & (1 << (15 - x))) put(x0 + x, y0 + y, cell.fg);
    }
  }));
  return encodePng(width, height, rgb);
}
