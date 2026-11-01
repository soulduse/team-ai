import assert from 'node:assert/strict';
import test from 'node:test';
import { crc32, encodePng, renderFrame } from '../src/png.js';

test('crc32 matches the published check values', () => {
  assert.equal(crc32(Buffer.alloc(0)), 0);
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.from('abc')), 0x352441c2);
});

test('encodePng writes a well-formed file with the requested dimensions', () => {
  const png = encodePng(2, 1, new Uint8Array([255, 0, 0, 0, 0, 255]));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.subarray(12, 16).toString('latin1'), 'IHDR');
  assert.equal(png.readUInt32BE(16), 2);
  assert.equal(png.readUInt32BE(20), 1);
  assert.equal(png.subarray(png.length - 8, png.length - 4).toString('latin1'), 'IEND');
  assert.throws(() => encodePng(2, 2, new Uint8Array(3)), /does not match/);
});

test('renderFrame paints SGR backgrounds and draws every glyph the frame uses', () => {
  // A gauge run (red bg, bright fg) followed by plain text and box drawing.
  const png = renderFrame(['\x1b[41;97m 100% \x1b[0m ok ┌─┐ ● ↑↓ … → •'], 0);
  assert.deepEqual([...png.subarray(0, 4)], [137, 80, 78, 71]);
  // 9px cells, 18px tall, one row: width = cells * 9.
  const cells = [...' 100%  ok ┌─┐ ● ↑↓ … → •'].length;
  assert.equal(png.readUInt32BE(16), cells * 9);
  assert.equal(png.readUInt32BE(20), 18);
});

// Korean, Japanese and the symbols around the frame used to fall back to a
// hollow box. Each sample character must now have real pixels.
const ASCII_SHA256 = 'bc269e778bfcd4b056b7d096b388224698863ffa9e616c587afabd121f48bae0'; // pre-change main
const CJK_SAMPLES = '한국어 계정 사용량 ㄱㅎㅏ ひらがな カタカナ ｶﾀｶﾅ 日本語 漢字 使用量 「」、。！？ ・ «»×–›←≤≥ ♥ ＡＢ';

test('glyphSource covers Hangul, kana, kanji and the frame symbols (no fallback box)', async () => {
  const { glyphSource } = await import('../src/png.js');
  const missing = [...CJK_SAMPLES].filter((ch) => ch !== ' ' && glyphSource(ch) === null);
  assert.deepEqual(missing, []);
  // ASCII stays on the original Menlo bitmap.
  for (const ch of 'Aa0%─●') assert.equal(glyphSource(ch), 'menlo');
});

test('renderFrame keeps two-cell width for East Asian text, aligned with the text frame', async () => {
  const { cellWidth } = await import('../src/columns.js');
  const lines = ['한국어|日本語|ab', 'abcdef|ghijkl|ab'];
  assert.equal(cellWidth(lines[0]!), cellWidth(lines[1]!));
  const png = renderFrame(lines, 0);
  assert.equal(png.readUInt32BE(16), cellWidth(lines[1]!) * 9);
});

test('renderFrame draws CJK glyphs with pixels and leaves ASCII output unchanged', async () => {
  const { inflateSync } = await import('node:zlib');
  const pixels = (png: Buffer): Buffer => {
    const idat = png.subarray(41, 41 + png.readUInt32BE(33));
    return inflateSync(idat);
  };
  // A box-drawn character and a real glyph must differ; two distinct Hangul
  // syllables must not render identically (as two boxes would).
  assert.notDeepEqual(pixels(renderFrame(['가'], 0)), pixels(renderFrame(['나'], 0)));
  assert.notDeepEqual(pixels(renderFrame(['あ'], 0)), pixels(renderFrame(['い'], 0)));
  assert.notDeepEqual(pixels(renderFrame(['≤'], 0)), pixels(renderFrame(['≥'], 0)));
  // ASCII pixels are pinned to the pre-change Menlo bitmap.
  const ascii = pixels(renderFrame(['\x1b[41;97m 100% \x1b[0m ok ┌─┐ ● ↑↓ … → •'], 0));
  const { createHash } = await import('node:crypto');
  assert.equal(createHash('sha256').update(ascii).digest('hex'), ASCII_SHA256);
});
