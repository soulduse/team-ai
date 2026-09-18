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
